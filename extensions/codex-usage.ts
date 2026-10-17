// Codex plan usage in the omp status line, using omp's existing OAuth login.
import { Buffer } from "node:buffer";

const PROVIDER = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_MS = 90_000;
const FETCH_TIMEOUT_MS = 10_000;

interface UsageContext {
  agent?: { kind?: string };
  ui: { setStatus(key: string, text: string): void; notify?(message: string, type?: string): void };
  modelRegistry?: {
    getApiKeyForProvider?(provider: string, sessionId?: string): Promise<string | undefined>;
  };
  sessionManager?: { getSessionId?(): string };
  setInterval(fn: () => void, ms: number): unknown;
}

interface Reading {
  tag: string;
  percent: number;
  exhausted: boolean;
}

interface State {
  account?: string;
  readings?: Reading[];
  inflight?: Promise<void>;
  warned: boolean;
}

interface UsagePayload {
  rate_limit?: {
    allowed?: unknown;
    limit_reached?: unknown;
    primary_window?: UsageWindow | null;
    secondary_window?: UsageWindow | null;
  } | null;
}

interface UsageWindow {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
}

function accountFromToken(token: string): string {
  // Decode only for account routing; the server validates the bearer token.
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
        "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
      } | null;
      const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
      if (typeof id === "string" && id.length > 0) return id;
    }
  } catch {
    // Never log token contents or substitute an OpenAI Platform API key.
  }
  throw new Error("Codex OAuth credential unavailable; use /login openai-codex");
}

function windowTag(seconds: number): string {
  if (seconds === 604_800) return "Wk";
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function readUsage(payload: unknown): Reading[] {
  // Assert only the envelope; every consumed field is checked before use.
  const rate = (payload as UsagePayload | null)?.rate_limit;
  if (!rate || typeof rate !== "object" || Array.isArray(rate)) {
    throw new Error("Unexpected Codex usage response");
  }
  if (typeof rate.allowed !== "boolean" || typeof rate.limit_reached !== "boolean") {
    throw new Error("Unexpected Codex rate-limit status");
  }
  const rows: Reading[] = [];
  for (const key of ["primary_window", "secondary_window"] as const) {
    const window = rate[key];
    // Some plans expose only a weekly window. Missing does not mean 0% used.
    if (window == null) continue;
    if (typeof window !== "object" || Array.isArray(window)) {
      throw new Error("Unexpected Codex usage window");
    }
    const percent = window.used_percent;
    const seconds = window.limit_window_seconds;
    const reset = window.reset_at;
    if (
      typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100 ||
      typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0 ||
      typeof reset !== "number" || !Number.isFinite(reset) || reset <= 0
    ) {
      throw new Error("Invalid Codex usage window");
    }
    rows.push({ tag: windowTag(seconds), percent, exhausted: percent >= 100 });
  }
  if (rows.length === 0) throw new Error("No Codex plan usage windows available");
  // Codex exposes a meter-wide verdict, not a separate status for each window.
  // If no window explains the denial, mark the whole group rather than guess.
  if ((!rate.allowed || rate.limit_reached) && !rows.some(row => row.exhausted)) {
    for (const row of rows) row.exhausted = true;
  }
  return rows;
}

function setStatus(ctx: UsageContext, rows: Reading[] = [], stale = false): void {
  const text = rows
    .map(row => `${row.tag} ${row.percent}%${row.exhausted ? "!" : ""}${stale ? "?" : ""}`)
    .join(" | ");
  try {
    ctx.ui.setStatus(PROVIDER, text ? `CO ${text}` : "");
  } catch {
    // Headless/disposed UI must not break a turn.
  }
}

export default function codexUsage(pi: {
  on(event: string, handler: (event: unknown, ctx: UsageContext) => unknown): void;
  logger?: { debug?(message: string): void };
}): void {
  // Factories can share a module; cached readings must not cross sessions/accounts.
  const states = new Map<string, State>();
  const sessionId = (ctx: UsageContext) => ctx.sessionManager?.getSessionId?.() ?? "main";
  const isMain = (ctx: UsageContext) => !ctx.agent?.kind || ctx.agent.kind === "main";

  function refresh(ctx: UsageContext): Promise<void> {
    const id = sessionId(ctx);
    let state = states.get(id);
    if (!state) {
      state = { warned: false };
      states.set(id, state);
    }
    if (state.inflight) return state.inflight;
    const current = state;
    current.inflight = (async () => {
      try {
        const token = await ctx.modelRegistry?.getApiKeyForProvider?.(PROVIDER, id);
        if (!token) {
          current.account = undefined;
          current.readings = undefined;
          current.warned = false;
          setStatus(ctx);
          return;
        }
        const account = accountFromToken(token);
        if (current.account !== account) {
          current.account = account;
          current.readings = undefined;
          current.warned = false;
          setStatus(ctx);
        }
        const response = await fetch(USAGE_URL, {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "ChatGPT-Account-Id": account,
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          redirect: "error",
        });
        if (!response.ok) throw new Error(`Codex usage endpoint returned HTTP ${response.status}`);
        const rows = readUsage(await response.json());
        if (states.get(id) !== current) return;
        current.readings = rows;
        current.warned = false;
        setStatus(ctx, rows);
      } catch (error) {
        if (states.get(id) !== current) return;
        // Raw auth/network errors may contain credentials. Only emit our own errors.
        const detail = error instanceof Error && /^(Codex |Unexpected Codex |Invalid Codex |No Codex )/.test(error.message)
          ? error.message
          : "Codex usage refresh failed (authentication, network, timeout, or invalid JSON)";
        pi.logger?.debug?.(`codex-usage: ${detail}`);
        setStatus(ctx, current.readings, true);
        if (!current.readings && !current.warned) {
          current.warned = true;
          try {
            ctx.ui.notify?.(`Codex usage unavailable: ${detail}`, "warning");
          } catch {
            // Headless/disposed UI must not break a turn.
          }
        }
      } finally {
        current.inflight = undefined;
      }
    })();
    return current.inflight;
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!isMain(ctx)) return;
    await refresh(ctx);
    // omp contains callback errors and clears this timer on session_shutdown.
    ctx.setInterval(() => { void refresh(ctx); }, REFRESH_MS);
  });
  pi.on("turn_end", (_event, ctx) => {
    if (isMain(ctx)) void refresh(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (isMain(ctx)) states.delete(sessionId(ctx));
  });
}
