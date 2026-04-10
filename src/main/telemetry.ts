/**
 * Meetel Flow — Telemetry Emitter (main process singleton)
 *
 * Responsibilities
 * ────────────────
 *  1. Initialise a Supabase client from env vars (SUPABASE_URL / SUPABASE_ANON_KEY)
 *     or from the config object handed in at init time.
 *  2. Maintain an in-memory event queue plus an on-disk mirror at
 *     `app.getPath('userData')/telemetry-queue.json`. The disk mirror is
 *     written atomically (tmp-file + rename) so a crash mid-write cannot
 *     corrupt the queue.
 *  3. Flush on a 30-second timer, on explicit `flush()`, and on `shutdown()`
 *     which is expected to be called from `app.on('before-quit')`.
 *  4. Batch inserts into `meetel_events` — on failure, re-enqueue with
 *     exponential backoff (1s, 2s, 4s, ..., capped at 5 min).
 *  5. Derive a stable device id: try the OS machine-id file first, fall
 *     back to a persisted UUID stored next to the queue.
 *
 * Public API
 * ──────────
 *   init(config)
 *   track(event, payload)
 *   identifyUser(email, name)
 *   flush()
 *   shutdown()
 *
 * No `any` types in the public API.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { app } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PayloadFor,
  QueuedTelemetryEvent,
  TelemetryEventName,
} from "./events";

// ── Types ────────────────────────────────────────────────────────────

export interface TelemetryInitConfig {
  /** Supabase project URL. Falls back to `process.env.SUPABASE_URL`. */
  supabaseUrl?: string;
  /** Supabase anon key. Falls back to `process.env.SUPABASE_ANON_KEY`. */
  supabaseAnonKey?: string;
  /** App version string, surfaced on every inserted row. */
  appVersion: string;
  /** Optional flush interval override (ms). Defaults to 30_000. */
  flushIntervalMs?: number;
  /** If true, logs internal state transitions to console. */
  debug?: boolean;
}

export interface IdentifiedUser {
  id: string;
  email: string;
  name: string | null;
  device_id: string;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 1_000;
const BATCH_SIZE = 100;
const MAX_QUEUE_SIZE = 10_000;

// ── Singleton state ──────────────────────────────────────────────────

interface TelemetryState {
  initialised: boolean;
  config: TelemetryInitConfig | null;
  supabase: SupabaseClient | null;
  queue: QueuedTelemetryEvent[];
  flushTimer: NodeJS.Timeout | null;
  flushing: boolean;
  backoffUntil: number; // epoch ms; suppress network calls until then
  consecutiveFailures: number;
  deviceId: string | null;
  userId: string | null;
  queueFilePath: string;
  deviceFilePath: string;
  sessionStartedAt: number;
  dictationCount: number;
}

const state: TelemetryState = {
  initialised: false,
  config: null,
  supabase: null,
  queue: [],
  flushTimer: null,
  flushing: false,
  backoffUntil: 0,
  consecutiveFailures: 0,
  deviceId: null,
  userId: null,
  queueFilePath: "",
  deviceFilePath: "",
  sessionStartedAt: Date.now(),
  dictationCount: 0,
};

// ── Utilities ────────────────────────────────────────────────────────

const debugLog = (...parts: unknown[]): void => {
  if (state.config?.debug) {
    // eslint-disable-next-line no-console
    console.log("[telemetry]", ...parts);
  }
};

const readFileSafe = (p: string): string | null => {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
};

const atomicWriteSync = (filePath: string, contents: string): void => {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents, { encoding: "utf-8" });
  fs.renameSync(tmp, filePath);
};

/**
 * Derive a stable device id.
 *
 *  1. Try the OS-level machine id (Linux: /etc/machine-id, /var/lib/dbus/machine-id;
 *     macOS: ioreg kIOPlatformUUID is not readable without shelling out, so we
 *     skip it here and let the persisted-UUID fallback handle it; Windows:
 *     HKLM\\SOFTWARE\\Microsoft\\Cryptography MachineGuid — likewise requires
 *     a shell call, so fallback).
 *  2. If a UUID has been persisted previously, reuse it.
 *  3. Otherwise generate a UUIDv4, persist, return.
 */
const deriveDeviceId = (persistPath: string): string => {
  // Step 1 — OS machine id (Linux only without shelling out)
  if (process.platform === "linux") {
    const candidates = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
    for (const c of candidates) {
      const raw = readFileSafe(c);
      if (raw && raw.trim().length > 0) {
        // Hash it so we never leak the raw OS id to our backend.
        return crypto
          .createHash("sha256")
          .update(raw.trim())
          .digest("hex")
          .slice(0, 32);
      }
    }
  }

  // Step 2 — persisted UUID
  const persisted = readFileSafe(persistPath);
  if (persisted) {
    try {
      const parsed = JSON.parse(persisted) as { device_id?: string };
      if (typeof parsed.device_id === "string" && parsed.device_id.length > 0) {
        return parsed.device_id;
      }
    } catch {
      // fall through
    }
  }

  // Step 3 — generate and persist
  const fresh = crypto.randomUUID();
  try {
    atomicWriteSync(persistPath, JSON.stringify({ device_id: fresh }, null, 2));
  } catch (err) {
    debugLog("failed to persist device id", err);
  }
  return fresh;
};

const loadQueueFromDisk = (queuePath: string): QueuedTelemetryEvent[] => {
  const raw = readFileSafe(queuePath);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Basic shape validation — drop anything malformed.
    return parsed.filter((x): x is QueuedTelemetryEvent => {
      if (x === null || typeof x !== "object") return false;
      const o = x as Record<string, unknown>;
      return (
        typeof o.client_event_id === "string" &&
        typeof o.event === "string" &&
        typeof o.emitted_at === "string" &&
        typeof o.attempts === "number" &&
        typeof o.payload === "object" &&
        o.payload !== null
      );
    });
  } catch {
    return [];
  }
};

const persistQueueToDisk = (): void => {
  if (!state.queueFilePath) return;
  try {
    atomicWriteSync(state.queueFilePath, JSON.stringify(state.queue));
  } catch (err) {
    debugLog("failed to persist queue", err);
  }
};

// ── Public API ───────────────────────────────────────────────────────

export const init = (config: TelemetryInitConfig): void => {
  if (state.initialised) {
    debugLog("init called twice — ignoring");
    return;
  }

  const url = config.supabaseUrl ?? process.env.SUPABASE_URL ?? "";
  const key = config.supabaseAnonKey ?? process.env.SUPABASE_ANON_KEY ?? "";

  state.config = config;
  state.sessionStartedAt = Date.now();

  // Paths depend on Electron app being ready.
  const userDataDir = app.getPath("userData");
  state.queueFilePath = path.join(userDataDir, "telemetry-queue.json");
  state.deviceFilePath = path.join(userDataDir, "telemetry-device.json");

  // Device id first — even if Supabase isn't configured, we still want a stable id.
  state.deviceId = deriveDeviceId(state.deviceFilePath);

  // Hydrate queue from disk (offline persistence).
  state.queue = loadQueueFromDisk(state.queueFilePath);

  if (!url || !key) {
    debugLog("no supabase credentials — telemetry will queue locally only");
    state.supabase = null;
  } else {
    state.supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  // Start flush timer.
  const interval = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  state.flushTimer = setInterval(() => {
    void flush();
  }, interval);
  // Don't keep the event loop alive just for telemetry.
  if (typeof state.flushTimer.unref === "function") {
    state.flushTimer.unref();
  }

  state.initialised = true;
  debugLog("initialised", {
    hasSupabase: !!state.supabase,
    deviceId: state.deviceId,
    queuedOnDisk: state.queue.length,
  });
};

export const track = <N extends TelemetryEventName>(
  event: N,
  payload: PayloadFor<N>,
): void => {
  if (!state.initialised) {
    debugLog("track called before init — dropping", event);
    return;
  }

  // Count dictations for session_end bookkeeping.
  if (event === "dictation_success" || event === "dictation_failure") {
    state.dictationCount += 1;
  }

  const queued: QueuedTelemetryEvent = {
    client_event_id: crypto.randomUUID(),
    event,
    payload: payload as unknown as Record<string, unknown>,
    emitted_at: new Date().toISOString(),
    attempts: 0,
  };

  state.queue.push(queued);

  // Cap runaway queues. We drop the OLDEST events so the freshest telemetry
  // survives — for diagnostics, recent > stale.
  if (state.queue.length > MAX_QUEUE_SIZE) {
    state.queue.splice(0, state.queue.length - MAX_QUEUE_SIZE);
  }

  persistQueueToDisk();
};

export class IdentifyUserError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "IdentifyUserError";
  }
}

export const identifyUser = async (
  email: string,
  name: string,
): Promise<IdentifiedUser> => {
  if (!state.initialised) {
    throw new IdentifyUserError("Telemetry not initialised");
  }
  if (!state.supabase) {
    throw new IdentifyUserError("Supabase client not configured (missing url/key)");
  }
  if (!state.deviceId) {
    throw new IdentifyUserError("Device id not derived");
  }

  const platform = process.platform;
  const appVersion = state.config?.appVersion ?? "0.0.0";

  // eslint-disable-next-line no-console
  console.log(`[telemetry] identifyUser email=${email} device=${state.deviceId.slice(0, 8)}`);

  // Both `email` AND `device_id` are UNIQUE in the schema, so a plain upsert
  // with onConflict: "email" can still violate the device_id unique constraint
  // (e.g. when the same device re-onboards with a different email). Resolve
  // this with a select-then-update/insert pattern.
  const sb = state.supabase;
  const deviceId = state.deviceId;
  const baseFields = {
    email,
    name,
    device_id: deviceId,
    platform,
    app_version: appVersion,
    last_active_at: new Date().toISOString(),
  };

  try {
    // 1. Look for an existing row by device_id OR email.
    const { data: existing, error: findErr } = await sb
      .from("meetel_users")
      .select("id, email, name, device_id")
      .or(`device_id.eq.${deviceId},email.eq.${email}`)
      .limit(1)
      .maybeSingle();

    if (findErr) {
      // eslint-disable-next-line no-console
      console.error(`[telemetry] identifyUser find error: ${findErr.message} (code=${findErr.code ?? "?"})`);
      throw new IdentifyUserError(findErr.message, findErr);
    }

    if (existing) {
      // 2a. Update the existing row in place. Use the existing row's id so
      // the unique constraints don't fight us.
      const { data, error } = await sb
        .from("meetel_users")
        .update(baseFields)
        .eq("id", existing.id)
        .select("id, email, name, device_id")
        .single();

      if (error) {
        // eslint-disable-next-line no-console
        console.error(`[telemetry] identifyUser update error: ${error.message} (code=${error.code ?? "?"})`);
        throw new IdentifyUserError(error.message, error);
      }
      if (!data) throw new IdentifyUserError("Update returned no row");

      state.userId = data.id;
      // eslint-disable-next-line no-console
      console.log(`[telemetry] identifyUser updated id=${data.id}`);
      return data as IdentifiedUser;
    }

    // 2b. No existing row — insert fresh.
    const { data, error } = await sb
      .from("meetel_users")
      .insert(baseFields)
      .select("id, email, name, device_id")
      .single();

    if (error) {
      // eslint-disable-next-line no-console
      console.error(`[telemetry] identifyUser insert error: ${error.message} (code=${error.code ?? "?"})`);
      throw new IdentifyUserError(error.message, error);
    }
    if (!data) throw new IdentifyUserError("Insert returned no row");

    state.userId = data.id;
    // eslint-disable-next-line no-console
    console.log(`[telemetry] identifyUser inserted id=${data.id}`);
    return data as IdentifiedUser;
  } catch (err) {
    if (err instanceof IdentifyUserError) throw err;
    const msg = err instanceof Error ? err.message : "unknown identifyUser failure";
    // eslint-disable-next-line no-console
    console.error(`[telemetry] identifyUser threw: ${msg}`);
    throw new IdentifyUserError(msg, err);
  }
};

export const flush = async (): Promise<void> => {
  if (!state.initialised || state.flushing) return;
  if (state.queue.length === 0) return;
  if (!state.supabase) {
    debugLog("flush skipped — no supabase client");
    return;
  }
  if (Date.now() < state.backoffUntil) {
    debugLog("flush suppressed — in backoff window");
    return;
  }

  state.flushing = true;
  try {
    const batch = state.queue.slice(0, BATCH_SIZE);
    const rows = batch.map((q) => ({
      user_id: state.userId,
      event: q.event,
      payload: q.payload,
      created_at: q.emitted_at,
      platform: process.platform,
      app_version: state.config?.appVersion ?? "0.0.0",
    }));

    const { error } = await state.supabase.from("meetel_events").insert(rows);

    if (error) {
      // Bump attempts on each item in the batch, schedule backoff.
      for (const q of batch) q.attempts += 1;
      state.consecutiveFailures += 1;
      const backoffMs = Math.min(
        BASE_BACKOFF_MS * 2 ** (state.consecutiveFailures - 1),
        MAX_BACKOFF_MS,
      );
      state.backoffUntil = Date.now() + backoffMs;
      persistQueueToDisk();
      debugLog(
        `flush failed (${error.message}) — backing off ${backoffMs}ms, queue=${state.queue.length}`,
      );
      return;
    }

    // Success — drop the flushed slice, reset failure state.
    state.queue.splice(0, batch.length);
    state.consecutiveFailures = 0;
    state.backoffUntil = 0;
    persistQueueToDisk();
    debugLog(`flushed ${batch.length} events, remaining=${state.queue.length}`);

    // If there's more in the queue, schedule another flush soon.
    if (state.queue.length > 0) {
      setImmediate(() => {
        void flush();
      });
    }
  } catch (err) {
    state.consecutiveFailures += 1;
    const backoffMs = Math.min(
      BASE_BACKOFF_MS * 2 ** (state.consecutiveFailures - 1),
      MAX_BACKOFF_MS,
    );
    state.backoffUntil = Date.now() + backoffMs;
    debugLog("flush threw", err);
  } finally {
    state.flushing = false;
  }
};

export const shutdown = async (): Promise<void> => {
  if (!state.initialised) return;

  // Fire a session_end event so server analytics have a clean boundary.
  const durationMs = Date.now() - state.sessionStartedAt;
  track("session_end", {
    duration_ms: durationMs,
    dictation_count: state.dictationCount,
  });

  if (state.flushTimer) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }

  // One last best-effort flush. We bypass the backoff window because the
  // app is quitting and this is our final chance.
  state.backoffUntil = 0;
  try {
    await flush();
  } catch (err) {
    debugLog("shutdown flush threw", err);
  }

  // Whatever didn't make it stays on disk for the next session to retry.
  persistQueueToDisk();
  state.initialised = false;
  debugLog("shutdown complete");
};

// ── Introspection helpers (for tests / diagnostics) ──────────────────

export const __internal = {
  getQueueLength: (): number => state.queue.length,
  getDeviceId: (): string | null => state.deviceId,
  getUserId: (): string | null => state.userId,
  isInitialised: (): boolean => state.initialised,
  getOsVersion: (): string => `${os.type()} ${os.release()}`,
};
