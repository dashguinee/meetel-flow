export type DictationState = "idle" | "listening" | "processing" | "error";

export type ViewMode = "panel" | "compact" | "island";
export type PanelSide = "left" | "right";

export type FlowConfig = {
  groqApiKey: string;
  geminiApiKey?: string;
  language: "en" | "fr"; // User toggle — locks Whisper + LLM to selected language
  targetMode: "type" | "clipboard";
  micDeviceId?: string;
  userId?: string;
  viewMode?: ViewMode;
  panelSide?: PanelSide;
  // Onboarding + identity
  firstRunComplete?: boolean;
  firstDictationSkipped?: boolean;
  userEmail?: string;
  userName?: string;
  // Telemetry
  telemetryEnabled?: boolean;
  analyticsConsentAt?: string;
};

export type DictationResult = {
  text: string;
  provider: "groq" | "whisper";
  latencyMs: number;
  durationSeconds: number;
  detectedLang?: string;
};
