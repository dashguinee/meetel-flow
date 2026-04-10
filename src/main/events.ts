/**
 * Telemetry event type definitions.
 *
 * All events emitted through `telemetry.track()` must conform to the
 * `TelemetryEvent` discriminated union. The discriminator is the `event`
 * field; the payload is a tightly typed object. No `any` types anywhere.
 *
 * This file is consumed by both the telemetry emitter and any caller
 * that wants compile-time guarantees that a given event/payload pair
 * is valid.
 */

export type TelemetryProvider = "groq" | "whisper" | "gemini" | "unknown";
export type TelemetryPlatform = "win32" | "darwin" | "linux" | string;

// ── Individual payload shapes ────────────────────────────────────────

export interface AppStartPayload {
  version: string;
  platform: TelemetryPlatform;
  os_version: string;
}

export interface FirstRunStartPayload {
  // Intentionally empty — the presence of the event is the signal.
  readonly _?: never;
}

export interface FirstRunCompletePayload {
  duration_ms: number;
}

export interface MicPermissionResultPayload {
  granted: boolean;
}

export interface HotkeyFiredPayload {
  hotkey: string;
}

export interface DictationSuccessPayload {
  duration_ms: number;
  word_count: number;
  provider: TelemetryProvider;
  language: string;
  target_app?: string;
}

export interface DictationFailurePayload {
  duration_ms: number;
  provider?: TelemetryProvider;
  error_code: string;
  error_message: string;
}

export interface SettingsChangedPayload {
  key: string;
  from: string | number | boolean | null;
  to: string | number | boolean | null;
}

export interface ErrorPayload {
  category: string;
  message: string;
  stack?: string;
}

export interface SessionEndPayload {
  duration_ms: number;
  dictation_count: number;
}

// ── Discriminated union ──────────────────────────────────────────────

export type TelemetryEvent =
  | { event: "app_start"; payload: AppStartPayload }
  | { event: "first_run_start"; payload: FirstRunStartPayload }
  | { event: "first_run_complete"; payload: FirstRunCompletePayload }
  | { event: "mic_permission_result"; payload: MicPermissionResultPayload }
  | { event: "hotkey_fired"; payload: HotkeyFiredPayload }
  | { event: "dictation_success"; payload: DictationSuccessPayload }
  | { event: "dictation_failure"; payload: DictationFailurePayload }
  | { event: "settings_changed"; payload: SettingsChangedPayload }
  | { event: "error"; payload: ErrorPayload }
  | { event: "session_end"; payload: SessionEndPayload };

// Helper: extract the name literal type
export type TelemetryEventName = TelemetryEvent["event"];

// Helper: map an event name to its payload type
export type PayloadFor<N extends TelemetryEventName> = Extract<
  TelemetryEvent,
  { event: N }
>["payload"];

// ── Queued-event wrapper (what actually gets persisted to disk) ──────

export interface QueuedTelemetryEvent {
  /** Monotonic client-generated id — dedupe key if server ever needs it. */
  client_event_id: string;
  /** Discriminator. */
  event: TelemetryEventName;
  /** Typed payload. */
  payload: Record<string, unknown>;
  /** ISO timestamp captured at emit time, not at flush time. */
  emitted_at: string;
  /** Per-queue retry counter for exponential backoff. */
  attempts: number;
}
