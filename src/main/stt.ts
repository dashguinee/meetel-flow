import { execFile } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { FlowConfig, DictationResult } from "./types";

/* ── Groq Whisper API (primary — fast, accurate, $0.04/hr) ── */

const groqTranscribe = (wavBuffer: Buffer, language: string, apiKey: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const lang = language === "auto" ? undefined : language;

    // Build multipart form data manually (no deps)
    const boundary = "----MeetelBoundary" + Date.now();
    const parts: Buffer[] = [];

    // File part
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
    ));
    parts.push(wavBuffer);
    parts.push(Buffer.from("\r\n"));

    // Model part
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n`
    ));

    // Language part (if specified)
    if (lang) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${lang}\r\n`
      ));
    }

    // Response format
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`
    ));

    // Prompt — guides model, reduces hallucinations on short/quiet audio
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nTranscribe the spoken words exactly as said. This is a dictation for typing into documents, emails, and messages.\r\n`
    ));

    // Temperature — deterministic output
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
      timeout: 15000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      res.on("end", () => {
        console.log("[GROQ] Status:", res.statusCode, "Body:", data.slice(0, 200));
        if (res.statusCode !== 200) {
          reject(new Error(`Groq ${res.statusCode}: ${data.slice(0, 100)}`));
          return;
        }
        try {
          const json = JSON.parse(data) as { text?: string };
          resolve(json.text?.trim() || "");
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
    const args = [
      "-m", WHISPER_MODEL,
      "-f", tmpFile,
      "-l", lang,
      "--no-timestamps",
      "-t", "4",
      "--print-special", "false",
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
  console.log("[STT] WAV size:", wavBuffer.length, "bytes, duration:", durationSeconds + "s");

  // Try Groq first (fast, accurate)
  if (config.groqApiKey) {
    try {
      const t = Date.now();
      const text = await groqTranscribe(wavBuffer, config.language, config.groqApiKey);
      if (text) {
        return { text, provider: "groq", latencyMs: Date.now() - t, durationSeconds };
      }
      console.log("[STT] Groq returned empty text, trying fallback...");
    } catch (err) {
      console.error("[STT] Groq failed:", err instanceof Error ? err.message : err);
    }
  }

  // Fallback: local whisper.cpp
  if (isWhisperInstalled()) {
    const t = Date.now();
    console.log("[STT] Falling back to local whisper.cpp");
    const text = await transcribeLocal(wavBuffer, config.language);
    if (text) {
      return { text, provider: "gemini", latencyMs: Date.now() - t, durationSeconds };
    }
  }

  throw new Error("Transcription failed — no provider returned text");
};
