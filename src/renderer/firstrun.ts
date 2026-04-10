// ── Meetel Flow — First-Run Wizard State Machine ──
//
// Standalone entrypoint for firstrun.html. This file drives the 6-screen
// onboarding flow. It does NOT touch renderer.ts or any main-process code.
//
// IPC surface consumed (exposed via preload.ts by main; see FIRSTRUN_INTEGRATION.md):
//   window.meetelFirstRun.createUser({ name, email })   -> Promise<{ ok; userId?; error? }>
//   window.meetelFirstRun.requestMicPermission()        -> Promise<{ granted: boolean }>
//   window.meetelFirstRun.testHotkey()                  -> Promise<{ detected: boolean }>
//   window.meetelFirstRun.onDictationSuccess(cb)        -> void  (fires once on first successful dictation)
//   window.meetelFirstRun.skipFirstDictation()          -> Promise<void>
//   window.meetelFirstRun.markComplete()                -> Promise<void>  (persists flag + closes window)
//
// This wizard is rendered in its own BrowserWindow; on completion main swaps
// to the main capsule window (see FIRSTRUN_INTEGRATION.md).

type ScreenId = 1 | 2 | 3 | 4 | 5 | 6;

interface CreateUserResult {
  ok: boolean;
  userId?: string;
  error?: string;
}

interface MicPermissionResult {
  granted: boolean;
}

interface HotkeyResult {
  detected: boolean;
}

interface MeetelFirstRunAPI {
  createUser(payload: { name: string; email: string }): Promise<CreateUserResult>;
  requestMicPermission(): Promise<MicPermissionResult>;
  armHotkeyTeach(): Promise<{ ok: boolean }>;
  disarmHotkeyTeach(): Promise<{ ok: boolean }>;
  onDictationSuccess(cb: () => void): void;
  onHotkeyFired(cb: () => void): void;
  skipFirstDictation(): Promise<void>;
  markComplete(): Promise<void>;
}

declare global {
  interface Window {
    meetelFirstRun: MeetelFirstRunAPI;
  }
}

// Local handle for the meetelFlow API (declared in renderer.ts). The wizard's
// preload exposes the same global, so we cast to the subset we actually use.
type MeetelFlowSubset = {
  transcribe: (
    audioBase64: string,
    mimeType: string,
    durationSeconds: number,
    wavBase64?: string,
  ) => Promise<{ text?: string; provider?: string; error?: string }>;
};

const meetelFlow: MeetelFlowSubset = (window as unknown as { meetelFlow: MeetelFlowSubset }).meetelFlow;

// ── DOM helpers ──────────────────────────────────────────────────────────────

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[firstrun] missing element #${id}`);
  return el as T;
}

function $$<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

// ── State ────────────────────────────────────────────────────────────────────

interface WizardState {
  current: ScreenId;
  name: string;
  email: string;
  userId: string | null;
  micGranted: boolean;
  hotkeyDetected: boolean;
  dictationDone: boolean;
}

const state: WizardState = {
  current: 1,
  name: "",
  email: "",
  userId: null,
  micGranted: false,
  hotkeyDetected: false,
  dictationDone: false,
};

// ── Screen navigation ────────────────────────────────────────────────────────

function goTo(next: ScreenId): void {
  if (next === state.current) return;
  const screens = $$<HTMLElement>(".fr-screen");
  const currentEl = screens.find((s) => Number(s.dataset.screen) === state.current) ?? null;
  const nextEl = screens.find((s) => Number(s.dataset.screen) === next) ?? null;
  if (!nextEl) return;

  if (currentEl) {
    currentEl.classList.remove("is-active");
    currentEl.classList.add("is-leaving");
    window.setTimeout(() => currentEl.classList.remove("is-leaving"), 320);
  }
  nextEl.classList.add("is-active");
  state.current = next;
  updateProgress();
  onEnterScreen(next);
}

function updateProgress(): void {
  const dots = $$<HTMLElement>(".fr-dot");
  for (const dot of dots) {
    const step = Number(dot.dataset.step);
    dot.classList.remove("is-done", "is-current");
    if (step < state.current) dot.classList.add("is-done");
    else if (step === state.current) dot.classList.add("is-current");
  }
}

function onEnterScreen(id: ScreenId): void {
  switch (id) {
    case 2: {
      const nameInput = document.getElementById("frName") as HTMLInputElement | null;
      window.setTimeout(() => nameInput?.focus(), 360);
      break;
    }
    case 4:
      armHotkeyListener();
      break;
    case 5:
      armFirstDictation();
      break;
    default:
      break;
  }
}

// ── Screen 2: Identity validation + submit ──────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(raw: string): string | null {
  const email = raw.trim();
  if (!email) return "Email is required.";
  if (!EMAIL_RE.test(email)) return "That doesn't look like a valid email.";
  return null;
}

async function submitIdentity(): Promise<void> {
  const nameInput = $<HTMLInputElement>("frName");
  const emailInput = $<HTMLInputElement>("frEmail");
  const errorLabel = $<HTMLSpanElement>("frEmailError");

  const email = emailInput.value.trim();
  const err = validateEmail(email);
  if (err) {
    emailInput.classList.add("is-error");
    errorLabel.textContent = err;
    emailInput.focus();
    return;
  }
  emailInput.classList.remove("is-error");
  errorLabel.textContent = "";

  state.name = nameInput.value.trim();
  state.email = email;

  const submitBtn = document.querySelector<HTMLButtonElement>('[data-action="submit-identity"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating account...";
  }

  try {
    const result = await window.meetelFirstRun.createUser({ name: state.name, email: state.email });
    if (!result.ok) {
      errorLabel.textContent = result.error ?? "Could not create account. Try again.";
      emailInput.classList.add("is-error");
      return;
    }
    state.userId = result.userId ?? null;
    goTo(3);
  } catch (e) {
    errorLabel.textContent = e instanceof Error ? e.message : "Network error. Try again.";
    emailInput.classList.add("is-error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Continue";
    }
  }
}

// ── Screen 3: Microphone permission ─────────────────────────────────────────

function setMicState(next: "pending" | "granted" | "denied"): void {
  const visual = $<HTMLElement>("frMicVisual");
  const status = $<HTMLElement>("frMicStatus");
  const grantBtn = $<HTMLButtonElement>("frMicGrantBtn");
  const continueBtn = $<HTMLButtonElement>("frMicContinueBtn");
  const help = $<HTMLElement>("frMicDeniedHelp");

  visual.dataset.state = next;
  switch (next) {
    case "pending":
      status.textContent = "Not granted yet";
      grantBtn.hidden = false;
      grantBtn.textContent = "Grant Microphone Access";
      continueBtn.hidden = true;
      help.hidden = true;
      break;
    case "granted":
      status.textContent = "Microphone access granted";
      grantBtn.hidden = true;
      continueBtn.hidden = false;
      help.hidden = true;
      state.micGranted = true;
      break;
    case "denied":
      status.textContent = "Access denied";
      grantBtn.hidden = false;
      grantBtn.textContent = "Check again";
      continueBtn.hidden = true;
      help.hidden = false;
      state.micGranted = false;
      break;
  }
}

async function requestMic(): Promise<void> {
  const grantBtn = $<HTMLButtonElement>("frMicGrantBtn");
  grantBtn.disabled = true;
  grantBtn.textContent = "Requesting...";
  try {
    const result = await window.meetelFirstRun.requestMicPermission();
    setMicState(result.granted ? "granted" : "denied");
  } catch {
    setMicState("denied");
  } finally {
    grantBtn.disabled = false;
  }
}

// ── Screen 4: Hotkey detection ──────────────────────────────────────────────

let hotkeyListenerActive = false;

function armHotkeyListener(): void {
  if (hotkeyListenerActive) return;
  hotkeyListenerActive = true;

  const keyboard = $<HTMLElement>("frKeyboard");
  const ctrlKey = $<HTMLElement>("frKeyCtrl");
  const spaceKey = $<HTMLElement>("frKeySpace");
  const hint = $<HTMLElement>("frHotkeyHint");
  const nextBtn = $<HTMLButtonElement>("frHotkeyNextBtn");
  const manualBtn = document.getElementById("frHotkeyManualBtn") as HTMLButtonElement | null;

  // Tell main to release the global Control+Space shortcut while this screen
  // is open, so the chord lands on our in-window keydown listener instead of
  // being eaten by the OS-level RegisterHotKey.
  void window.meetelFirstRun.armHotkeyTeach();

  // In-window keyboard listener: detects the chord directly (works because we
  // armed/released the global shortcut above).
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "ControlLeft" || e.code === "ControlRight") ctrlKey.classList.add("is-down");
    if (e.code === "Space") {
      spaceKey.classList.add("is-down");
      if (e.ctrlKey) {
        e.preventDefault();
        confirmHotkey();
      }
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "ControlLeft" || e.code === "ControlRight") ctrlKey.classList.remove("is-down");
    if (e.code === "Space") spaceKey.classList.remove("is-down");
  };

  // Backup path: if the wizard window is NOT focused when the user presses
  // the chord, the global shortcut may still be active (or get re-registered)
  // and main will forward the IPC. Subscribe so we don't miss it.
  window.meetelFirstRun.onHotkeyFired(() => {
    confirmHotkey();
  });

  function confirmHotkey(): void {
    if (state.hotkeyDetected) return;
    state.hotkeyDetected = true;
    keyboard.classList.add("is-detected");
    hint.textContent = "Perfect. Hotkey detected.";
    hint.classList.add("is-ok");
    nextBtn.disabled = false;
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    // Re-arm the global shortcut now that we're done teaching it.
    void window.meetelFirstRun.disarmHotkeyTeach();
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  // Safety valve: after 8 seconds, surface a manual "I pressed it" button so
  // the user is never stuck if hotkey detection fails for any reason.
  if (manualBtn) {
    window.setTimeout(() => {
      if (!state.hotkeyDetected) manualBtn.hidden = false;
    }, 8_000);
    manualBtn.addEventListener("click", () => confirmHotkey());
  }
}

// ── Screen 5: First dictation ───────────────────────────────────────────────

let firstDictationArmed = false;
let dictationRecording = false;
let dictationStream: MediaStream | null = null;
let dictationAudioCtx: AudioContext | null = null;
let dictationScriptNode: ScriptProcessorNode | null = null;
let dictationPcmChunks: Float32Array[] = [];
let dictationActualSampleRate = 16000;
let dictationStartedAt = 0;
const DICTATION_SAMPLE_RATE = 16000;

function setCapsuleLabel(text: string): void {
  $<HTMLElement>("frCapsuleLabel").textContent = text;
}

function encodePcmToWavBytes(samples: Float32Array, sampleRate: number): Uint8Array {
  const numSamples = samples.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, str: string): void => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Uint8Array(buffer);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(bin);
}

async function startWizardRecording(): Promise<void> {
  if (dictationRecording) return;
  try {
    dictationStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
        sampleRate: DICTATION_SAMPLE_RATE,
      },
    });
  } catch (err) {
    setCapsuleLabel("Mic blocked — check permissions");
    // eslint-disable-next-line no-console
    console.error("[firstrun] mic getUserMedia failed", err);
    return;
  }

  dictationAudioCtx = new AudioContext({ sampleRate: DICTATION_SAMPLE_RATE });
  dictationActualSampleRate = dictationAudioCtx.sampleRate;
  const source = dictationAudioCtx.createMediaStreamSource(dictationStream);
  const node = dictationAudioCtx.createScriptProcessor(4096, 1, 1);
  dictationPcmChunks = [];
  node.onaudioprocess = (e: AudioProcessingEvent): void => {
    const input = e.inputBuffer.getChannelData(0);
    dictationPcmChunks.push(new Float32Array(input));
  };
  source.connect(node);
  node.connect(dictationAudioCtx.destination);
  dictationScriptNode = node;
  dictationRecording = true;
  dictationStartedAt = Date.now();

  const capsule = $<HTMLElement>("frCapsuleDemo");
  capsule.classList.add("is-listening");
  capsule.classList.remove("is-success");
  setCapsuleLabel("Listening...");
}

async function stopAndTranscribeWizard(): Promise<void> {
  if (!dictationRecording) return;
  dictationRecording = false;

  const capsule = $<HTMLElement>("frCapsuleDemo");
  capsule.classList.remove("is-listening");
  setCapsuleLabel("Transcribing...");

  // Let trailing buffers flush.
  await new Promise((r) => window.setTimeout(r, 500));

  const durationSeconds = Math.max(1, Math.round((Date.now() - dictationStartedAt) / 1000));
  dictationScriptNode?.disconnect();
  dictationScriptNode = null;
  dictationStream?.getTracks().forEach((t) => t.stop());
  dictationStream = null;
  void dictationAudioCtx?.close();
  dictationAudioCtx = null;

  const totalLength = dictationPcmChunks.reduce((sum, c) => sum + c.length, 0);
  if (totalLength === 0) {
    setCapsuleLabel("Listening for Ctrl+Space...");
    return;
  }
  const allSamples = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of dictationPcmChunks) {
    allSamples.set(chunk, offset);
    offset += chunk.length;
  }
  dictationPcmChunks = [];

  // Quick silence check.
  let maxAmp = 0;
  for (let i = 0; i < allSamples.length; i++) {
    const a = Math.abs(allSamples[i]);
    if (a > maxAmp) maxAmp = a;
  }
  if (maxAmp < 0.01) {
    setCapsuleLabel("Too quiet — try again");
    return;
  }

  const wavBytes = encodePcmToWavBytes(allSamples, dictationActualSampleRate);
  const wavBase64 = bytesToBase64(wavBytes);

  let result: { text?: string; provider?: string; error?: string };
  try {
    result = await meetelFlow.transcribe("", "audio/wav", durationSeconds, wavBase64);
  } catch (err) {
    setCapsuleLabel("Transcription failed — try again");
    // eslint-disable-next-line no-console
    console.error("[firstrun] transcribe threw", err);
    return;
  }

  if (result.error || !result.text) {
    setCapsuleLabel(result.error ?? "No speech detected");
    return;
  }

  // Drop the result into the textarea (append if user dictates more than once).
  const out = $<HTMLTextAreaElement>("frDictationOutput");
  const prior = out.value.trim();
  out.value = prior ? `${prior} ${result.text}` : result.text;
  out.classList.add("is-done");
  capsule.classList.add("is-success");
  setCapsuleLabel("Got it");

  if (!state.dictationDone) {
    state.dictationDone = true;
    const continueBtn = document.getElementById("frDictationContinueBtn") as HTMLButtonElement | null;
    if (continueBtn) continueBtn.hidden = false;
  }
}

async function toggleWizardDictation(): Promise<void> {
  if (dictationRecording) {
    await stopAndTranscribeWizard();
  } else {
    await startWizardRecording();
  }
}

function armFirstDictation(): void {
  if (firstDictationArmed) return;
  firstDictationArmed = true;

  const skipLink = $<HTMLButtonElement>("frSkipDictation");

  // Release the global Control+Space shortcut while screen 5 is active so the
  // chord lands on the wizard's in-window keydown listener (same approach as
  // screen 4 — works regardless of whether globalShortcut.register succeeded).
  void window.meetelFirstRun.armHotkeyTeach();

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "Space" && e.ctrlKey) {
      e.preventDefault();
      void toggleWizardDictation();
    }
  };
  window.addEventListener("keydown", onKeyDown);

  // Backup path: if the global shortcut IS registered and fires, use it too.
  window.meetelFirstRun.onHotkeyFired(() => {
    void toggleWizardDictation();
  });

  // Show "Skip for now" after 20s as a safety valve.
  window.setTimeout(() => {
    if (!state.dictationDone) skipLink.hidden = false;
  }, 20_000);

  skipLink.addEventListener("click", async () => {
    try {
      await window.meetelFirstRun.skipFirstDictation();
    } catch {
      /* continue anyway */
    }
    void window.meetelFirstRun.disarmHotkeyTeach();
    goTo(6);
  });
}

// ── Screen 6: Finish ────────────────────────────────────────────────────────

async function finish(): Promise<void> {
  const btn = document.querySelector<HTMLButtonElement>('[data-action="finish"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Opening...";
  }
  try {
    await window.meetelFirstRun.markComplete();
  } catch (e) {
    // Re-enable so user can retry; main should normally close the window for us.
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Start Using";
    }
    // eslint-disable-next-line no-console
    console.error("[firstrun] markComplete failed", e);
  }
}

// ── Wire up ─────────────────────────────────────────────────────────────────

function bindActions(): void {
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const btn = target.closest<HTMLElement>("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    switch (action) {
      case "next-from-welcome":
        goTo(2);
        break;
      case "back":
        if (state.current > 1) goTo((state.current - 1) as ScreenId);
        break;
      case "submit-identity":
        void submitIdentity();
        break;
      case "request-mic":
        void requestMic();
        break;
      case "next-from-mic":
        goTo(4);
        break;
      case "next-from-hotkey":
        if (state.hotkeyDetected) goTo(5);
        break;
      case "next-from-dictation":
        // Re-arm the global shortcut now that the wizard is done teaching it.
        void window.meetelFirstRun.disarmHotkeyTeach();
        goTo(6);
        break;
      case "finish":
        void finish();
        break;
      default:
        break;
    }
  });

  // Identity form: live-clear email error as the user types.
  const emailInput = document.getElementById("frEmail") as HTMLInputElement | null;
  const emailErr = document.getElementById("frEmailError");
  emailInput?.addEventListener("input", () => {
    emailInput.classList.remove("is-error");
    if (emailErr) emailErr.textContent = "";
  });

  // "Why do we need this?" toggle.
  const whyBtn = document.getElementById("frWhyBtn");
  const whyBox = document.getElementById("frWhyBox");
  whyBtn?.addEventListener("click", () => {
    if (!whyBox) return;
    whyBox.hidden = !whyBox.hidden;
  });

  // Enter key shortcuts per screen.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (state.current === 1) {
      e.preventDefault();
      goTo(2);
    } else if (state.current === 2) {
      e.preventDefault();
      void submitIdentity();
    } else if (state.current === 3 && state.micGranted) {
      e.preventDefault();
      goTo(4);
    } else if (state.current === 4 && state.hotkeyDetected) {
      e.preventDefault();
      goTo(5);
    } else if (state.current === 5 && state.dictationDone) {
      e.preventDefault();
      void window.meetelFirstRun.disarmHotkeyTeach();
      goTo(6);
    } else if (state.current === 6) {
      e.preventDefault();
      void finish();
    }
  });
}

function init(): void {
  bindActions();
  updateProgress();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}

export {};
