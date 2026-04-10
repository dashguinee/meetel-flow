-- ============================================================
-- Meetel Flow — Telemetry Schema
-- Project: mclbbkmpovnvcfmwsoqt
-- Tables: meetel_users, meetel_events
-- View:   meetel_user_metrics
-- ============================================================
-- Idempotent: safe to run multiple times. Uses CREATE ... IF NOT EXISTS
-- and CREATE OR REPLACE throughout.
--
-- Assumes the pgcrypto extension is available (Supabase ships with it).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meetel_users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT UNIQUE,
  name                 TEXT,
  device_id            TEXT UNIQUE,
  platform             TEXT,
  app_version          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_dictation_at   TIMESTAMPTZ,
  total_dictations     INTEGER NOT NULL DEFAULT 0,
  total_words          INTEGER NOT NULL DEFAULT 0,
  plan                 TEXT    NOT NULL DEFAULT 'free',
  status               TEXT    NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_meetel_users_email
  ON meetel_users(email);
CREATE INDEX IF NOT EXISTS idx_meetel_users_device
  ON meetel_users(device_id);
CREATE INDEX IF NOT EXISTS idx_meetel_users_last_active
  ON meetel_users(last_active_at DESC);

-- ── Events ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meetel_events (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID REFERENCES meetel_users(id) ON DELETE SET NULL,
  event        TEXT NOT NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  platform     TEXT,
  app_version  TEXT
);

CREATE INDEX IF NOT EXISTS idx_meetel_events_user_created
  ON meetel_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetel_events_event_created
  ON meetel_events(event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetel_events_created
  ON meetel_events(created_at DESC);

-- ── Row Level Security ─────────────────────────────────────
ALTER TABLE meetel_users  ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetel_events ENABLE ROW LEVEL SECURITY;

-- Drop-if-exists pattern so the script stays idempotent.
DROP POLICY IF EXISTS meetel_users_service_all       ON meetel_users;
DROP POLICY IF EXISTS meetel_users_auth_read         ON meetel_users;
DROP POLICY IF EXISTS meetel_users_anon_upsert       ON meetel_users;

DROP POLICY IF EXISTS meetel_events_service_insert   ON meetel_events;
DROP POLICY IF EXISTS meetel_events_service_select   ON meetel_events;
DROP POLICY IF EXISTS meetel_events_auth_read        ON meetel_events;
DROP POLICY IF EXISTS meetel_events_anon_insert      ON meetel_events;

-- Service role bypasses RLS by default, but we make it explicit for clarity
-- and so that future role changes don't silently break writes.
CREATE POLICY meetel_users_service_all
  ON meetel_users
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY meetel_users_auth_read
  ON meetel_users
  FOR SELECT
  TO authenticated
  USING (true);

-- Anon clients (the desktop app, using the anon key) need to be able to
-- upsert their own row so `identifyUser()` works without a server round-trip.
CREATE POLICY meetel_users_anon_upsert
  ON meetel_users
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- Events: service role can insert (preferred path from a backend relay).
CREATE POLICY meetel_events_service_insert
  ON meetel_events
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY meetel_events_service_select
  ON meetel_events
  FOR SELECT
  TO service_role
  USING (true);

-- Authenticated clients can read telemetry (for dashboards).
CREATE POLICY meetel_events_auth_read
  ON meetel_events
  FOR SELECT
  TO authenticated
  USING (true);

-- Desktop app writes events using the anon key — allow insert only.
CREATE POLICY meetel_events_anon_insert
  ON meetel_events
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- ── User metrics view ───────────────────────────────────────
CREATE OR REPLACE VIEW meetel_user_metrics AS
WITH dictation_stats AS (
  SELECT
    user_id,
    COUNT(*) FILTER (WHERE event = 'dictation_success')                                AS dictation_success_count,
    COUNT(*) FILTER (WHERE event IN ('dictation_success','dictation_failure'))         AS dictation_total_count,
    COALESCE(SUM( (payload->>'word_count')::INTEGER )
             FILTER (WHERE event = 'dictation_success'), 0)                            AS total_words,
    COALESCE(AVG( (payload->>'duration_ms')::NUMERIC )
             FILTER (WHERE event = 'dictation_success'), 0)                            AS avg_dictation_duration_ms,
    COUNT(*) FILTER (
      WHERE event = 'dictation_success'
        AND created_at >= now() - interval '7 days'
    )                                                                                  AS last_7_days_dictations
  FROM meetel_events
  WHERE user_id IS NOT NULL
  GROUP BY user_id
),
provider_rank AS (
  SELECT
    user_id,
    payload->>'provider' AS provider,
    COUNT(*)             AS hits,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY COUNT(*) DESC
    ) AS rn
  FROM meetel_events
  WHERE event = 'dictation_success'
    AND payload ? 'provider'
    AND user_id IS NOT NULL
  GROUP BY user_id, payload->>'provider'
),
language_rank AS (
  SELECT
    user_id,
    payload->>'language' AS language,
    COUNT(*)             AS hits,
    ROW_NUMBER() OVER (
      PARTITION BY user_id
      ORDER BY COUNT(*) DESC
    ) AS rn
  FROM meetel_events
  WHERE event = 'dictation_success'
    AND payload ? 'language'
    AND user_id IS NOT NULL
  GROUP BY user_id, payload->>'language'
)
SELECT
  u.id                                   AS user_id,
  u.email,
  u.name,
  u.plan,
  u.status,
  COALESCE(s.dictation_success_count, 0) AS total_dictations,
  COALESCE(s.total_words, 0)             AS total_words,
  COALESCE(s.avg_dictation_duration_ms, 0) AS avg_dictation_duration_ms,
  CASE
    WHEN COALESCE(s.dictation_total_count, 0) = 0 THEN 0
    ELSE ROUND(
      (s.dictation_success_count::NUMERIC / s.dictation_total_count::NUMERIC) * 100,
      2
    )
  END                                    AS success_rate,
  COALESCE(s.last_7_days_dictations, 0)  AS last_7_days_dictations,
  p.provider                             AS dominant_provider,
  l.language                             AS dominant_language,
  u.created_at,
  u.last_active_at,
  u.first_dictation_at
FROM meetel_users u
LEFT JOIN dictation_stats s ON s.user_id = u.id
LEFT JOIN provider_rank   p ON p.user_id = u.id AND p.rn = 1
LEFT JOIN language_rank   l ON l.user_id = u.id AND l.rn = 1;

-- Grant read on the view for anyone who can read the underlying tables.
GRANT SELECT ON meetel_user_metrics TO authenticated, service_role;

-- ── Verify ──────────────────────────────────────────────────
SELECT 'Meetel Flow telemetry schema ready.' AS status;
