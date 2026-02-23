# Meetel Flow STT Deep Dive - Groq Whisper Integration Analysis

**Date**: 2026-02-22
**Scope**: Why Groq Whisper STT isn't working in the Electron app
**Files analyzed**: stt.ts, renderer.ts, index.ts, preload.ts, config.ts, types.ts, groq-sdk internals

---

## 1. How aftermath-app Handles Audio Transcription (Reference Implementation)

### Recording Flow (`/home/dash/aftermath-app/src/pages/MeetingRoom.tsx`)

```typescript
// 1. Get mic stream (browser context, NOT Electron)
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

// 2. Create MediaRecorder with default codec
const mediaRecorder = new MediaRecorder(stream);

// 3. Collect chunks
mediaRecorder.ondataavailable = (e) => {
  if (e.data.size > 0) chunksRef.current.push(e.data);
};

// 4. On stop: create blob
const blob = new Blob(chunksRef.current, { type: 'audio/webm' });

// 5. Send blob DIRECTLY to whisperService (no base64, no IPC)
await transcribeAudio(blob);
```

### Transcription Flow (`/home/dash/aftermath-app/src/services/whisperService.ts`)

```typescript
// Uses OpenAI API (NOT Groq) with FormData
const formData = new FormData();
formData.append('file', processedBlob, filename); // <-- blob + filename with extension
formData.append('model', model);
formData.append('response_format', 'verbose_json');

const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
  body: formData,
});
```

### Key Differences from meetel-flow
| Aspect | aftermath-app | meetel-flow |
|--------|--------------|-------------|
| Environment | Browser (Vite/React) | Electron (renderer -> main via IPC) |
| API | OpenAI Whisper | Groq Whisper |
| File transfer | Direct Blob -> FormData | Blob -> base64 -> IPC -> Buffer -> File -> SDK |
| SDK | Raw fetch + FormData | groq-sdk library |
| Compression | ffmpeg.wasm pre-compression | None |
| Audio format | audio/webm (with extension `recording.webm`) | audio/webm |

**Critical observation**: aftermath-app keeps the Blob in-process and uses raw `fetch` with `FormData`. meetel-flow serializes to base64, crosses IPC, deserializes in Node, then uses the groq-sdk which has its OWN File/FormData classes.

---

## 2. Groq Whisper API Requirements

### Endpoint
```
POST https://api.groq.com/openai/v1/audio/transcriptions
```

### Required Parameters
- `file` (multipart file upload) OR `url` (URL to audio file)
- `model` - one of: `whisper-large-v3`, `whisper-large-v3-turbo`

### Supported Audio Formats
`flac`, `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `ogg`, `opus`, `wav`, `webm`

### File Size Limits
- Free tier: 25 MB max
- Dev tier: 100 MB max
- Minimum duration: 0.01 seconds
- Minimum billed duration: 10 seconds

### Response Format Options
- `json` (default) - `{ "text": "..." }`
- `verbose_json` - includes `segments` with `start`, `end`, `text`, `no_speech_prob`
- `text` - plain text only

### Critical API Requirement: FILENAME MUST HAVE EXTENSION
The Groq API validates the file type by inspecting the **filename extension** in the multipart form data. A filename like `"audio"` (no extension) will be rejected with:
> "file must be one of the following types: [flac mp3 mp4 mpeg mpga m4a ogg opus wav webm]"

This was a documented bug in vercel/ai SDK (issue #6413) and is highly relevant to meetel-flow.

### groq-sdk Node.js Usage
The official SDK provides `toFile()` helper:
```typescript
import Groq, { toFile } from 'groq-sdk';

// Recommended: use toFile with proper filename
const file = await toFile(Buffer.from(audioData), 'audio.webm', { type: 'audio/webm' });
await client.audio.transcriptions.create({ file, model: 'whisper-large-v3-turbo' });
```

---

## 3. Every Bug Found in meetel-flow

### BUG #1 (CRITICAL): Wrong `File` class - `node:buffer.File` vs `formdata-node.File`

**File**: `/home/dash/meetel-flow/src/main/stt.ts`, line 2 and 28

```typescript
import { File } from "node:buffer";  // <--- THIS IS THE WRONG FILE CLASS
// ...
const file = new File([buffer], "audio.webm", { type: mimeType });
```

**The Problem**: The groq-sdk internally uses `formdata-node`'s `File` class, NOT Node.js's built-in `File` from `node:buffer`. When the SDK's `addFormValue` function encounters the file object, it checks `isUploadable(value)` which calls `isFileLike(value)`.

The `isFileLike` check in `groq-sdk/src/uploads.ts` requires:
```typescript
const isFileLike = (value: any): value is FileLike =>
  value != null &&
  typeof value === 'object' &&
  typeof value.name === 'string' &&           // ✓ node:buffer File has .name
  typeof value.lastModified === 'number' &&   // ✗ node:buffer File MAY differ
  isBlobLike(value);                          // ✗ node:buffer Blob may not match
```

The `isBlobLike` check requires:
```typescript
const isBlobLike = (value: any): value is BlobLike =>
  typeof value.size === 'number' &&
  typeof value.type === 'string' &&
  typeof value.text === 'function' &&
  typeof value.slice === 'function' &&
  typeof value.arrayBuffer === 'function';   // <-- compatibility varies by Node version
```

When these checks fail, the SDK falls through to treat the file as a plain object and tries to serialize it as nested form fields (`file[0]`, `file[name]`, etc.) instead of as a file upload. This produces a malformed multipart request that Groq rejects.

**Even if the duck-typing passes**, the internal `FormDataEncoder` from `form-data-encoder` package serializes form entries. It expects `formdata-node` Blob/File instances. Passing a `node:buffer` File through `FormData.append()` where `FormData` is from `formdata-node` can produce corrupt multipart bodies because the internal stream handling differs between the two Blob implementations.

**Severity**: CRITICAL - This is likely the #1 reason the integration doesn't work.

---

### BUG #2 (HIGH): Using `as any` bypasses type safety on the SDK call

**File**: `/home/dash/meetel-flow/src/main/stt.ts`, line 41

```typescript
const data = await groq.audio.transcriptions.create(params as any);
```

The `params` object is typed as `Record<string, unknown>` and then cast with `as any`. This hides the fact that the `file` field is not actually a `Core.Uploadable` type (which expects `FileLike | ResponseLike | FsReadStream`). The TypeScript compiler would have caught this if the types weren't being bypassed.

---

### BUG #3 (MEDIUM): No error handling for base64 decode failure

**File**: `/home/dash/meetel-flow/src/main/stt.ts`, line 27

```typescript
const buffer = Buffer.from(audioBase64, "base64");
```

If the renderer sends corrupt base64 (e.g., truncated by IPC limits, or with data URL prefix `data:audio/webm;base64,`), this silently produces a corrupt buffer. There's no validation that the buffer starts with valid WebM magic bytes (`0x1A 0x45 0xDF 0xA3`).

---

### BUG #4 (MEDIUM): MediaRecorder mimeType may not be `audio/webm`

**File**: `/home/dash/meetel-flow/src/renderer/renderer.ts`, line 206-207

```typescript
mediaRecorder = new MediaRecorder(currentStream, {
  mimeType: "audio/webm",
});
```

Not all browsers/Electron versions support `audio/webm`. If the codec isn't available, `MediaRecorder` will throw an error. The code doesn't check `MediaRecorder.isTypeSupported('audio/webm')` first, and there's no fallback to `audio/webm;codecs=opus` or `audio/ogg;codecs=opus`.

Then on line 150:
```typescript
const blob = new Blob(chunks, { type: "audio/webm" });
```

The hardcoded MIME type is sent to the main process on line 154:
```typescript
const result = await window.meetelFlow.transcribe(audioBase64, "audio/webm");
```

If the actual MediaRecorder used a different codec, the MIME type sent to Groq would be wrong.

---

### BUG #5 (LOW): blobToBase64 implementation is inefficient but functional

**File**: `/home/dash/meetel-flow/src/renderer/renderer.ts`, lines 117-129

```typescript
const blobToBase64 = async (blob: Blob): Promise<string> => {
  const arrayBuffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(arrayBuffer);
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    const slice = bytes.subarray(i, i + step);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
};
```

This works but has two concerns:
1. String concatenation in a loop with potentially large audio files
2. `btoa()` can fail on very large strings (browser memory limit)

A `FileReader.readAsDataURL()` approach or using `Buffer` (if available in Electron renderer) would be safer.

---

### BUG #6 (LOW): No size validation before IPC transfer

Neither the renderer nor the main process validates the audio blob size before base64 encoding and IPC transfer. A 25MB audio file becomes ~33MB in base64, all passed through Electron's IPC serialization. This could cause:
- Memory pressure in the renderer
- IPC message size limits
- Slow transfer

---

## 4. The EXACT Fix

### Fix for BUG #1 (the critical one)

Replace `node:buffer` File with `groq-sdk`'s `toFile` helper.

**Current code** (`/home/dash/meetel-flow/src/main/stt.ts`):
```typescript
import Groq from "groq-sdk";
import { File } from "node:buffer";
import { FlowConfig, DictationResult } from "./types";

// ...

export const transcribeGroq = async (
  audioBase64: string,
  mimeType: string,
  language: string,
  apiKey: string
): Promise<{ text: string }> => {
  const groq = new Groq({ apiKey });
  const buffer = Buffer.from(audioBase64, "base64");
  const file = new File([buffer], "audio.webm", { type: mimeType });

  const params: Record<string, unknown> = {
    file,
    model: "whisper-large-v3-turbo",
    response_format: "verbose_json" as const,
    temperature: 0,
  };

  if (language !== "auto") {
    params.language = language;
  }

  const data = await groq.audio.transcriptions.create(params as any);
  // ...
```

**Fixed code**:
```typescript
import Groq, { toFile } from "groq-sdk";
import { FlowConfig, DictationResult } from "./types";

// Map MIME types to file extensions (Groq validates by filename extension)
const MIME_TO_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/flac": "flac",
  "audio/m4a": "m4a",
  "audio/mp4": "m4a",
  "audio/opus": "opus",
};

// ...

export const transcribeGroq = async (
  audioBase64: string,
  mimeType: string,
  language: string,
  apiKey: string
): Promise<{ text: string }> => {
  const groq = new Groq({ apiKey });
  const buffer = Buffer.from(audioBase64, "base64");

  // Use groq-sdk's toFile helper — produces a File object compatible
  // with the SDK's internal formdata-node serialization
  const ext = MIME_TO_EXT[mimeType] || "webm";
  const file = await toFile(buffer, `audio.${ext}`, { type: mimeType });

  const data = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3-turbo",
    response_format: "verbose_json",
    temperature: 0,
    ...(language !== "auto" ? { language } : {}),
  });

  console.log("[Groq] Raw response:", JSON.stringify(data));

  // verbose_json returns segments with no_speech_prob
  const segments = (data as any).segments as Array<{ text: string; no_speech_prob: number }> | undefined;

  if (segments && segments.length > 0) {
    const realSegments = segments.filter(s => s.no_speech_prob < 0.9);
    if (realSegments.length === 0) {
      return { text: "" };
    }
    const joined = realSegments.map(s => s.text).join("").trim();
    if (isHallucination(joined)) {
      return { text: "" };
    }
    return { text: joined };
  }

  const text = typeof data === "object" && "text" in data ? (data as any).text : "";
  if (isHallucination(text)) {
    return { text: "" };
  }
  return { text };
};
```

### Key Changes Summary:

| Change | Why |
|--------|-----|
| `import { File } from "node:buffer"` -> `import Groq, { toFile } from "groq-sdk"` | Use SDK's own File class that's compatible with its internal `formdata-node` serialization |
| `new File([buffer], "audio.webm", { type: mimeType })` -> `await toFile(buffer, "audio.webm", { type: mimeType })` | `toFile()` wraps the buffer in the correct `formdata-node.File` instance |
| `params as any` -> properly typed object literal | Remove unsafe cast; let TypeScript verify the shape |
| Dynamic extension from MIME type | Ensure Groq's filename-extension validation passes |

### Optional: Fix for BUG #4 (MediaRecorder codec detection)

In `/home/dash/meetel-flow/src/renderer/renderer.ts`, replace the startCapture function:

```typescript
const startCapture = async (): Promise<void> => {
  currentStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      channelCount: 1,
    },
  });

  // Detect best supported MIME type
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  let chosenMime = "";
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      chosenMime = mime;
      break;
    }
  }

  const options: MediaRecorderOptions = chosenMime ? { mimeType: chosenMime } : {};
  mediaRecorder = new MediaRecorder(currentStream, options);
  // Store the actual MIME type for later use
  const actualMime = mediaRecorder.mimeType || chosenMime || "audio/webm";

  chunks = [];

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  // Store mime for stopCapture to use
  (mediaRecorder as any)._actualMime = actualMime;

  mediaRecorder.start();
  isRecording = true;
  setVisualState("listening");
  await window.meetelFlow.setState("listening");
};
```

And in `stopCapture`, use the actual MIME type:
```typescript
const blob = new Blob(chunks, { type: (recorder as any)._actualMime || "audio/webm" });
// ...
const result = await window.meetelFlow.transcribe(audioBase64, (recorder as any)._actualMime || "audio/webm");
```

---

## 5. Root Cause Summary

The #1 issue is **`File` class mismatch**. The `node:buffer` `File` class and `formdata-node`'s `File` class are NOT interchangeable. The groq-sdk's internal multipart serialization pipeline (`uploads.ts` -> `createForm` -> `addFormValue` -> `FormDataEncoder`) expects `formdata-node` instances. When it receives a `node:buffer` File:

1. `isUploadable()` may fail (duck-typing mismatch on Blob methods) -> file gets serialized as a plain object -> API receives garbage
2. Even if duck-typing passes, `formdata-node`'s `FormData.append()` may not correctly stream the `node:buffer` Blob's data -> corrupt multipart body -> API rejects

The fix is exactly one line change: use `toFile()` from `groq-sdk` instead of `new File()` from `node:buffer`. The SDK's `toFile()` internally creates a `formdata-node` File with correct streaming support.

---

## 6. Testing Checklist

After applying the fix:

- [ ] Build: `npm run build` completes without errors
- [ ] Record 5 seconds of speech -> verify Groq response in console log
- [ ] Record silence -> verify hallucination filter returns empty text
- [ ] Test with language set to "en", "fr", and "auto"
- [ ] Verify Gemini fallback still works if Groq key is removed
- [ ] Check IPC payload size for a 2-minute recording (should be < 10MB base64)
- [ ] Test on Windows (primary target platform for Meetel Flow)
