/* ── Types ── */

type MeetelApi = {
  transcribe: (audioBase64: string, mimeType: string, durationSeconds: number, wavBase64?: string) => Promise<{ text?: string; provider?: string; error?: string }>;
  insertText: (text: string) => Promise<{ ok: boolean; error?: string }>;
  getConfig: () => Promise<{ language: string; targetMode: string; micDeviceId?: string; userId?: string }>;
  saveConfig: (cfg: Record<string, unknown>) => Promise<{ ok: boolean }>;
  getUsage: () => Promise<{ minutesUsed: number; minutesRemaining: number; limit: number }>;
  setOpacity: (opacity: number) => Promise<void>;
  setFocusable: (focusable: boolean) => Promise<void>;
  setWindowMode: (mode: string, side?: string) => Promise<{ ok: boolean }>;
  toggleFullscreen: () => Promise<{ fullscreen: boolean }>;
  openExternal: (url: string) => Promise<void>;
  onHotkeyToggle: (cb: () => void) => void;
  ambiverseCreate: (myLang: string) => Promise<{ room: string }>;
  ambiverseJoin: (room: string, myLang: string) => Promise<{ ok: boolean }>;
  ambiverseLeave: () => Promise<{ ok: boolean }>;
  ambiverseSend: (text: string, lang: string) => Promise<{ ok: boolean }>;
  ambiverseStatus: () => Promise<{ connected: boolean; room: string | null }>;
  onAmbiverseReceived: (cb: (data: { text: string; translated: string; fromLang: string }) => void) => void;
};

declare global {
  interface Window { meetelFlow: MeetelApi }
}

/* ── State ── */

let recording = false;
let stream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let actualSampleRate: number = 16000; // Captured at AudioContext creation; Chromium may override the requested rate on M-series Macs.
let scriptNode: ScriptProcessorNode | null = null;
let pcmChunks: Float32Array[] = [];
let settingsOpen = false;
let recordStartTime = 0;
let hasAudioInput = false;
let currentMode: "panel" | "compact" | "island" = "panel";
let currentSide: "left" | "right" = "right";
let islandDurationTimer: ReturnType<typeof setInterval> | null = null;
let isFullscreen = false;
let modeBeforeFullscreen: "panel" | "compact" | "island" = "panel";
let sideBeforeFullscreen: "left" | "right" = "right";
let ambiverseActive = false;
let ambiverseRoom: string | null = null;

/* ── DOM ── */

const $ = (id: string) => document.getElementById(id);
const logoText = document.querySelector(".logo") as HTMLSpanElement;
const micBtn = $("micBtn") as HTMLButtonElement;
const statusText = $("statusText") as HTMLParagraphElement;
const minutesBadge = $("minutesBadge") as HTMLSpanElement;
const settingsToggle = $("settingsToggle") as HTMLButtonElement;
const settingsPanel = $("settingsPanel") as HTMLDivElement;
const micSelect = $("micSelect") as HTMLSelectElement;
const targetModeSelect = $("targetMode") as HTMLSelectElement;
const saveBtn = $("saveBtn") as HTMLButtonElement;
const transcriptList = $("transcriptList") as HTMLDivElement;
const wakeOverlay = $("wakeOverlay") as HTMLDivElement;
const panelToggle = $("panelToggle") as HTMLButtonElement;
const islandCapsule = $("islandCapsule") as HTMLDivElement;
const islandStatus = $("islandStatus") as HTMLSpanElement;
const modeSelector = $("modeSelector") as HTMLDivElement;
const langToggle = $("langToggle") as HTMLButtonElement;
const panelSideField = $("panelSideField") as HTMLDivElement;
const panelSideToggle = $("panelSideToggle") as HTMLDivElement;
const upgradeOverlay = $("upgradeOverlay") as HTMLDivElement;
const upgradeBtn = $("upgradeBtn") as HTMLButtonElement;
const upgradePowerBtn = $("upgradePowerBtn") as HTMLButtonElement;
const upgradeCloseBtn = $("upgradeCloseBtn") as HTMLButtonElement;
const ambiverseBtn = $("ambiverseBtn") as HTMLButtonElement;
const ambiversePanel = $("ambiversePanel") as HTMLDivElement;
const ambiverseRoomCode = $("ambiverseRoomCode") as HTMLSpanElement;
const ambiverseJoinInput = $("ambiverseJoinInput") as HTMLInputElement;
const ambiverseJoinBtn = $("ambiverseJoinBtn") as HTMLButtonElement;
const ambiverseLeaveBtn = $("ambiverseLeaveBtn") as HTMLButtonElement;
const ambiverseTranscripts = $("ambiverseTranscripts") as HTMLDivElement;

/* ── Language Toggle (EN/FR) ── */

let currentLang: "en" | "fr" = "en";

const updateLangUI = (): void => {
  langToggle.textContent = currentLang.toUpperCase();
  langToggle.classList.remove("active-en", "active-fr");
  langToggle.classList.add(currentLang === "en" ? "active-en" : "active-fr");
};

const toggleLang = (): void => {
  currentLang = currentLang === "en" ? "fr" : "en";
  updateLangUI();
  void window.meetelFlow.saveConfig({ language: currentLang });
  playSound("settings");
};

/* ── Idle Fade (OS-level opacity) ── */

let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_DELAY = 5000;

const goIdle = (): void => {
  if (!recording && !settingsOpen) {
    void window.meetelFlow.setOpacity(0.15);
    wakeOverlay.classList.add("active");
  }
};

const wakeUp = (): void => {
  wakeOverlay.classList.remove("active");
  void window.meetelFlow.setOpacity(1);
  resetIdleTimer();
};

const resetIdleTimer = (): void => {
  if (idleTimer) clearTimeout(idleTimer);
  if (!recording && !settingsOpen) {
    idleTimer = setTimeout(goIdle, IDLE_DELAY);
  }
};

/* ── UI State Machine ── */

type UIState = "ready" | "activating" | "listening" | "processing" | "done" | "error";

const setUI = (state: UIState, msg?: string): void => {
  if (state !== "ready") {
    if (idleTimer) clearTimeout(idleTimer);
    wakeOverlay.classList.remove("active");
    void window.meetelFlow.setOpacity(1);
  }

  micBtn.classList.remove("activating", "listening", "processing", "error", "done");
  statusText.classList.remove("activating", "listening", "processing", "error", "done");

  if (state !== "ready") {
    micBtn.classList.add(state);
    statusText.classList.add(state);
  }

  const defaults: Record<UIState, string> = {
    ready: "Ready",
    activating: "Activating...",
    listening: "Listening...",
    processing: "Processing...",
    done: "Done",
    error: "Error",
  };

  statusText.textContent = msg ?? defaults[state];

  if (state === "ready") resetIdleTimer();

  // Update island capsule if active
  if (currentMode === "island") {
    islandCapsule.classList.remove("activating", "recording", "processing");
    if (state === "activating") {
      islandCapsule.classList.add("activating");
      islandStatus.textContent = "Ready...";
    } else if (state === "listening") {
      islandCapsule.classList.add("recording");
      islandStatus.textContent = "Listening";
      startIslandTimer();
    } else if (state === "processing") {
      islandCapsule.classList.add("processing");
      islandStatus.textContent = "Processing";
      stopIslandTimer();
    } else if (state === "done") {
      islandStatus.textContent = msg || "\u2713 Done";
      stopIslandTimer();
    } else if (state === "error") {
      islandStatus.textContent = msg || "Error";
      stopIslandTimer();
    } else {
      islandStatus.textContent = "Ready";
      stopIslandTimer();
    }
  }
};

const resetAfter = (ms: number): void => {
  setTimeout(() => { if (!recording) setUI("ready"); }, ms);
};

/* ── Transcripts (localStorage) ── */

type TranscriptEntry = { text: string; time: number };

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const timeAgo = (ts: number): string => {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const getTranscripts = (): TranscriptEntry[] =>
  JSON.parse(localStorage.getItem("mf_transcripts") || "[]");

const saveTranscript = (text: string): void => {
  const entries = getTranscripts();
  entries.unshift({ text, time: Date.now() });
  if (entries.length > 50) entries.length = 50;
  localStorage.setItem("mf_transcripts", JSON.stringify(entries));
  renderTranscripts();
};

const renderTranscripts = (): void => {
  const entries = getTranscripts();
  if (entries.length === 0) {
    transcriptList.innerHTML = `<div class="transcript-empty">No transcripts yet</div>`;
    return;
  }
  transcriptList.innerHTML = entries.slice(0, 20).map((e) =>
    `<div class="transcript-item">
      <div class="transcript-text">${escapeHtml(e.text)}</div>
      <div class="transcript-time">${timeAgo(e.time)}</div>
    </div>`
  ).join("");
};

/* ── Usage ── */

const refreshUsage = async (): Promise<void> => {
  try {
    const u = await window.meetelFlow.getUsage();
    minutesBadge.textContent = `${Math.max(0, u.minutesRemaining).toFixed(1)} min remaining`;
  } catch {
    minutesBadge.textContent = "unlimited";
  }
};

/* ── Upgrade Overlay ── */

let useOfflineOnly = false;

const showUpgradeOverlay = (): void => {
  upgradeOverlay.style.display = "flex";
  playSound("capsule");
};

const hideUpgradeOverlay = (): void => {
  upgradeOverlay.style.display = "none";
};

upgradeBtn?.addEventListener("click", () => {
  window.meetelFlow.openExternal("https://hub.dasuperhub.com/#plans");
  hideUpgradeOverlay();
});

upgradePowerBtn?.addEventListener("click", () => {
  window.meetelFlow.openExternal("https://hub.dasuperhub.com/#plans");
  hideUpgradeOverlay();
});

upgradeCloseBtn?.addEventListener("click", () => {
  useOfflineOnly = true;
  hideUpgradeOverlay();
  minutesBadge.textContent = "Offline mode (Meetel Slow)";
});

/* ── Audio Normalization (peak normalize to -1dB headroom) ── */

const normalizePcm = (samples: Float32Array): Float32Array => {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  // Normalize to 0.89 peak (-1dB headroom) — research shows this improves WER significantly
  if (peak > 0 && peak < 0.85) {
    const gain = 0.89 / peak;
    const normalized = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      normalized[i] = samples[i] * gain;
    }
    console.log("[NORM] Peak:", peak.toFixed(4), "→ gain:", gain.toFixed(2));
    return normalized;
  }
  return samples; // Already loud enough
};

/* ── WAV encoding (raw PCM → 16-bit WAV) ── */

const encodePcmToWav = (samples: Float32Array, sampleRate: number): Uint8Array => {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);              // PCM
  view.setUint16(22, 1, true);              // mono
  view.setUint32(24, sampleRate, true);     // sample rate
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);             // block align
  view.setUint16(34, 16, true);            // bits per sample
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return new Uint8Array(buffer);
};

const arrayToBase64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
};

/* ── Recording (direct PCM capture — no codec, no conversion) ── */

const SAMPLE_RATE = 16000;

const startRecording = async (): Promise<void> => {
  const deviceId = micSelect.value || undefined;

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
    },
  });

  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  // Chromium on Apple Silicon sometimes overrides the requested sampleRate
  // (known issue on M1–M4). Capture whatever rate we actually got so the WAV
  // header encoded later is accurate — otherwise Groq/Whisper plays the audio
  // at the wrong speed ("chipmunk" effect) and transcription fails.
  actualSampleRate = audioCtx.sampleRate;
  if (actualSampleRate !== SAMPLE_RATE) {
    console.warn(`[REC] AudioContext sampleRate mismatch: requested ${SAMPLE_RATE}, got ${actualSampleRate}. WAV will be labeled at the actual rate.`);
  }
  const source = audioCtx.createMediaStreamSource(stream);

  // ScriptProcessorNode captures raw PCM — no codec needed
  const node = audioCtx.createScriptProcessor(4096, 1, 1);
  pcmChunks = [];
  hasAudioInput = false;

  node.onaudioprocess = (e: AudioProcessingEvent) => {
    const input = e.inputBuffer.getChannelData(0);
    pcmChunks.push(new Float32Array(input));
    // Check if we're getting real audio (not silence)
    if (!hasAudioInput) {
      for (let i = 0; i < input.length; i++) {
        if (Math.abs(input[i]) > 0.01) { hasAudioInput = true; break; }
      }
    }
  };

  source.connect(node);
  node.connect(audioCtx.destination);
  scriptNode = node;

  recording = true;
  recordStartTime = Date.now();
  setUI("listening");
  playSound("record");

  // After 1.5s, if no audio input detected, warn user
  setTimeout(() => {
    if (recording && !hasAudioInput) {
      setUI("error", "No voice detected");
      flashSettingsPurple();
    }
  }, 1500);
};

const stopAndTranscribe = async (): Promise<void> => {
  if (!recording) return;
  recording = false;
  setUI("processing");

  // Let trailing audio buffers flush (fixes last-word truncation)
  await new Promise((r) => setTimeout(r, 600));

  const durationSeconds = Math.round((Date.now() - recordStartTime) / 1000);
  console.log("[REC] Duration:", durationSeconds + "s", "chunks:", pcmChunks.length);

  // Stop audio pipeline
  scriptNode?.disconnect();
  scriptNode = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  void audioCtx?.close();
  audioCtx = null;

  if (durationSeconds < 1 || pcmChunks.length === 0) {
    setUI("error", "Too short");
    resetAfter(2000);
    return;
  }

  // Groq Whisper API caps uploads at 25 MB. At 16 kHz mono PCM16 WAV, that's
  // roughly 13 minutes. Cap at 12 min to stay safe and give the user a clear
  // error instead of a 413 from Groq with no recovery path.
  const MAX_CAPTURE_SECONDS = 12 * 60;
  if (durationSeconds > MAX_CAPTURE_SECONDS) {
    setUI("error", "Too long (max 12 min)");
    pcmChunks = [];
    resetAfter(3000);
    return;
  }

  // Merge PCM chunks into one Float32Array
  const totalLength = pcmChunks.reduce((sum, c) => sum + c.length, 0);
  const allSamples = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of pcmChunks) {
    allSamples.set(chunk, offset);
    offset += chunk.length;
  }
  pcmChunks = [];

  // Check if there's actual audio (not silence)
  let maxAmp = 0;
  for (let i = 0; i < allSamples.length; i++) {
    const abs = Math.abs(allSamples[i]);
    if (abs > maxAmp) maxAmp = abs;
  }
  console.log("[REC] Samples:", totalLength, "max amplitude:", maxAmp.toFixed(4));

  if (maxAmp < 0.01) {
    setUI("error", "Too quiet");
    resetAfter(3000);
    return;
  }

  // Normalize audio (research: reduces WER from 68% to 52%)
  const normalized = normalizePcm(allSamples);

  // Encode to WAV using the ACTUAL captured rate (Chromium on M-series may have
  // overridden the requested 16 kHz — mislabeling would cause chipmunked playback).
  const wavBytes = encodePcmToWav(normalized, actualSampleRate);
  const wavBase64 = arrayToBase64(wavBytes);
  console.log("[FLOW] WAV:", wavBytes.length, "bytes →", wavBase64.length, "base64 chars");

  let result: { text?: string; provider?: string; error?: string };
  try {
    result = await window.meetelFlow.transcribe("", "audio/wav", durationSeconds, wavBase64);
  } catch (e) {
    setUI("error", `STT crash: ${e}`);
    resetAfter(5000);
    return;
  }

  console.log("[FLOW] Result:", JSON.stringify(result));

  if (result.error) {
    setUI("error", result.error);
    resetAfter(4000);
    return;
  }

  if (!result.text) {
    setUI("error", "No speech");
    resetAfter(2000);
    return;
  }

  // Ambi detection: if detected language differs from set language, show glass capsule
  const detectedLang = (result as any).detectedLang || currentLang;
  if (currentMode === "island" && detectedLang !== currentLang && detectedLang !== "auto") {
    islandCapsule.classList.add("ambi");
  } else if (currentMode === "island") {
    islandCapsule.classList.remove("ambi");
  }

  const insertion = await window.meetelFlow.insertText(result.text + " ");

  if (!insertion.ok) {
    setUI("error", insertion.error ?? "Insert failed");
    resetAfter(3000);
    return;
  }

  saveTranscript(result.text);
  setUI("done", `\u2713 ${result.text.slice(0, 40)}`);
  await refreshUsage();
  resetAfter(2000);
};

/* ── Toggle ── */

let lastToggle = 0;
let toggling = false;

const toggle = async (): Promise<void> => {
  const now = Date.now();
  if (now - lastToggle < 400 || toggling) return;
  lastToggle = now;
  toggling = true;

  // Exit settings mode first if open
  if (settingsOpen) {
    stopMicTest();
    settingsOpen = false;
    settingsPanel.classList.remove("open");
    settingsToggle.classList.remove("active");
    document.querySelector(".widget")?.classList.remove("settings-open");
    transcriptList.style.display = "";
    const footer = document.querySelector(".footer") as HTMLElement | null;
    if (footer) footer.style.display = "";
    minutesBadge.parentElement!.style.display = "";
    void window.meetelFlow.setFocusable(false);
  }

  try {
    if (recording) {
      await stopAndTranscribe();
    } else {
      // Check usage before starting cloud transcription
      try {
        const usage = await window.meetelFlow.getUsage();
        if (usage.minutesRemaining <= 0) {
          showUpgradeOverlay();
          toggling = false;
          return;
        }
      } catch { /* proceed if usage check fails */ }

      setUI("activating");
      try {
        await startRecording();
      } catch (err) {
        setUI("error", `Mic: ${err instanceof Error ? err.message : "unavailable"}`);
        resetAfter(4000);
      }
    }
  } finally {
    toggling = false;
  }
};

/* ── Settings + Mic Test Mode ── */

const flashSettingsPurple = (): void => {
  settingsToggle.classList.add("flash");
  setTimeout(() => settingsToggle.classList.remove("flash"), 800);
};

let testStream: MediaStream | null = null;
let testCtx: AudioContext | null = null;
let testAnalyser: AnalyserNode | null = null;
let testRaf = 0;

const startMicTest = async (): Promise<void> => {
  try {
    const deviceId = micSelect.value || undefined;
    testStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined },
    });
    testCtx = new AudioContext();
    const source = testCtx.createMediaStreamSource(testStream);
    testAnalyser = testCtx.createAnalyser();
    testAnalyser.fftSize = 256;
    source.connect(testAnalyser);

    const data = new Uint8Array(testAnalyser.frequencyBinCount);
    const loop = () => {
      if (!testAnalyser) return;
      testAnalyser.getByteFrequencyData(data);
      // Average amplitude
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;

      if (avg > 8) {
        if (!micBtn.classList.contains("mic-test-active")) playSound("micCheck");
        micBtn.classList.add("mic-test-active");
        statusText.textContent = "Mic OK";
        statusText.className = "status-text done";
      } else {
        micBtn.classList.remove("mic-test-active");
        statusText.textContent = "Speak to test...";
        statusText.className = "status-text";
      }
      testRaf = requestAnimationFrame(loop);
    };
    loop();
  } catch {
    statusText.textContent = "Mic unavailable";
    statusText.className = "status-text error";
  }
};

const stopMicTest = (): void => {
  cancelAnimationFrame(testRaf);
  testAnalyser = null;
  testStream?.getTracks().forEach((t) => t.stop());
  testStream = null;
  void testCtx?.close();
  testCtx = null;
  micBtn.classList.remove("mic-test-active");
};

const toggleSettings = (): void => {
  settingsOpen = !settingsOpen;
  playSound("settings");
  settingsPanel.classList.toggle("open", settingsOpen);
  settingsToggle.classList.toggle("active", settingsOpen);
  // Toggle widget scroll + hide unneeded elements when settings open
  document.querySelector(".widget")?.classList.toggle("settings-open", settingsOpen);
  transcriptList.style.display = settingsOpen ? "none" : "";
  const footer = document.querySelector(".footer") as HTMLElement | null;
  if (footer) footer.style.display = settingsOpen ? "none" : "";
  minutesBadge.parentElement!.style.display = settingsOpen ? "none" : "";

  // Make window focusable for settings interaction, unfocusable otherwise
  void window.meetelFlow.setFocusable(settingsOpen);

  if (settingsOpen && !recording) {
    void startMicTest();
  } else {
    stopMicTest();
    if (!recording) setUI("ready");
  }
  wakeUp();
};

const loadSettings = async (): Promise<void> => {
  const cfg = await window.meetelFlow.getConfig();
  targetModeSelect.value = cfg.targetMode;
  if (cfg.micDeviceId) micSelect.value = cfg.micDeviceId;
};

const saveSettings = async (): Promise<void> => {
  await window.meetelFlow.saveConfig({
    language: currentLang,
    targetMode: targetModeSelect.value,
    micDeviceId: micSelect.value || undefined,
  });
  saveBtn.textContent = "Saved!";
  saveBtn.style.background = "rgba(124, 58, 237, 0.8)";
  setTimeout(() => { saveBtn.textContent = "Save"; saveBtn.style.background = ""; }, 1200);
};

/* ── Mic enumeration ── */

const populateMics = async (): Promise<void> => {
  try {
    // Request mic access to get labels
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    const defaultTrack = tmp.getAudioTracks()[0];
    const defaultDeviceLabel = defaultTrack?.label || "";
    tmp.getTracks().forEach((t) => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");

    console.log("[MIC] Found", mics.length, "mics. System default track:", defaultDeviceLabel);

    // Update the "System Default" option to show which device it actually is
    const defaultOpt = micSelect.querySelector('option[value=""]');
    if (defaultOpt && defaultDeviceLabel) {
      defaultOpt.textContent = `System Default (${defaultDeviceLabel})`;
    }

    mics.forEach((mic) => {
      const opt = document.createElement("option");
      opt.value = mic.deviceId;
      opt.textContent = mic.label || `Mic ${mic.deviceId.slice(0, 8)}`;
      // Mark which one the system considers "default"
      if (mic.deviceId === "default" || mic.label === defaultDeviceLabel) {
        opt.textContent += " \u2713";
      }
      micSelect.appendChild(opt);
    });

    // Restore saved mic selection
    const cfg = await window.meetelFlow.getConfig();
    if (cfg.micDeviceId) micSelect.value = cfg.micDeviceId;

    // Auto-save when mic changes + restart test if in settings
    micSelect.addEventListener("change", () => {
      console.log("[MIC] Changed to:", micSelect.value, micSelect.selectedOptions[0]?.textContent);
      void window.meetelFlow.saveConfig({ micDeviceId: micSelect.value || undefined });
      if (settingsOpen) {
        stopMicTest();
        void startMicTest();
      }
    });

    setUI("ready");
  } catch (err) {
    setUI("error", `Mic access denied: ${err instanceof Error ? err.message : "check permissions"}`);
  }
};

/* ── Mode Switching ── */

const switchToIsland = (): void => {
  currentMode = "island";
  document.body.classList.remove("panel-mode", "fullscreen-mode");
  document.body.classList.add("island-mode");
  playSound("capsule");
  // Hide normal UI, show capsule
  document.querySelectorAll(".widget > *:not(.island-capsule)").forEach(el => {
    (el as HTMLElement).style.display = "none";
  });
  islandCapsule.style.display = "flex";
  void window.meetelFlow.setWindowMode("island");
  updateModeSelectorUI();
  resetIdleTimer();
};

const switchToCompact = (): void => {
  currentMode = "compact";
  document.body.classList.remove("panel-mode", "island-mode", "fullscreen-mode");
  exitIslandMode();
  playSound("modeChange");
  void window.meetelFlow.setWindowMode("compact");
  updateModeSelectorUI();
  showCapsuleHint();
};

const switchToPanel = (side?: "left" | "right"): void => {
  currentMode = "panel";
  currentSide = side || currentSide;
  document.body.classList.remove("island-mode", "fullscreen-mode");
  document.body.classList.add("panel-mode");
  playSound("modeChange");
  exitIslandMode();
  void window.meetelFlow.setWindowMode("panel", currentSide);
  updateModeSelectorUI();
};

const exitIslandMode = (): void => {
  islandCapsule.style.display = "none";
  document.body.classList.remove("island-mode");
  // Show all widget children, respecting settings state
  document.querySelectorAll(".widget > *:not(.island-capsule)").forEach(el => {
    const htmlEl = el as HTMLElement;
    if (htmlEl.id === "settingsPanel") {
      htmlEl.style.display = "";
    } else if (htmlEl.id === "transcriptList") {
      htmlEl.style.display = settingsOpen ? "none" : "";
    } else if (htmlEl.classList.contains("footer") || htmlEl.classList.contains("minutes-badge")) {
      htmlEl.style.display = settingsOpen ? "none" : "";
    } else {
      htmlEl.style.display = "";
    }
  });
  stopIslandTimer();
};

const updateModeSelectorUI = (): void => {
  modeSelector?.querySelectorAll(".mode-option").forEach(btn => {
    (btn as HTMLElement).classList.toggle("selected", (btn as HTMLElement).dataset.mode === currentMode);
  });
  panelSideField?.classList.toggle("hidden", currentMode !== "panel");
  panelSideToggle?.querySelectorAll(".side-btn").forEach(btn => {
    (btn as HTMLElement).classList.toggle("selected", (btn as HTMLElement).dataset.side === currentSide);
  });
};

const startIslandTimer = (): void => {
  stopIslandTimer();
  islandDurationTimer = setInterval(() => {
    if (recording && currentMode === "island") {
      const s = ((Date.now() - recordStartTime) / 1000).toFixed(1);
      islandStatus.textContent = s + "s";
    }
  }, 100);
};

const stopIslandTimer = (): void => {
  if (islandDurationTimer) { clearInterval(islandDurationTimer); islandDurationTimer = null; }
};

/* ── Transcript Gestures ── */

const setupTranscriptGestures = (): void => {
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let deleteTarget: HTMLElement | null = null;

  transcriptList.addEventListener("click", (e: Event) => {
    const item = (e.target as HTMLElement).closest(".transcript-item") as HTMLElement | null;
    if (!item) return;

    // If in delete-confirm state, execute delete
    if (item.classList.contains("delete-confirm")) {
      const idx = Array.from(transcriptList.querySelectorAll(".transcript-item")).indexOf(item);
      if (idx >= 0) {
        const entries = getTranscripts();
        entries.splice(idx, 1);
        localStorage.setItem("mf_transcripts", JSON.stringify(entries));
        renderTranscripts();
      }
      deleteTarget = null;
      return;
    }

    // Clear any other delete-confirm
    if (deleteTarget) {
      deleteTarget.classList.remove("delete-confirm");
      deleteTarget = null;
    }

    // Copy to clipboard
    const text = item.querySelector(".transcript-text")?.textContent || "";
    void navigator.clipboard.writeText(text);
    item.classList.add("copied");
    const badge = document.createElement("span");
    badge.className = "transcript-copied-badge";
    badge.textContent = "Copied";
    item.appendChild(badge);
    setTimeout(() => { item.classList.remove("copied"); badge.remove(); }, 700);
  });

  // Long press for delete
  transcriptList.addEventListener("pointerdown", (e: PointerEvent) => {
    const item = (e.target as HTMLElement).closest(".transcript-item") as HTMLElement | null;
    if (!item) return;
    pressTimer = setTimeout(() => {
      // Clear previous
      if (deleteTarget) deleteTarget.classList.remove("delete-confirm");
      item.classList.add("delete-confirm");
      deleteTarget = item;
    }, 600);
  });

  transcriptList.addEventListener("pointerup", () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  });

  transcriptList.addEventListener("pointerleave", () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  });
};

/* ── Premium Haptic Sounds ── */

const playSound = (type: "record" | "modeChange" | "fullscreen" | "capsule" | "settings" | "micCheck"): void => {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    if (type === "record") {
      // "dddouuudup" — warm double-tap confirmation
      const o1 = ctx.createOscillator();
      o1.type = "sine";
      o1.frequency.setValueAtTime(320, ctx.currentTime);
      o1.frequency.exponentialRampToValueAtTime(480, ctx.currentTime + 0.06);
      o1.frequency.exponentialRampToValueAtTime(380, ctx.currentTime + 0.1);
      o1.frequency.exponentialRampToValueAtTime(580, ctx.currentTime + 0.16);
      o1.connect(gain);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
      o1.start(ctx.currentTime);
      o1.stop(ctx.currentTime + 0.22);
    } else if (type === "modeChange") {
      // "suuuwop" — smooth glide sweep
      const o1 = ctx.createOscillator();
      o1.type = "sine";
      o1.frequency.setValueAtTime(280, ctx.currentTime);
      o1.frequency.exponentialRampToValueAtTime(620, ctx.currentTime + 0.12);
      o1.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.18);
      o1.connect(gain);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      o1.start(ctx.currentTime);
      o1.stop(ctx.currentTime + 0.2);
    } else if (type === "fullscreen") {
      // "zzup" — quick expansion zip
      const o1 = ctx.createOscillator();
      o1.type = "triangle";
      o1.frequency.setValueAtTime(200, ctx.currentTime);
      o1.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.08);
      o1.connect(gain);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      o1.start(ctx.currentTime);
      o1.stop(ctx.currentTime + 0.12);
    } else if (type === "capsule") {
      // "Toun" — deep resonant tap
      const o1 = ctx.createOscillator();
      o1.type = "sine";
      o1.frequency.setValueAtTime(520, ctx.currentTime);
      o1.frequency.exponentialRampToValueAtTime(260, ctx.currentTime + 0.15);
      o1.connect(gain);
      gain.gain.setValueAtTime(0.13, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      o1.start(ctx.currentTime);
      o1.stop(ctx.currentTime + 0.2);
    }

    if (type === "settings") {
      // Soft click — subtle tick
      const o1 = ctx.createOscillator();
      o1.type = "sine";
      o1.frequency.setValueAtTime(800, ctx.currentTime);
      o1.frequency.exponentialRampToValueAtTime(500, ctx.currentTime + 0.05);
      o1.connect(gain);
      gain.gain.setValueAtTime(0.07, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
      o1.start(ctx.currentTime);
      o1.stop(ctx.currentTime + 0.06);
    } else if (type === "micCheck") {
      // Quick bright ping
      const o1 = ctx.createOscillator();
      o1.type = "sine";
      o1.frequency.setValueAtTime(660, ctx.currentTime);
      o1.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.06);
      o1.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.1);
      o1.connect(gain);
      gain.gain.setValueAtTime(0.09, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      o1.start(ctx.currentTime);
      o1.stop(ctx.currentTime + 0.12);
    }

    setTimeout(() => ctx.close(), 500);
  } catch { /* audio not available */ }
};

/* ── Ambiverse TTS ── */

const speakText = (text: string, lang: string): void => {
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang === "fr" ? "fr-FR" : lang === "es" ? "es-ES" : lang === "de" ? "de-DE" : "en-US";
    utterance.rate = 1.0;
    utterance.volume = 0.8;
    speechSynthesis.speak(utterance);
  } catch { /* TTS not available */ }
};

/* ── Capsule Hint ── */

const showCapsuleHint = (): void => {
  const existing = document.querySelector(".capsule-hint");
  if (existing) existing.remove();
  const hint = document.createElement("span");
  hint.className = "capsule-hint";
  hint.textContent = "Hold for capsule";
  panelToggle.parentElement?.appendChild(hint);
  setTimeout(() => hint.remove(), 2000);
};

/* ── Boot ── */

const boot = async (): Promise<void> => {
  micBtn.addEventListener("click", () => void toggle());
  settingsToggle.addEventListener("click", toggleSettings);
  langToggle.addEventListener("click", toggleLang);
  saveBtn.addEventListener("click", () => void saveSettings());
  window.meetelFlow.onHotkeyToggle(() => void toggle());

  wakeOverlay.addEventListener("pointerdown", wakeUp);
  window.addEventListener("resize", () => wakeUp());

  await populateMics();
  await loadSettings();
  await refreshUsage();

  // Load saved language for toggle
  const langCfg = await window.meetelFlow.getConfig();
  if (langCfg.language === "fr") currentLang = "fr";
  updateLangUI();
  renderTranscripts();

  // Start unfocusable — clicking the widget won't steal focus from other apps
  void window.meetelFlow.setFocusable(false);

  // Panel toggle: tap cycles R→L→compact, hold 2s = capsule
  let panelPressTimer: ReturnType<typeof setTimeout> | null = null;
  let panelLongPressed = false;

  panelToggle.addEventListener("pointerdown", () => {
    panelLongPressed = false;
    panelPressTimer = setTimeout(() => {
      panelLongPressed = true;
      switchToIsland();
    }, 2000);
  });

  panelToggle.addEventListener("pointerup", () => {
    if (panelPressTimer) { clearTimeout(panelPressTimer); panelPressTimer = null; }
    if (!panelLongPressed) {
      if (currentMode === "island") {
        // Exit capsule back to panel
        switchToPanel();
      } else if (currentMode === "panel" && currentSide === "right") {
        switchToPanel("left");
      } else if (currentMode === "panel" && currentSide === "left") {
        switchToCompact();
      } else {
        // From compact, cycle back to panel right
        switchToPanel("right");
      }
      wakeUp();
    }
  });

  panelToggle.addEventListener("pointerleave", () => {
    if (panelPressTimer) { clearTimeout(panelPressTimer); panelPressTimer = null; }
  });

  // Double tap anywhere = fullscreen toggle
  // Use pointerdown (not mousedown) — it fires even on drag regions
  let lastWidgetTap = 0;
  const widget = document.querySelector(".widget") as HTMLElement;
  widget.addEventListener("pointerdown", (e: PointerEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest("button, select, input, .transcript-item, .settings-panel.open")) return;
    const now = Date.now();
    if (now - lastWidgetTap < 350) {
      lastWidgetTap = 0;
      e.preventDefault();
      if (!isFullscreen) {
        // Save current state
        modeBeforeFullscreen = currentMode;
        sideBeforeFullscreen = currentSide;
        // Exit island if needed
        if (currentMode === "island") {
          exitIslandMode();
          document.body.classList.remove("island-mode");
        }
        document.body.classList.remove("panel-mode", "island-mode");
        document.body.classList.add("fullscreen-mode");
        isFullscreen = true;
        playSound("fullscreen");
        void window.meetelFlow.toggleFullscreen();
      } else {
        // Double-click from fullscreen → always go to capsule
        document.body.classList.remove("fullscreen-mode");
        isFullscreen = false;
        void window.meetelFlow.toggleFullscreen();
        setTimeout(() => switchToIsland(), 100);
      }
    } else {
      lastWidgetTap = now;
    }
  });

  // Island capsule click = toggle recording
  islandCapsule.addEventListener("click", () => void toggle());

  // Mode selector in settings
  modeSelector?.addEventListener("click", (e: Event) => {
    const btn = (e.target as HTMLElement).closest(".mode-option") as HTMLElement | null;
    if (!btn) return;
    const mode = btn.dataset.mode as "panel" | "compact" | "island";
    if (!mode) return;
    if (mode === "panel") switchToPanel();
    else if (mode === "island") switchToIsland();
    else {
      switchToCompact();
    }
  });

  // Panel side selector
  panelSideToggle?.addEventListener("click", (e: Event) => {
    const btn = (e.target as HTMLElement).closest(".side-btn") as HTMLElement | null;
    if (!btn) return;
    const side = btn.dataset.side as "left" | "right";
    if (side) switchToPanel(side);
  });

  // Load saved mode
  const savedCfg = await window.meetelFlow.getConfig();
  currentMode = (savedCfg as any).viewMode || "panel";
  currentSide = (savedCfg as any).panelSide || "right";
  updateModeSelectorUI();

  // Transcript gestures
  setupTranscriptGestures();

  // Ambiverse controls
  const enterAmbi = (): void => {
    logoText.textContent = "Meetel Ambi";
    logoText.classList.add("ambi-mode");
  };

  const exitAmbi = (): void => {
    logoText.textContent = "Meetel Flow";
    logoText.classList.remove("ambi-mode");
  };

  ambiverseBtn?.addEventListener("click", async () => {
    if (ambiverseActive) {
      // Leave
      await window.meetelFlow.ambiverseLeave();
      ambiverseActive = false;
      ambiverseRoom = null;
      ambiversePanel.classList.remove("active");
      ambiverseBtn.classList.remove("active");
      islandCapsule.classList.remove("ambiverse");
      ambiverseTranscripts.innerHTML = "";
      exitAmbi();
      playSound("capsule");
    } else {
      // Create room
      const result = await window.meetelFlow.ambiverseCreate(currentLang);
      ambiverseRoom = result.room;
      ambiverseActive = true;
      ambiversePanel.classList.add("active");
      ambiverseBtn.classList.add("active");
      ambiverseRoomCode.textContent = result.room;
      islandCapsule.classList.add("ambiverse");
      void window.meetelFlow.setFocusable(true);
      enterAmbi();
      playSound("capsule");
    }
  });

  ambiverseJoinBtn?.addEventListener("click", async () => {
    const code = ambiverseJoinInput.value.trim();
    if (code.length !== 4) return;
    await window.meetelFlow.ambiverseJoin(code, currentLang);
    ambiverseRoom = code;
    ambiverseActive = true;
    ambiverseBtn.classList.add("active");
    ambiverseRoomCode.textContent = code;
    islandCapsule.classList.add("ambiverse");
    ambiverseJoinInput.value = "";
    enterAmbi();
    playSound("capsule");
  });

  ambiverseLeaveBtn?.addEventListener("click", async () => {
    await window.meetelFlow.ambiverseLeave();
    ambiverseActive = false;
    ambiverseRoom = null;
    ambiversePanel.classList.remove("active");
    ambiverseBtn.classList.remove("active");
    islandCapsule.classList.remove("ambiverse");
    ambiverseTranscripts.innerHTML = "";
    exitAmbi();
    void window.meetelFlow.setFocusable(false);
    playSound("capsule");
  });

  // Listen for incoming Ambiverse transcripts
  window.meetelFlow.onAmbiverseReceived((data) => {
    console.log("[AMBIVERSE] Received:", data.fromLang, data.translated.slice(0, 50));

    // TTS — speak the translated text
    speakText(data.translated, currentLang);

    // Show in Ambiverse transcript panel
    const entry = document.createElement("div");
    entry.className = "ambiverse-entry";
    entry.innerHTML = `
      <div class="ambiverse-original">${escapeHtml(data.text)}</div>
      <div class="ambiverse-translated">${escapeHtml(data.translated)}</div>
      <div class="ambiverse-lang">${data.fromLang.toUpperCase()}</div>
    `;
    ambiverseTranscripts.prepend(entry);

    // Also show in island status
    if (currentMode === "island") {
      islandStatus.textContent = data.translated.slice(0, 30);
    }

    // Save to transcript list too
    saveTranscript(`[${data.fromLang.toUpperCase()}] ${data.translated}`);
  });
};

void boot();

export {};
