import { createClient } from "@supabase/supabase-js";
import { DictationResult } from "./types";

const SUPABASE_URL = "https://mclbbkmpovnvcfmwsoqt.supabase.co";
// Publishable (anon) key — safe to embed in the client. Service role key must
// never live in the desktop app: decompiling the installer would expose it.
const SUPABASE_ANON_KEY = "sb_publishable_9L0m_MUyzJsh9gDXZod6MQ_r0UJBWiu";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const pushTranscript = (result: DictationResult, userId?: string): void => {
  // Local-only mode — no userId, skip sync
  if (!userId) {
    return;
  }

  // Fire and forget — non-blocking
  Promise.resolve(
    supabase.rpc("log_mt_transcript", {
      p_user_id: userId,
      p_text: result.text,
      p_duration: result.durationSeconds,
      p_language: "auto",
      p_provider: result.provider
    })
  )
    .then(({ error }) => {
      if (error) {
        console.error("Sync pushTranscript error:", error.message);
      }
    })
    .catch((err: unknown) => {
      console.error("Sync pushTranscript network error:", err);
    });
};
