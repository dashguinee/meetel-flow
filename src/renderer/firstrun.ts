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
  testHotkey(): Promise<HotkeyResult>;
  onDictationSuccess(cb: () => void): void;
  skipFirstDictation(): Promise<void>;
  markComplete(): Promise<void>;
}

declare global {
  interface Window {
    meetelFirstRun: MeetelFirstRunAPI;
  }
}

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

  // Subscribe to main-process hotkey fire (authoritative — works even if window
  // is not focused).
  window.meetelFirstRun
    .testHotkey()
    .then((result) => {
      if (!result.detected) return;
      confirmHotkey();
    })
    .catch(() => {
      /* allow keyboard fallback below */
    });

  // Fallback: in-window keyboard detection for visual feedback while we wait.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "ControlLeft" || e.code === "ControlRight") ctrlKey.classList.add("is-down");
    if (e.code === "Space") spaceKey.classList.add("is-down");
    if ((e.ctrlKey || e.metaKey) && e.code === "Space") {
      e.preventDefault();
      confirmHotkey();
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "ControlLeft" || e.code === "ControlRight") ctrlKey.classList.remove("is-down");
    if (e.code === "Space") spaceKey.classList.remove("is-down");
  };

  function confirmHotkey(): void {
    if (state.hotkeyDetected) return;
    state.hotkeyDetected = true;
    keyboard.classList.add("is-detected");
    hint.textContent = "Perfect. Hotkey detected.";
    hint.classList.add("is-ok");
    nextBtn.disabled = false;
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
}

// ── Screen 5: First dictation ───────────────────────────────────────────────

let firstDictationArmed = false;

function armFirstDictation(): void {
  if (firstDictationArmed) return;
  firstDictationArmed = true;

  const capsule = $<HTMLElement>("frCapsuleDemo");
  const label = $<HTMLElement>("frCapsuleLabel");
  const skipLink = $<HTMLButtonElement>("frSkipDictation");

  try {
    window.meetelFirstRun.onDictationSuccess(() => {
      if (state.dictationDone) return;
      state.dictationDone = true;
      capsule.classList.add("is-success");
      label.textContent = "Got it. Nice work.";
      window.setTimeout(() => goTo(6), 900);
    });
  } catch {
    // If main didn't register, user will need Skip link.
  }

  // Show "Skip for now" after 30s as a safety valve.
  window.setTimeout(() => {
    if (!state.dictationDone) skipLink.hidden = false;
  }, 30_000);

  skipLink.addEventListener("click", async () => {
    try {
      await window.meetelFirstRun.skipFirstDictation();
    } catch {
      /* continue anyway */
    }
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
