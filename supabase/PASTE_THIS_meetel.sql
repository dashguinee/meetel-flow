-- ============================================================
-- Meetel tables for Hub Supabase (mclbbkmpovnvcfmwsoqt)
-- Tables prefixed mt_ to avoid collision
-- Paste in Supabase SQL Editor and run
-- ============================================================

-- ── Users ──
CREATE TABLE IF NOT EXISTS mt_users (
  id TEXT PRIMARY KEY DEFAULT 'MU-' || substr(md5(random()::text), 1, 8),
  email TEXT UNIQUE,
  name TEXT,
  citizen_id TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  minutes_limit INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE mt_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mt_users_read_own" ON mt_users FOR SELECT USING (true);

-- ── Transcripts ──
CREATE TABLE IF NOT EXISTS mt_transcripts (
  id TEXT PRIMARY KEY DEFAULT 'MT-' || substr(md5(random()::text), 1, 8),
  user_id TEXT REFERENCES mt_users(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  duration_seconds NUMERIC(8,2) DEFAULT 0,
  language TEXT DEFAULT 'auto',
  provider TEXT DEFAULT 'groq',
  device_id TEXT,
  hall_id TEXT,
  meeting_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mt_transcripts_user ON mt_transcripts(user_id);
CREATE INDEX IF NOT EXISTS idx_mt_transcripts_created ON mt_transcripts(created_at DESC);

ALTER TABLE mt_transcripts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mt_transcripts_public_insert" ON mt_transcripts FOR INSERT WITH CHECK (true);
CREATE POLICY "mt_transcripts_read_own" ON mt_transcripts FOR SELECT USING (true);

-- ── Usage tracking ──
CREATE TABLE IF NOT EXISTS mt_usage (
  id SERIAL PRIMARY KEY,
  user_id TEXT REFERENCES mt_users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  minutes_used NUMERIC(8,2) NOT NULL DEFAULT 0,
  UNIQUE(user_id, month)
);

ALTER TABLE mt_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mt_usage_all" ON mt_usage FOR ALL USING (true);

-- ============================================================
-- RPC: Log transcript + update usage atomically
-- ============================================================
CREATE OR REPLACE FUNCTION log_mt_transcript(
  p_user_id TEXT DEFAULT NULL,
  p_text TEXT DEFAULT '',
  p_duration NUMERIC DEFAULT 0,
  p_language TEXT DEFAULT 'auto',
  p_provider TEXT DEFAULT 'groq'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_transcript mt_transcripts%ROWTYPE;
  current_month TEXT;
BEGIN
  current_month := to_char(now(), 'YYYY-MM');

  -- Insert transcript
  INSERT INTO mt_transcripts (user_id, text, duration_seconds, language, provider)
  VALUES (p_user_id, p_text, p_duration, p_language, p_provider)
  RETURNING * INTO new_transcript;

  -- Update usage if user provided
  IF p_user_id IS NOT NULL THEN
    INSERT INTO mt_usage (user_id, month, minutes_used)
    VALUES (p_user_id, current_month, p_duration / 60.0)
    ON CONFLICT (user_id, month)
    DO UPDATE SET minutes_used = mt_usage.minutes_used + (p_duration / 60.0);
  END IF;

  RETURN row_to_json(new_transcript);
END;
$$;

-- ============================================================
-- RPC: Get usage for current month
-- ============================================================
CREATE OR REPLACE FUNCTION get_mt_usage(p_user_id TEXT, p_month TEXT DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  current_month TEXT;
  usage_record mt_usage%ROWTYPE;
  user_record mt_users%ROWTYPE;
BEGIN
  current_month := COALESCE(p_month, to_char(now(), 'YYYY-MM'));

  SELECT * INTO user_record FROM mt_users WHERE id = p_user_id;
  SELECT * INTO usage_record FROM mt_usage WHERE user_id = p_user_id AND month = current_month;

  RETURN json_build_object(
    'minutesUsed', COALESCE(usage_record.minutes_used, 0),
    'limit', COALESCE(user_record.minutes_limit, 100),
    'month', current_month,
    'plan', COALESCE(user_record.plan, 'free')
  );
END;
$$;

-- ============================================================
-- RPC: Get recent transcripts
-- ============================================================
CREATE OR REPLACE FUNCTION get_mt_transcripts(p_user_id TEXT, p_limit INTEGER DEFAULT 50)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
    FROM (
      SELECT * FROM mt_transcripts
      WHERE user_id = p_user_id
      ORDER BY created_at DESC
      LIMIT p_limit
    ) t
  );
END;
$$;

-- ── Verify ──
SELECT 'Meetel tables created. Ready for Meetel Flow.' AS status;
