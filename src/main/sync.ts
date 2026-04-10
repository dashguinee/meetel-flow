/**
 * sync.ts — Cloud transcript sync.
 *
 * Fire-and-forget insert into the `meetel_transcripts` table after every
 * successful dictation. Failures are logged but never bubble up to the
 * caller — cloud sync hiccups must not block the dictation pipeline.
 *
 * Schema lives in supabase/meetel-schema.sql. The trigger
 * `trg_meetel_transcripts_first_dictation` stamps `first_dictation_at` on
 * the user row the first time we land here.
 */

import { createClient } from "@supabase/supabase-js";
import { DictationResult } from "./types";

const SUPABASE_URL = "https://mclbbkmpovnvcfmwsoqt.supabase.co";
// Publishable (anon) key — safe to embed in the client. Service role key must
// never live in the desktop app: decompiling the installer would expose it.
const SUPABASE_ANON_KEY = "sb_publishable_9L0m_MUyzJsh9gDXZod6MQ_r0UJBWiu";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const APP_VERSION: string = (() => {
  try {
    return (require("../../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

const countWords = (text: string): number =>
  text.trim().split(/\s+/).filter(Boolean).length;

export const pushTranscript = (result: DictationResult, userId?: string): void => {
  // Local-only mode — no userId means the user hasn't onboarded yet, skip.
  if (!userId) return;

  // Fire and forget — non-blocking. Wrapped in an async IIFE so the public
  // signature stays `void` and existing call sites don't need awaits.
  void (async () => {
    try {
      const { error } = await supabase.from("meetel_transcripts").insert({
        user_id: userId,
        text: result.text,
        word_count: countWords(result.text),
        duration_ms: result.latencyMs,
        duration_seconds: result.durationSeconds,
        language: result.detectedLang ?? null,
        provider: result.provider,
        platform: process.platform,
        app_version: APP_VERSION,
      });
      if (error) {
        // eslint-disable-next-line no-console
        console.error(`[sync] pushTranscript error: ${error.message} (code=${error.code ?? "?"})`);
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`[sync] pushTranscript ok (${countWords(result.text)} words, ${result.provider})`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[sync] pushTranscript threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
};
