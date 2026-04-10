/**
 * Audio Quality Filter Module for Meetel Flow
 *
 * Whisper (Groq, whisper.cpp, and other variants) is notorious for
 * hallucinating phrases on silent, noisy, or music-only input. These
 * hallucinations come from training data leakage — Whisper was trained on
 * millions of hours of YouTube/podcast audio, and the endings of those
 * clips frequently contain the same boilerplate phrases ("thanks for
 * watching", "please subscribe", broadcaster credits, subtitle attributions,
 * etc.). When given silence or noise, Whisper will frequently emit these
 * phrases verbatim because the model weights have memorised them as
 * high-probability outputs in uncertainty.
 *
 * This module provides pure, side-effect-free predicates and an
 * orchestrator that any caller (e.g. `stt.ts`) can use to reject a
 * transcription result before it ever reaches the renderer / cursor.
 *
 * Design goals:
 *  - Zero external dependencies (Node built-ins only)
 *  - Pure functions (no I/O, no global state, no mutation of inputs)
 *  - TypeScript strict mode friendly
 *  - Trivially unit-testable
 *  - Conservative defaults (prefer false negatives over rejecting real speech)
 *
 * Usage:
 *   import { filterTranscriptionResult } from "./filters";
 *
 *   const verdict = filterTranscriptionResult({
 *     text: whisperResult.text,
 *     language: whisperResult.detectedLang,
 *     durationMs: durationSeconds * 1000,
 *     audioBuffer: pcm16Buffer, // optional
 *   });
 *
 *   if (!verdict.ok) {
 *     // emit dictation_failure telemetry, return "No voice detected" to UI
 *     return;
 *   }
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type FilterReason =
  | "hallucination"
  | "too_quiet"
  | "too_short"
  | "empty_text";

export interface FilterResult {
  ok: boolean;
  reason?: FilterReason;
  /** Optional human-readable detail (useful for telemetry error_message). */
  detail?: string;
}

export interface FilterInput {
  text: string;
  language?: string;
  durationMs: number;
  /**
   * Raw audio buffer. Assumed to be PCM16 little-endian by default
   * (signed 16-bit interleaved samples). If a WAV header is detected
   * (ASCII "RIFF" at offset 0 and "WAVE" at offset 8), the first 44 bytes
   * are skipped automatically before RMS is computed. WebM / Ogg / MP3
   * containers are NOT decoded here — pass decoded PCM or omit this field.
   */
  audioBuffer?: Buffer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hallucination phrase dictionary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Known Whisper hallucination phrases, keyed by ISO 639-1 language code.
 * The "all" bucket contains language-agnostic patterns (short filler words,
 * single-token "merci/thanks/gracias" outputs).
 *
 * Each entry includes an inline comment describing the origin so future
 * maintainers understand why it's listed. Sources:
 *  - OpenAI Whisper GitHub issues #928, #1268, #1783 (community-reported)
 *  - Hugging Face community dataset of observed hallucinations
 *  - Meetel Flow field reports (SESSION_2026-02-24.md)
 *  - Reddit /r/MachineLearning threads on Whisper artifacts
 *
 * Storage format: lowercased, trimmed, punctuation-stripped — matching is
 * done against a normalised version of the transcription text, so variants
 * like "Merci." / "merci !" / " Merci " all collapse to the same key.
 */
export const HALLUCINATION_PHRASES: Record<string, string[]> = {
  // ── Language-agnostic / single-token noise ─────────────────────────────
  all: [
    "you",            // English single-word hallucination on silence
    "thank you",      // extremely common on silence end-of-clip
    "thanks",         // clip ending memorised
    "bye",            // clip ending
    "bye bye",        // clip ending
    ".",              // punctuation-only output (Whisper uncertainty)
    "...",            // ellipsis-only hallucination
    "[music]",        // legacy bracket artifact
    "[applause]",     // legacy bracket artifact
    "[silence]",      // legacy bracket artifact
    "(music)",        // parenthesised artifact
    "(silence)",      // parenthesised artifact
    "♪",              // music symbol hallucination
    "♫",              // music symbol hallucination
  ],

  // ── French (fr) ────────────────────────────────────────────────────────
  // Observed heavily on Groq Whisper large-v3 when user gives silent input.
  // "Sous-titrage de la Société Radio-Canada" is the single most infamous —
  // Whisper was trained on CBC/Radio-Canada subtitles which end every clip
  // with this credit, so the model emits it on any French-language silence.
  fr: [
    "sous-titrage de la société radio-canada",      // CBC subtitle credit (#1 offender)
    "sous-titrage société radio-canada",             // variation
    "sous-titres réalisés par la communauté d'amara.org", // Amara volunteer credit
    "sous-titres réalisés para la communauté d'amara.org", // mis-spaced variant
    "sous-titres réalisés par l'amara.org",          // short variant
    "sous-titrage st' 501",                          // French subtitling studio credit
    "sous-titrage ft. st' 501",                      // variant
    "merci",                                          // #2 French offender — single-token
    "merci d'avoir regardé",                         // "thanks for watching" FR
    "merci d'avoir regardé cette vidéo",             // full form
    "merci d'avoir regardé la vidéo",                // variant
    "merci à tous",                                  // viewer appreciation
    "merci beaucoup",                                // viewer appreciation
    "abonnez-vous",                                  // "subscribe" CTA
    "n'oubliez pas de vous abonner",                 // "don't forget to subscribe"
    "n'hésitez pas à vous abonner",                  // variant
    "n'oubliez pas de liker et de vous abonner",     // full CTA
    "à la prochaine",                                // "see you next time" outro
    "à bientôt",                                     // "see you soon" outro
    "au revoir",                                     // farewell
    "bonne journée",                                 // "have a good day"
  ],

  // ── English (en) ───────────────────────────────────────────────────────
  // YouTube-ending boilerplate that Whisper learned by heart.
  en: [
    "thanks for watching",                           // #1 English offender
    "thanks for watching!",                          // punctuation variant
    "thank you for watching",                        // formal variant
    "thank you for watching this video",             // long form
    "thanks for watching and see you next time",     // combined outro
    "please subscribe",                              // CTA
    "please like and subscribe",                     // CTA combo
    "like and subscribe",                            // short CTA
    "don't forget to subscribe",                     // CTA
    "don't forget to like and subscribe",            // CTA combo
    "hit the like button",                           // CTA
    "smash that like button",                        // informal CTA
    "see you in the next video",                     // outro
    "see you next time",                             // outro
    "subtitles by the amara.org community",          // Amara volunteer credit
    "subtitles by the amaraorg community",           // de-punctuated variant
    "transcription by esoinsight.com",               // transcription service credit
    "transcription by castingwords",                 // transcription service credit
    "subtitles by",                                  // prefix catcher
    "captions by",                                   // prefix catcher
    "[music playing]",                               // closed-caption artifact
    "[instrumental music]",                          // CC artifact
    "[no audio]",                                    // CC artifact
    "[silent]",                                      // CC artifact
  ],

  // ── Spanish (es) ───────────────────────────────────────────────────────
  es: [
    "gracias por ver el video",                      // "thanks for watching"
    "gracias por ver este video",                    // variant
    "gracias por ver",                                // short form
    "suscríbete al canal",                           // "subscribe to the channel"
    "suscríbete",                                    // short CTA
    "dale like",                                      // "hit like"
    "no olvides suscribirte",                        // "don't forget to subscribe"
    "subtítulos realizados por la comunidad de amara.org", // Amara credit
    "hasta la próxima",                              // "see you next time"
    "nos vemos",                                     // "see you"
    "gracias",                                       // single-token hallucination
  ],

  // ── German (de) ────────────────────────────────────────────────────────
  de: [
    "vielen dank fürs zuschauen",                    // "thanks for watching"
    "danke fürs zuschauen",                          // short form
    "danke für eure aufmerksamkeit",                 // "thanks for your attention"
    "abonniert den kanal",                           // "subscribe to the channel"
    "vergesst nicht zu abonnieren",                  // "don't forget to subscribe"
    "untertitelung des zdf für funk, 2017",          // ZDF broadcaster credit
    "untertitel im auftrag des zdf",                 // ZDF subtitle credit
    "untertitel von stephanie geiges",               // specific subtitler credit
    "untertitel der amara.org-community",            // Amara credit
    "bis zum nächsten mal",                          // "until next time"
    "auf wiedersehen",                                // farewell
    "danke",                                          // single-token
  ],

  // ── Italian (it) ───────────────────────────────────────────────────────
  it: [
    "grazie per aver guardato il video",             // "thanks for watching"
    "grazie per aver guardato",                      // short form
    "sottotitoli creati dalla comunità amara.org",   // Amara credit
    "sottotitoli e revisione a cura di qtss",        // QTSS credit
    "iscrivetevi al canale",                         // "subscribe"
    "alla prossima",                                 // "see you next time"
    "ciao a tutti",                                   // "hi everyone" (outro)
    "grazie",                                          // single-token
  ],

  // ── Portuguese (pt) ────────────────────────────────────────────────────
  pt: [
    "obrigado por assistir",                         // "thanks for watching" (BR)
    "obrigada por assistir",                         // feminine
    "obrigado por assistirem",                       // plural
    "legendas pela comunidade amara.org",            // Amara credit
    "se inscreva no canal",                          // "subscribe"
    "não esqueça de se inscrever",                   // "don't forget to subscribe"
    "até a próxima",                                  // "until next time"
    "até mais",                                       // "see you"
    "obrigado",                                       // single-token
  ],

  // ── Japanese (ja) ──────────────────────────────────────────────────────
  // Whisper hallucinates Japanese YouTuber outros and anime subtitle credits.
  ja: [
    "ご視聴ありがとうございました",                  // "thanks for watching" (formal)
    "ご視聴ありがとうございます",                    // variant
    "チャンネル登録お願いします",                    // "please subscribe"
    "チャンネル登録よろしくお願いします",            // polite variant
    "高評価お願いします",                            // "please like"
    "いいねとチャンネル登録お願いします",            // like+subscribe CTA
    "また次の動画でお会いしましょう",                // "see you in the next video"
    "また次回",                                       // "until next time"
    "おやすみなさい",                                 // "good night" outro
    "ありがとうございました",                        // "thank you" (formal outro)
    "ありがとう",                                     // single-token
    "字幕by",                                          // subtitle credit prefix
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Text normalisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise a string for hallucination comparison:
 *  - lowercase
 *  - trim
 *  - collapse whitespace
 *  - strip trailing/leading punctuation
 *  - remove most ASCII punctuation (keeps letters, digits, accented chars, CJK)
 *
 * Pure function — does not mutate input.
 */
export const normaliseForMatch = (input: string): string => {
  if (!input) return "";
  return input
    .toLowerCase()
    .normalize("NFC")
    // Strip ASCII punctuation except apostrophes/hyphens inside words
    .replace(/[.,!?;:"“”„‚‹›«»()\[\]{}…•·_/\\]/g, " ")
    // Collapse internal whitespace
    .replace(/\s+/g, " ")
    .trim();
};

// ─────────────────────────────────────────────────────────────────────────────
// Hallucination detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether `text` matches any known Whisper hallucination pattern
 * for the given `language`. If `language` is omitted or unknown, all
 * language buckets are scanned.
 *
 * Matching rules:
 *  1. Exact match against normalised phrase (full transcription == phrase)
 *  2. Substring containment (phrase appears inside short transcription)
 *
 * Substring containment only triggers when the transcription is short
 * (<= 2x the phrase length) to avoid false positives on real speech that
 * happens to quote a hallucination phrase.
 *
 * Pure function.
 */
export const isKnownHallucination = (
  text: string,
  language?: string,
): boolean => {
  const normalised = normaliseForMatch(text);
  if (!normalised) return false;

  const buckets: string[][] = [];
  buckets.push(HALLUCINATION_PHRASES.all);

  if (language) {
    const langKey = language.toLowerCase().slice(0, 2);
    const bucket = HALLUCINATION_PHRASES[langKey];
    if (bucket) buckets.push(bucket);
  } else {
    // No language hint → scan every bucket
    for (const key of Object.keys(HALLUCINATION_PHRASES)) {
      if (key === "all") continue;
      buckets.push(HALLUCINATION_PHRASES[key]);
    }
  }

  for (const bucket of buckets) {
    for (const rawPhrase of bucket) {
      const phrase = normaliseForMatch(rawPhrase);
      if (!phrase) continue;

      // Rule 1: exact match
      if (normalised === phrase) return true;

      // Rule 2: phrase-contains-transcription (transcription is a prefix/suffix of phrase)
      // e.g. phrase "thanks for watching" vs transcription "thanks for watching the"
      // We only accept short transcriptions (<= 2x phrase length) to avoid
      // rejecting real speech that happens to contain the phrase as a fragment.
      if (
        normalised.length <= phrase.length * 2 &&
        normalised.includes(phrase)
      ) {
        return true;
      }
    }
  }

  return false;
};

// ─────────────────────────────────────────────────────────────────────────────
// Audio amplitude check (RMS)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute RMS (root-mean-square) amplitude of a PCM16 little-endian buffer.
 *
 * RMS is the standard measure of "loudness" for digital audio and is a
 * proxy for whether the mic actually captured energy. For 16-bit audio,
 * the theoretical max RMS is ~32767. A totally silent buffer reads ~0.
 * Ambient room noise on a decent mic sits in the 50-300 range. A clear
 * spoken word typically exceeds 1500-3000.
 *
 * If a WAV header is present, the 44-byte RIFF header is skipped so the
 * header bytes don't pollute the RMS calculation.
 *
 * Pure function.
 */
export const computeRmsPcm16 = (audioBuffer: Buffer): number => {
  if (!audioBuffer || audioBuffer.length < 2) return 0;

  let offset = 0;

  // Detect WAV header: "RIFF" at [0..4), "WAVE" at [8..12)
  if (
    audioBuffer.length >= 44 &&
    audioBuffer.toString("ascii", 0, 4) === "RIFF" &&
    audioBuffer.toString("ascii", 8, 12) === "WAVE"
  ) {
    // Standard PCM WAV has a 44-byte header; some encoders add extra chunks.
    // We seek the "data" chunk marker to be safe.
    const dataIdx = audioBuffer.indexOf("data", 12, "ascii");
    if (dataIdx >= 0 && dataIdx + 8 <= audioBuffer.length) {
      offset = dataIdx + 8; // skip "data" + 4-byte chunk length
    } else {
      offset = 44; // fallback to standard header length
    }
  }

  const sampleBytes = audioBuffer.length - offset;
  if (sampleBytes < 2) return 0;

  const sampleCount = Math.floor(sampleBytes / 2);
  let sumSquares = 0;

  for (let i = 0; i < sampleCount; i++) {
    // readInt16LE is a Node built-in; no deps needed
    const sample = audioBuffer.readInt16LE(offset + i * 2);
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / sampleCount);
};

/**
 * Is the audio buffer too quiet to reasonably contain speech?
 *
 * Default threshold: 500 RMS. This is conservative — a normal speaking
 * voice at 6in from the mic reads 1500+, and even faint whispers hit 700+.
 * Sub-500 is almost always mic leakage / fan noise / silence.
 *
 * Callers with sensitive use-cases (whisper-to-mic translation) can raise
 * the threshold to ~800. Callers in noisy environments can lower it to
 * ~300.
 *
 * Pure function.
 */
export const isAudioTooQuiet = (
  audioBuffer: Buffer,
  threshold: number = 500,
): boolean => {
  if (!audioBuffer || audioBuffer.length < 2) return true;
  const rms = computeRmsPcm16(audioBuffer);
  return rms < threshold;
};

// ─────────────────────────────────────────────────────────────────────────────
// Duration check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reject captures shorter than `minMs` (default 300ms).
 *
 * 300ms is the approximate floor for a monosyllabic utterance — anything
 * shorter is button-bounce or trigger-happy hotkey presses.
 *
 * Pure function.
 */
export const isAudioTooShort = (
  durationMs: number,
  minMs: number = 300,
): boolean => {
  if (!Number.isFinite(durationMs) || durationMs < 0) return true;
  return durationMs < minMs;
};

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run every filter check in order of cheapest → most expensive and return
 * the first failure, or `{ ok: true }` if all checks pass.
 *
 * Order rationale:
 *  1. Empty text is a zero-cost check
 *  2. Duration is a single compare
 *  3. RMS is O(n) over the buffer but only runs if a buffer was supplied
 *  4. Hallucination match is O(phrases) string work
 *
 * Pure function — does not mutate inputs, does not touch the filesystem,
 * does not call out to the network.
 */
export const filterTranscriptionResult = (input: {
  text: string;
  language?: string;
  durationMs: number;
  audioBuffer?: Buffer;
}): FilterResult => {
  // 1. Empty text
  if (!input.text || input.text.trim().length === 0) {
    return { ok: false, reason: "empty_text", detail: "transcription was empty" };
  }

  // 2. Too short
  if (isAudioTooShort(input.durationMs)) {
    return {
      ok: false,
      reason: "too_short",
      detail: `duration ${input.durationMs}ms < 300ms floor`,
    };
  }

  // 3. Too quiet (only if buffer supplied)
  if (input.audioBuffer && isAudioTooQuiet(input.audioBuffer)) {
    const rms = computeRmsPcm16(input.audioBuffer).toFixed(1);
    return {
      ok: false,
      reason: "too_quiet",
      detail: `rms ${rms} < 500 threshold`,
    };
  }

  // 4. Known hallucination
  if (isKnownHallucination(input.text, input.language)) {
    return {
      ok: false,
      reason: "hallucination",
      detail: `matched known Whisper hallucination phrase (${input.language ?? "any"})`,
    };
  }

  return { ok: true };
};
