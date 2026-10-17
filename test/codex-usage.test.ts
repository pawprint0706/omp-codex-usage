import assert from "node:assert/strict";
import { test } from "node:test";
import codexUsage from "../extensions/codex-usage.ts";

type API = Parameters<typeof codexUsage>[0];
type Handler = Parameters<API["on"]>[1];
type Context = Parameters<Handler>[1];

function token(account: string): string {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: account } };
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function usage(primary = 37, secondary = 12) {
  return {
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: primary, limit_window_seconds: 18_000, reset_at: 1_900_000_000 },
      secondary_window: { used_percent: secondary, limit_window_seconds: 604_800, reset_at: 1_900_000_000 },
    },
  };
}

function harness() {
  const handlers: Record<string, Handler> = {};
  const statuses: string[] = [];
  const warnings: string[] = [];
  const logs: string[] = [];
  let credential: string | undefined = token("account-a");
  let tick: (() => void) | undefined;
  const ctx: Context = {
    agent: { kind: "main" },
    ui: {
      setStatus: (_key, text) => { statuses.push(text); },
      notify: message => { warnings.push(message); },
    },
    modelRegistry: { getApiKeyForProvider: async () => credential },
    sessionManager: { getSessionId: () => "session-a" },
    setInterval: callback => { tick = callback; },
  };
  codexUsage({
    on: (event, handler) => { handlers[event] = handler; },
    logger: { debug: message => { logs.push(message); } },
  });
  return {
    ctx, statuses, warnings, logs,
    setCredential(value: string | undefined) { credential = value; },
    async emit(event: string) {
      await handlers[event](undefined, ctx);
      await new Promise<void>(resolve => setImmediate(resolve));
    },
    async tick() {
      tick?.();
      await new Promise<void>(resolve => setImmediate(resolve));
    },
  };
}

test("renders used percentages and marks only an exhausted window", async t => {
  const h = harness();
  const payload = usage(100, 17.5);
  payload.rate_limit.allowed = false;
  payload.rate_limit.limit_reached = true;
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  await h.emit("session_start");
  assert.equal(h.statuses.at(-1), "CO 5h 100%! | Wk 17.5%");
});

test("weekly-only plans are not mislabeled as 5h or fabricated as zero", async t => {
  const h = harness();
  const payload = usage();
  t.mock.method(globalThis, "fetch", async () => Response.json({
    rate_limit: { ...payload.rate_limit, primary_window: payload.rate_limit.secondary_window, secondary_window: null },
  }));
  await h.emit("session_start");
  assert.equal(h.statuses.at(-1), "CO Wk 12%");
});

test("meter-wide denial below 100% marks the group", async t => {
  const h = harness();
  const payload = usage();
  payload.rate_limit.allowed = false;
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  await h.emit("session_start");
  assert.equal(h.statuses.at(-1), "CO 5h 37%! | Wk 12%!");
});

test("a malformed window preserves the entire last report as stale; recovery clears marks", async t => {
  const h = harness();
  let payload: unknown = usage();
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  await h.emit("session_start");
  for (const bad of [-1, 101, "12", null]) {
    payload = { rate_limit: { ...usage(40).rate_limit, secondary_window: {
      ...usage().rate_limit.secondary_window, used_percent: bad,
    } } };
    await h.emit("turn_end");
    assert.equal(h.statuses.at(-1), "CO 5h 37%? | Wk 12%?");
  }
  payload = usage(42, 15);
  await h.tick();
  assert.equal(h.statuses.at(-1), "CO 5h 42% | Wk 15%");
  assert.deepEqual(h.warnings, []);
});

test("missing credentials stay silent, and logout discards cached readings", async t => {
  const h = harness();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(usage()));
  h.setCredential(undefined);
  await h.emit("session_start");
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(h.statuses.at(-1), "");
  h.setCredential(token("account-a"));
  await h.tick();
  assert.equal(h.statuses.at(-1), "CO 5h 37% | Wk 12%");
  h.setCredential(undefined);
  await h.tick();
  assert.equal(h.statuses.at(-1), "");
  assert.deepEqual(h.warnings, []);
});

test("failed refresh after account change never shows the previous account's usage", async t => {
  const h = harness();
  let failing = false;
  t.mock.method(globalThis, "fetch", async () => failing
    ? new Response("private response body", { status: 401 }) : Response.json(usage()));
  await h.emit("session_start");
  h.setCredential(token("account-b"));
  failing = true;
  await h.tick();
  await h.tick();
  assert.equal(h.statuses.at(-1), "");
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /HTTP 401/);
  assert.ok(!h.logs.join().includes("private response body"));
});

test("single-flight refresh prevents old responses from overwriting newer usage", async t => {
  const h = harness();
  let complete!: (response: Response) => void;
  const fetchMock = t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { complete = resolve; }));
  const starting = h.emit("session_start");
  await new Promise<void>(resolve => setImmediate(resolve));
  await h.emit("turn_end");
  assert.equal(fetchMock.mock.callCount(), 1);
  complete(Response.json(usage()));
  await starting;
  assert.equal(h.statuses.at(-1), "CO 5h 37% | Wk 12%");
});

test("subagents do not fetch or publish usage", async t => {
  const h = harness();
  h.ctx.agent = { kind: "task" };
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(usage()));
  await h.emit("session_start");
  await h.emit("turn_end");
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.deepEqual(h.statuses, []);
});

test("network failures keep stale values without leaking exception contents", async t => {
  const h = harness();
  let failing = false;
  t.mock.method(globalThis, "fetch", async () => {
    if (failing) throw new Error("request contained secret-token-value");
    return Response.json(usage());
  });
  await h.emit("session_start");
  failing = true;
  await h.tick();
  assert.equal(h.statuses.at(-1), "CO 5h 37%? | Wk 12%?");
  assert.ok(!h.logs.join().includes("secret-token-value"));
});

test("shutdown prevents an in-flight response from repainting a disposed session", async t => {
  const h = harness();
  let complete!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(resolve => { complete = resolve; }));
  const starting = h.emit("session_start");
  await new Promise<void>(resolve => setImmediate(resolve));
  await h.emit("session_shutdown");
  const before = [...h.statuses];
  complete(Response.json(usage()));
  await starting;
  assert.deepEqual(h.statuses, before);
});
