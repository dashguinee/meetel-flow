export type DictationState = "idle" | "listening" | "processing" | "error";

export type ViewMode = "panel" | "compact" | "island";
export type PanelSide = "left" | "right";

export type FlowConfig = {
  groqApiKey: string;
  geminiApiKey?: string;
  language: "en" | "fr" | "auto";
  targetMode: "type" | "clipboard";
  micDeviceId?: string;
  userId?: string;
  viewMode?: ViewMode;
  panelSide?: PanelSide;
};

export type DictationResult = {
  text: string;
  provider: "groq" | "gemini";
  latencyMs: number;
  durationSeconds: number;
};
