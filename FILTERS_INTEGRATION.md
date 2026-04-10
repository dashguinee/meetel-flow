# Filters Integration Guide

This guide explains how to wire the new `src/main/filters.ts` module into
`src/main/stt.ts` to stop Whisper hallucinations from ever reaching the
renderer or the user's cursor.

The filter module is **pure** — it has zero side effects, no I/O, no
network calls — so it's safe to call synchronously inside the main STT
path without adding latency or failure modes.

---

## Why this exists

Field reports from the Feb 2026 sessions flagged that Groq Whisper
large-v3 occasionally emits memorised training-data artifacts on silent,
noisy, or music-only input. The worst offenders:

- `"Sous-titrage de la Société Radio-Canada"` (French)
- `"Merci"` as a single-token hallucination (French)
- `"Thanks for watching"` / `"Please subscribe"` (English)
- `"ご視聴ありがとうございました"` (Japanese)
- Bracket artifacts like `[Music]`, `[Applause]`, `[Silence]`

`filters.ts` covers 110+ such phrases across 7 languages plus an
`"all"` bucket for language-agnostic noise, and also adds two physical
gates (audio duration floor + RMS energy floor) to reject captures that
are physically incapable of containing speech.

---

## Where to call the filter in `stt.ts`

The filter should run **after** Whisper returns a result but **before**
any regex cleanup / voice-command processing / LLM polish. This is for
two reasons:

1. **Cost** — you don't want to spend a Groq Llama polish call on a
   transcription that's about to be rejected anyway.
2. **Correctness** — the LLM polish step rewrites text, so by the time
   it finishes the original hallucination signature may be partially
   masked and harder to detect.

The ideal insertion point in the current `stt.ts` is inside the
`transcribe()` function, immediately after the Groq result returns and
before `filterHallucinations(result.text, result.segments)`:

```ts
// src/main/stt.ts — import at top
import { filterTranscriptionResult } from "./filters";

// inside transcribe(), after:
const result = await groqTranscribe(wavBuffer, config.language, config.groqApiKey);

// ── NEW: quality filter ──────────────────────────────────────────────
const verdict = filterTranscriptionResult({
  text: result.text,
  language: result.detectedLang || config.language,
  durationMs: Math.round(durationSeconds * 1000),
  audioBuffer: wavBuffer, // pass the raw WAV — filter auto-detects RIFF header
});

if (!verdict.ok) {
  console.log(`[STT] Filtered: ${verdict.reason} — ${verdict.detail ?? ""}`);
  // Emit telemetry (see Telemetry section below)
  // telemetry.track({
  //   event: "dictation_failure",
  //   payload: {
  //     duration_ms: Math.round(durationSeconds * 1000),
  //     provider: "groq",
  //     error_code: "filtered",
  //     error_message: verdict.reason ?? "unknown",
  //   },
  // });
  throw new Error("No voice detected");
}

// ──────────────────────────────────────────────────────────────────────

if (result.text) {
  // ... existing pipeline continues here
  let text = filterHallucinations(result.text, result.segments);
  // ...
}
```

Throwing `"No voice detected"` is intentional — it matches the existing
error string at the bottom of `transcribe()`, which the renderer already
knows how to handle (status text `"No voice detected"` is already wired
up in `renderer.ts` per SESSION_2026-02-24.md notes).

---

## Optional: a more granular renderer status

If you want the capsule to distinguish *why* the transcription was
filtered (e.g. show `"Too quiet"` vs `"Too short"` vs `"No voice
detected"`), extend `DictationResult` in `src/main/types.ts` to carry a
status field, then return a non-throwing result:

```ts
// types.ts
export type DictationResult = {
  text: string;
  provider: "groq" | "whisper";
  latencyMs: number;
  durationSeconds: number;
  detectedLang?: string;
  status?: "ok" | "filtered";
  filterReason?: "hallucination" | "too_quiet" | "too_short" | "empty_text";
};
```

Then in `stt.ts`:

```ts
if (!verdict.ok) {
  return {
    text: "",
    provider: "groq",
    latencyMs: Date.now() - t,
    durationSeconds,
    detectedLang: result.detectedLang,
    status: "filtered",
    filterReason: verdict.reason,
  };
}
```

And the renderer can map `filterReason` → capsule status text:

```ts
// renderer.ts
const STATUS_TEXT: Record<string, string> = {
  hallucination: "No voice detected",
  too_quiet: "Too quiet",
  too_short: "Too short",
  empty_text: "No speech",
};
```

---

## Telemetry hook

Whenever `filterTranscriptionResult` rejects a capture, emit a
`dictation_failure` event so we can track false-positive rates in
production. The `TelemetryEvent` discriminated union in
`src/main/events.ts` already supports this — use `error_code: "filtered"`
and put the filter reason in `error_message`:

```ts
import { telemetry } from "./usage"; // or wherever the emitter lives

if (!verdict.ok) {
  telemetry.track({
    event: "dictation_failure",
    payload: {
      duration_ms: Math.round(durationSeconds * 1000),
      provider: "groq",
      error_code: "filtered",
      error_message: verdict.reason ?? "unknown",
    },
  });
  throw new Error("No voice detected");
}
```

This lets you answer questions like:

- "What percentage of Groq calls are rejected by the hallucination
  filter?" (healthy baseline: 1–5%)
- "Is `too_quiet` triggering too often for users with quiet mics?"
  (if >10%, consider lowering the RMS threshold)
- "Which language has the most filtered events?" (tune phrase lists
  accordingly)

---

## Fallback path

The filter should **also** run after the `whisper.cpp` local fallback
(same insertion pattern — after `transcribeLocal(...)` returns,
before `regexCleanup(text)`). Local whisper.cpp hallucinates the same
way as Groq Whisper since they share a model lineage.

```ts
let text = await transcribeLocal(wavBuffer, "auto");

// filter fallback output too
const verdict = filterTranscriptionResult({
  text,
  language: config.language,
  durationMs: Math.round(durationSeconds * 1000),
  audioBuffer: wavBuffer,
});
if (!verdict.ok) {
  telemetry.track({
    event: "dictation_failure",
    payload: {
      duration_ms: Math.round(durationSeconds * 1000),
      provider: "whisper",
      error_code: "filtered",
      error_message: verdict.reason ?? "unknown",
    },
  });
  throw new Error("No voice detected");
}
```

---

## Tuning knobs

All thresholds are function parameters with sensible defaults. If field
reports show the filter is too aggressive or too lax, tune them at the
call site without touching `filters.ts`:

```ts
// Conservative (fewer false positives, more false negatives):
isAudioTooQuiet(buf, 300);     // lower RMS floor
isAudioTooShort(dur, 200);     // accept shorter captures

// Strict (reject more aggressively):
isAudioTooQuiet(buf, 800);     // higher RMS floor
isAudioTooShort(dur, 500);     // require longer captures
```

The hallucination phrase list itself is exported as
`HALLUCINATION_PHRASES` so test suites and feature flags can extend it
at runtime without editing the module.

---

## Assumptions on audio buffer format

`computeRmsPcm16` assumes **PCM16 little-endian signed samples**. The
current Meetel Flow pipeline passes a WAV buffer to `transcribe()` via
the `wavBase64` parameter, and WAV files are PCM16 LE by default — so
passing `wavBuffer` directly works out of the box. The module
auto-detects the 44-byte RIFF header and skips it before computing RMS.

If in the future Meetel switches to WebM/Opus/MP3 for transport, you'll
need to decode to PCM first (or pass the decoded buffer from the
capture layer) before calling `isAudioTooQuiet`. The other filters
(`isKnownHallucination`, `isAudioTooShort`) don't touch the buffer and
will continue to work unchanged.

---

## Testing

Every exported function in `filters.ts` is pure, so unit tests are
trivial:

```ts
import {
  isKnownHallucination,
  isAudioTooShort,
  isAudioTooQuiet,
  filterTranscriptionResult,
  computeRmsPcm16,
  normaliseForMatch,
} from "./filters";

// Hallucination detection
isKnownHallucination("Sous-titrage de la Société Radio-Canada", "fr"); // → true
isKnownHallucination("Merci", "fr");                                    // → true
isKnownHallucination("Thanks for watching", "en");                      // → true
isKnownHallucination("merci  !", "fr");                                 // → true (normalised)
isKnownHallucination("We need to deploy the app", "en");                // → false

// Duration
isAudioTooShort(200);  // → true
isAudioTooShort(350);  // → false
isAudioTooShort(100, 50); // → false (custom threshold)

// Full orchestration
filterTranscriptionResult({
  text: "Merci",
  language: "fr",
  durationMs: 1200,
});
// → { ok: false, reason: "hallucination", detail: "..." }
```

For RMS tests, generate a silent PCM16 buffer with
`Buffer.alloc(16000 * 2)` (1s of silence) — `isAudioTooQuiet` should
return `true`. Generate a sine wave with `Math.sin` and `writeInt16LE`
and it should return `false`.
