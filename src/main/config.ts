import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FlowConfig } from "./types";

const CONFIG_DIR = path.join(os.homedir(), ".meetel-flow");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const BAKED_GROQ = process.env.MEETEL_GROQ_KEY || "";
const BAKED_GEMINI = process.env.MEETEL_GEMINI_KEY || "";

const defaults: FlowConfig = {
  groqApiKey: BAKED_GROQ,
  geminiApiKey: BAKED_GEMINI,
  language: "auto",
  targetMode: "type",
  viewMode: "panel",
  panelSide: "right",
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
