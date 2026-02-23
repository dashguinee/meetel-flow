import { createClient } from "@supabase/supabase-js";
import { DictationResult } from "./types";

const SUPABASE_URL = "https://mclbbkmpovnvcfmwsoqt.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbGJia21wb3ZudmNmbXdzb3F0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjgxMzYzNDAsImV4cCI6MjA4MzcxMjM0MH0.F52U5I7L4CYpIIR3IR9Khq0HVDJ1OeMSAtoRza8Dad0";

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
