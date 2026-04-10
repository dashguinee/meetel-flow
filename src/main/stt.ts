import { execFile } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { FlowConfig, DictationResult } from "./types";
import { filterTranscriptionResult } from "./filters";

// Direct file logging — bypasses any console override issues
const LOG_PATH = path.join(os.homedir(), ".meetel-flow", "stt.log");
const log = (msg: string) => { try { fs.appendFileSync(LOG_PATH, new Date().toISOString().slice(11, 19) + " " + msg + "\n"); } catch {} };

/* ── Session transcript memory (for prompt continuity) ── */

let lastTranscript = "";

/* ── Groq Whisper API (primary — fast, accurate, $0.04/hr) ── */

interface GroqSegment {
  text: string;
  avg_logprob: number;
  no_speech_prob: number;
  compression_ratio: number;
}

interface GroqResult { text: string; detectedLang: string; segments: GroqSegment[] }

const groqTranscribe = (wavBuffer: Buffer, language: string, apiKey: string): Promise<GroqResult> =>
  new Promise((resolve, reject) => {
    const lang = (language === "en" || language === "fr") ? language : undefined;

    const boundary = "----MeetelBoundary" + Date.now();
    const parts: Buffer[] = [];

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
    ));
    parts.push(wavBuffer);
    parts.push(Buffer.from("\r\n"));

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n`
    ));

    // Force language when user selected one — this locks Whisper to that language
    if (lang) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${lang}\r\n`
      ));
    }

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`
    ));

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nword\r\n`
    ));
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nsegment\r\n`
    ));

    // Language-specific prompt — tells Whisper the style to follow
    const glossary = "Meetel, Meetel Flow, DASH, TypeScript, React, Supabase, Vercel";
    const selectedPrompt = lang === "fr"
      ? `Bonjour, c'est une réunion professionnelle. On a discuté du développement avec l'équipe. Les résultats de l'expérience sont très intéressants. Il est nécessaire de présenter ça correctement. ${glossary}.`
      : lang === "en"
      ? `Meeting transcript. The team discussed the deployment pipeline and reviewed the architecture. We agreed on next steps for the project. Professional transcription with proper punctuation. ${glossary}.`
      : `The team discussed the deployment pipeline and reviewed the architecture. ${glossary}. Ensuite, l'équipe a présenté les résultats. C'est nécessaire d'être précis: é, è, ê, à, ç.`;
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n${selectedPrompt}\r\n`
    ));

    // Temperature 0 — lets Whisper auto-adjust on unclear audio
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="temperature"\r\n\r\n0\r\n`
    ));

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const req = https.request({
      hostname: "api.groq.com",
      path: "/openai/v1/audio/transcriptions",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
      timeout: 30000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        console.log("[GROQ] Status:", res.statusCode);
        if (res.statusCode !== 200) {
          reject(new Error(`Groq ${res.statusCode}: ${data.slice(0, 100)}`));
          return;
        }
        try {
          const json = JSON.parse(data) as { text?: string; language?: string; segments?: GroqSegment[] };
          const detected = json.language || "";
          const segments = json.segments || [];
          if (detected) console.log("[GROQ] Detected language:", detected);
          if (segments.length > 0) {
            const avgLogprob = segments.reduce((s, seg) => s + seg.avg_logprob, 0) / segments.length;
            const maxNoSpeech = Math.max(...segments.map(s => s.no_speech_prob));
            console.log("[GROQ] Quality: avg_logprob=" + avgLogprob.toFixed(3) + " max_no_speech=" + maxNoSpeech.toFixed(3));
          }
          resolve({ text: json.text?.trim() || "", detectedLang: detected, segments });
        } catch {
          reject(new Error("Groq: invalid JSON response"));
        }
      });
    });

    req.on("error", (e) => reject(new Error(`Groq network: ${e.message}`)));
    req.on("timeout", () => { req.destroy(); reject(new Error("Groq: timeout")); });
    req.write(body);
    req.end();
  });

/* ── whisper.cpp local fallback ── */

const WHISPER_DIR = path.join(os.homedir(), ".meetel-flow", "whisper");
const WHISPER_EXE = path.join(WHISPER_DIR, "whisper-cli.exe");
const WHISPER_MODEL = path.join(WHISPER_DIR, "ggml-base.bin");

const isWhisperInstalled = (): boolean =>
  fs.existsSync(WHISPER_EXE) && fs.existsSync(WHISPER_MODEL);

const transcribeLocal = (wavBuffer: Buffer, language: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `meetel-${Date.now()}.wav`);
    fs.writeFileSync(tmpFile, wavBuffer);

    const lang = language === "auto" ? "auto" : language;
    // NOTE: --print-special is a boolean flag (defaults to false); passing "false"
    // as a value made whisper-cli treat it as a positional filename arg, breaking
    // the entire fallback path. Removed — the flag is unnecessary since false is default.
    const args = [
      "-m", WHISPER_MODEL,
      "-f", tmpFile,
      "-l", lang,
      "--no-timestamps",
      "-t", "4",
    ];

    console.log("[WHISPER] Running:", WHISPER_EXE, args.join(" "));

    execFile(WHISPER_EXE, args, { timeout: 30000, cwd: WHISPER_DIR }, (error, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }

      if (error) {
        console.error("[WHISPER] Error:", error.message);
        console.error("[WHISPER] Stderr:", stderr);
        reject(new Error(`Whisper failed: ${error.message}`));
        return;
      }

      console.log("[WHISPER] Raw output:", JSON.stringify(stdout));
      const text = stdout
        .replace(/\[BLANK_AUDIO\]/g, "")
        .replace(/\[.*?\]/g, "")
        .trim();

      resolve(text);
    });
  });

/* ── Hallucination filter — detect and remove Whisper artifacts ── */

const filterHallucinations = (text: string, segments: GroqSegment[]): string => {
  if (segments.length === 0) return text;

  // Filter out segments that are likely hallucinated
  const cleanSegments: string[] = [];
  const seenTexts = new Set<string>();

  for (const seg of segments) {
    // High no_speech_prob = silence misinterpreted as speech
    if (seg.no_speech_prob > 0.6) {
      console.log("[HALLUCINATION] Skipping (no_speech):", seg.text.slice(0, 50));
      continue;
    }
    // Very high compression = repetitive/hallucinated
    if (seg.compression_ratio > 2.4) {
      console.log("[HALLUCINATION] Skipping (compression):", seg.text.slice(0, 50));
      continue;
    }
    // Very low confidence = uncertain
    if (seg.avg_logprob < -1.0) {
      console.log("[HALLUCINATION] Skipping (low confidence):", seg.text.slice(0, 50));
      continue;
    }
    // Deduplicate: skip segments with identical or near-identical text (Whisper looping)
    const normalized = seg.text.trim().toLowerCase();
    if (normalized.length > 5 && seenTexts.has(normalized)) {
      console.log("[HALLUCINATION] Skipping (duplicate):", seg.text.slice(0, 50));
      continue;
    }
    seenTexts.add(normalized);
    cleanSegments.push(seg.text.trim());
  }

  // If all segments were filtered, return original (better than empty)
  if (cleanSegments.length === 0) return text;
  return cleanSegments.join(" ");
};

/* ── Regex cleanup — remove common Whisper artifacts ── */

const regexCleanup = (text: string): string => {
  let cleaned = text;

  // Remove Whisper hallucination phrases
  cleaned = cleaned.replace(/\b(thanks for watching|subscribe|like and share|thank you for listening|please subscribe|merci d'avoir regardé|abonnez-vous)\b\.?/gi, '');

  // Remove filler words — EN
  cleaned = cleaned.replace(/\b(um|uh|erm|hmm|like,? you know|you know,?|basically,?|actually,?|I mean,?|so,? like)\b/gi, '');

  // Remove filler words — FR
  cleaned = cleaned.replace(/\b(euh|hum|bah|genre|en fait,?|du coup,?|voilà,?)\b/gi, '');

  // Remove repeated phrases (Whisper stuttering) — 1-4 word phrases repeated
  cleaned = cleaned.replace(/\b(\w+(?:\s+\w+){0,3})\s+\1\b/gi, '$1');

  // Remove repeated sentences (Whisper looping) — same sentence appearing 2+ times
  cleaned = cleaned.replace(/([^.!?]{10,}[.!?])\s*(\1\s*)+/gi, '$1');

  // Clean up extra whitespace first (before capitalization)
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // Remove leading/trailing punctuation artifacts
  cleaned = cleaned.replace(/^[,.\s]+/, '').replace(/[,\s]+$/, '').trim();

  // Capitalize standalone "I" in English
  cleaned = cleaned.replace(/ i /g, ' I ');
  cleaned = cleaned.replace(/^i /g, 'I ');

  // Capitalize first letter of sentences (including start of string)
  cleaned = cleaned.replace(/^([a-z])/, (_m, c) => c.toUpperCase());
  cleaned = cleaned.replace(/([.!?]\s+)([a-z])/g, (_m, p1, p2) => p1 + p2.toUpperCase());

  return cleaned;
};

/* ── Voice commands — convert spoken punctuation/formatting ── */

const processVoiceCommands = (text: string): string => {
  let processed = text;

  // Line breaks (trim surrounding spaces)
  processed = processed.replace(/\s*\b(new line|newline|nouvelle ligne|retour à la ligne)\b\s*/gi, '\n');
  processed = processed.replace(/\s*\b(new paragraph|nouveau paragraphe)\b\s*/gi, '\n\n');

  // Punctuation — EN
  processed = processed.replace(/\bperiod\b/gi, '.');
  processed = processed.replace(/\bcomma\b/gi, ',');
  processed = processed.replace(/\bquestion mark\b/gi, '?');
  processed = processed.replace(/\bexclamation mark\b/gi, '!');
  processed = processed.replace(/\bcolon\b/gi, ':');
  processed = processed.replace(/\bsemicolon\b/gi, ';');
  processed = processed.replace(/\bopen quote\b/gi, '"');
  processed = processed.replace(/\bclose quote\b/gi, '"');

  // Punctuation — FR
  processed = processed.replace(/\bpoint\b(?!\s*(de|d'))/gi, '.');
  processed = processed.replace(/\bvirgule\b/gi, ',');
  processed = processed.replace(/\bpoint d'interrogation\b/gi, '?');
  processed = processed.replace(/\bpoint d'exclamation\b/gi, '!');
  processed = processed.replace(/\bdeux points\b/gi, ':');

  // Clean up spaces before punctuation
  processed = processed.replace(/\s+([.,!?;:])/g, '$1');
  // Ensure space after punctuation
  processed = processed.replace(/([.,!?;:])([A-Za-zÀ-ÿ])/g, '$1 $2');

  return processed;
};

/* ── French post-processing — fix common Whisper quirks ── */
const fixFrench = (text: string, lang: string): string => {
  if (lang !== "fr") return text;
  return text
    // "ca" → "ça" when standalone
    .replace(/\bca\b/gi, (m) => m[0] === 'C' ? 'Ça' : 'ça')
    // "Ca " at sentence start
    .replace(/(^|[.!?]\s+)Ca /g, '$1Ça ')
    // Common missing accents — only standalone words
    .replace(/\bEtat\b/g, 'État').replace(/\betat\b/g, 'état')
    .replace(/\betre\b/gi, 'être')
    .replace(/\btres\b/gi, (m) => m[0] === 'T' ? 'Très' : 'très')
    .replace(/\bdeja\b/gi, 'déjà')
    .replace(/\bprobleme\b/gi, (m) => m[0] === 'P' ? 'Problème' : 'problème')
    .replace(/\bpresentation\b/gi, 'présentation')
    .replace(/\breunion\b/gi, 'réunion')
    .replace(/\bgeneral\b/gi, 'général')
    .replace(/\bnecessaire\b/gi, 'nécessaire')
    .replace(/\binteresse\b/gi, 'intéressé')
    .replace(/\bexperience\b/gi, 'expérience')
    .replace(/\bdeveloppement\b/gi, 'développement')
    .replace(/\bfacade\b/gi, 'façade')
    .replace(/\brecu\b/gi, 'reçu')
    .replace(/\bgarcon\b/gi, 'garçon')
    .replace(/\bfrancais\b/gi, 'français')
    .replace(/\blechon\b/gi, 'leçon')
    .replace(/\bapres\b/gi, 'après')
    .replace(/\ba bientot\b/gi, 'à bientôt')
    // "a" → "à" only after pronouns/subjects
    .replace(/\b([Ii]l|[Ee]lle|[Oo]n|[Cc]e|[Qq]ui) a /g, '$1 à ')
};

/* ── LLM Polish — Groq Llama primary, Gemini Flash fallback ── */

const POLISH_PROMPT = (text: string, language: string) => {
  if (language === "fr") return `Fix this French voice dictation.

RULES:
1. The text IS in French — do NOT translate anything to English.
2. Fix ALL missing French accents (etais→étais, meme→même, deja→déjà, tres→très, ca→ça, apres→après, francais→français, complique→compliqué, configure→configuré, probleme→problème, experience→expérience, resultat→résultat, necessaire→nécessaire, premiere→première, regle→règle, etre→être, reconnait→reconnaît, melange→mélange, ecoute→écoute)
3. Fix grammar, punctuation, and capitalization
4. Remove filler words (euh, hum, bah, genre, en fait, du coup, voilà)
5. Remove repeated sentences (keep only once)
6. Remove hallucinations (merci d'avoir regardé, abonnez-vous)
7. Keep English proper nouns and tech terms as-is (DASH, React, TypeScript)
8. Return ONLY the corrected text.

Text:
${text}`;

  if (language === "en") return `Fix this English voice dictation.

RULES:
1. The text IS in English — do NOT translate anything to French.
2. Fix grammar, punctuation, and capitalization
3. Remove filler words (um, uh, like, you know, basically, actually, I mean)
4. Remove repeated sentences (keep only once)
5. Remove hallucinations (thanks for watching, subscribe, please like)
6. Return ONLY the corrected text.

Text:
${text}`;

  // Fallback: bilingual (should rarely hit this now)
  return `Fix this voice dictation. NEVER translate — preserve the original language exactly.

RULES:
1. Fix accents for French words (etais→étais, meme→même, ca→ça, tres→très)
2. Fix grammar and punctuation
3. Remove filler words
4. Remove repeated sentences
5. Return ONLY the corrected text.

Text:
${text}`;
};

const groqPolish = (text: string, groqKey: string, language: string): Promise<string> =>
  new Promise((resolve) => {
    const body = JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: POLISH_PROMPT(text, language) }],
      temperature: 0.1,
      max_tokens: 2048,
    });

    console.log("[GROQ-LLM] Polishing", text.length, "chars with key", groqKey.slice(0, 8) + "...");

    const req = https.request({
      hostname: "api.groq.com",
      path: "/openai/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${groqKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 10000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        log("[GROQ-LLM] Status:" + res.statusCode);
        console.log("[GROQ-LLM] Response status:", res.statusCode);
        if (res.statusCode === 429) {
          log("[GROQ-LLM] RATE LIMITED");
          console.error("[GROQ-LLM] RATE LIMITED — will fallback to Gemini");
          resolve("");
          return;
        }
        if (res.statusCode !== 200) {
          console.error("[GROQ-LLM] Error:", res.statusCode, data.slice(0, 300));
          resolve("");
          return;
        }
        try {
          const json = JSON.parse(data);
          const polished = json.choices?.[0]?.message?.content?.trim();
          if (polished && polished.length > 0) {
            console.log("[GROQ-LLM] OK:", polished.slice(0, 120));
            resolve(polished);
          } else {
            console.error("[GROQ-LLM] Empty content in response");
            resolve("");
          }
        } catch (e) {
          console.error("[GROQ-LLM] Parse error:", data.slice(0, 200));
          resolve("");
        }
      });
    });

    req.on("error", (e) => { console.error("[GROQ-LLM] Network error:", e.message); resolve(""); });
    req.on("timeout", () => { req.destroy(); console.error("[GROQ-LLM] Timeout after 10s"); resolve(""); });
    req.write(body);
    req.end();
  });

const geminiPolish = (text: string, geminiKey: string, language: string): Promise<string> =>
  new Promise((resolve) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: POLISH_PROMPT(text, language) }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
    });

    console.log("[GEMINI] Fallback polishing", text.length, "chars with key", geminiKey.slice(0, 12) + "...");

    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 10000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          console.error("[GEMINI] Error:", res.statusCode, data.slice(0, 200));
          resolve(text);
          return;
        }
        try {
          const json = JSON.parse(data);
          const polished = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (polished && polished.length > 0) {
            console.log("[GEMINI] Polished:", polished.slice(0, 100) + "...");
            resolve(polished);
          } else {
            resolve(text);
          }
        } catch {
          resolve(text);
        }
      });
    });

    req.on("error", () => resolve(text));
    req.on("timeout", () => { req.destroy(); resolve(text); });
    req.write(body);
    req.end();
  });

// Groq Llama → Gemini Flash → original text
const llmPolish = async (text: string, groqKey: string, geminiKey: string, language: string): Promise<string> => {
  if (text.length < 10) { console.log("[POLISH] Text too short, skipping"); return text; }

  log("[POLISH] Starting. lang:" + language + " Groq:" + !!groqKey + " Gemini:" + !!geminiKey + " text:" + text.slice(0, 60));
  console.log("[POLISH] Starting LLM polish. lang:", language, "Groq key:", !!groqKey, "Gemini key:", !!geminiKey);

  // Try Groq Llama first (same key, fastest)
  if (groqKey) {
    const result = await groqPolish(text, groqKey, language);
    if (result) { log("[POLISH] Groq OK: " + result.slice(0, 80)); return result; }
    log("[POLISH] Groq FAILED, trying Gemini...");
  }

  // Fallback to Gemini
  if (geminiKey) {
    const result = await geminiPolish(text, geminiKey, language);
    console.log("[POLISH] Gemini result:", result ? "OK" : "failed");
    return result;
  }

  console.log("[POLISH] No LLM available, returning raw text");
  return text;
};

/* ── Main transcribe: Groq primary → whisper.cpp fallback ── */

export const transcribe = async (
  config: FlowConfig,
  _audioBase64: string,
  _mimeType: string,
  durationSeconds: number,
  wavBase64?: string
): Promise<DictationResult> => {
  if (!wavBase64) throw new Error("No WAV audio provided");

  const wavBuffer = Buffer.from(wavBase64, "base64");
  log("[STT] START wav=" + wavBuffer.length + " dur=" + durationSeconds + "s");
  console.log("[STT] WAV size:", wavBuffer.length, "bytes, duration:", durationSeconds + "s");

  const hasGroq = !!config.groqApiKey;
  const hasWhisper = isWhisperInstalled();
  console.log("[STT] Providers: Groq=" + hasGroq + ", Whisper.cpp=" + hasWhisper);

  // Try Groq first (fast, accurate)
  if (hasGroq) {
    try {
      const t = Date.now();
      const result = await groqTranscribe(wavBuffer, config.language, config.groqApiKey);
      if (result.text) {
        const detectedLang = result.detectedLang || "auto";
        console.log("[STT] Detected language:", detectedLang);

        // ── Quality filter: reject hallucinations / too quiet / too short ──
        const verdict = filterTranscriptionResult({
          text: result.text,
          language: detectedLang,
          durationMs: Math.round(durationSeconds * 1000),
          audioBuffer: wavBuffer,
        });
        if (!verdict.ok) {
          console.log("[STT] Filtered:", verdict.reason, verdict.detail ?? "");
          throw new Error("No voice detected");
        }

        let text = filterHallucinations(result.text, result.segments);
        text = regexCleanup(text);
        text = processVoiceCommands(text);
        // LLM polish handles accents, grammar, fillers — no need for regex fixFrench
        text = await llmPolish(text, config.groqApiKey, config.geminiApiKey || "", config.language);
        // Check if post-processing left us with empty text (all was hallucinated)
        if (text.trim()) {
          lastTranscript = text;
          return { text, provider: "groq", latencyMs: Date.now() - t, durationSeconds, detectedLang };
        }
        console.log("[STT] Text empty after cleanup, trying fallback...");
      } else {
        console.log("[STT] Groq returned empty text, trying fallback...");
      }
    } catch (err) {
      console.error("[STT] Groq failed:", err instanceof Error ? err.message : err);
    }
  }

  // Fallback: local whisper.cpp
  if (hasWhisper) {
    const t = Date.now();
    console.log("[STT] Using local whisper.cpp" + (hasGroq ? " (fallback)" : " (offline mode)"));
    try {
      let text = await transcribeLocal(wavBuffer, "auto");
      if (text) {
        // Same quality filter on the fallback path — whisper.cpp shares Whisper's hallucination patterns.
        const verdict = filterTranscriptionResult({
          text,
          language: config.language,
          durationMs: Math.round(durationSeconds * 1000),
          audioBuffer: wavBuffer,
        });
        if (!verdict.ok) {
          console.log("[STT] Whisper.cpp filtered:", verdict.reason, verdict.detail ?? "");
          throw new Error("No voice detected");
        }
        text = regexCleanup(text);
        text = processVoiceCommands(text);
        text = await llmPolish(text, config.groqApiKey, config.geminiApiKey || "", config.language);
        lastTranscript = text;
        return { text, provider: "whisper", latencyMs: Date.now() - t, durationSeconds, detectedLang: "auto" };
      }
    } catch (err) {
      console.error("[STT] Whisper.cpp failed:", err instanceof Error ? err.message : err);
    }
  }

  if (!hasGroq && !hasWhisper) {
    throw new Error("No STT provider — set MEETEL_GROQ_KEY or install whisper.cpp");
  }
  throw new Error("No voice detected");
};
