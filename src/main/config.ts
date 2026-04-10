import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlowConfig } from "./types";

const CONFIG_DIR = path.join(os.homedir(), ".meetel-flow");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// Load keys from: env vars → .meetel-flow/.env → empty
const loadEnvKeys = (): { groq: string; gemini: string } => {
  if (process.env.MEETEL_GROQ_KEY) {
    return { groq: process.env.MEETEL_GROQ_KEY, gemini: process.env.MEETEL_GEMINI_KEY || "" };
  }
  // Try loading from ~/.meetel-flow/.env
  const envPath = path.join(CONFIG_DIR, ".env");
  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      const groq = content.match(/MEETEL_GROQ_KEY=(.+)/)?.[1]?.trim() || "";
      const gemini = content.match(/MEETEL_GEMINI_KEY=(.+)/)?.[1]?.trim() || "";
      if (groq) return { groq, gemini };
    }
  } catch { /* ignore */ }
  return { groq: "", gemini: "" };
};

const envKeys = loadEnvKeys();
const BAKED_GROQ = envKeys.groq;
const BAKED_GEMINI = envKeys.gemini;

const defaults: FlowConfig = {
  groqApiKey: BAKED_GROQ,
  geminiApiKey: BAKED_GEMINI,
  language: "en",
  targetMode: "type",
  viewMode: "panel",
  panelSide: "right",
  firstRunComplete: false,
  telemetryEnabled: true,
};

export const loadConfig = (): FlowConfig => {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...defaults };
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Partial<FlowConfig>;
    return {
      ...defaults,
      ...parsed,
      groqApiKey: parsed.groqApiKey || BAKED_GROQ,
      geminiApiKey: parsed.geminiApiKey || BAKED_GEMINI,
    };
  } catch {
    return { ...defaults };
  }
};

export const saveConfig = (next: Partial<FlowConfig>): void => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const current = loadConfig();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...current, ...next }, null, 2), "utf-8");
};
