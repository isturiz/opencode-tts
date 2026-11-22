import assert from "node:assert/strict";
import test from "node:test";
import { registerAutomatic } from "../lib/automatic.js";

function setup({ enabled = true, start, cancel } = {}) {
  const calls = [];
  const listeners = new Map();
  let route = { type: "session", sessionID: "ses_active" };
  let seq = 0;
  const context = {
    data: {
      on(type, listener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        const set = listeners.get(type);
        set.add(listener);
        return () => assert.ok(set.delete(listener), "unsubscribe once");
      },
    },
    ui: { router: { current: () => route } },
  };
  const register = () => registerAutomatic(context, {
    isEnabled: () => enabled,
    start: (...args) => {
      calls.push(["start", ...args]);
      return start?.(...args);
    },
    cancel: (...args) => {
      calls.push(["cancel", ...args]);
      return cancel?.(...args);
    },
  });
  function dispatch(event) {
    for (const listener of listeners.get(event.type) ?? []) listener(event);
  }
  function emit(outcome, sessionID = "ses_active", created) {
    const event = {
      type: `session.execution.${outcome}`,
      created,
      durable: { aggregateID: sessionID, seq: seq++, version: 1 },
      data: { sessionID },
    };
    dispatch(event);
    return event;
  }
  return {
    calls, dispatch, emit, listeners, register, dispose: register(),
    setEnabled: (value) => { enabled = value; },
    setRoute: (value) => { route = value; },
  };
}

test("starts once for a fresh success and forwards that execution's start time", () => {
  const plugin = setup();
  plugin.emit("succeeded");
  const firstStart = plugin.emit("started", "ses_active", 1000);
  plugin.dispatch(firstStart);
  const firstSuccess = plugin.emit("succeeded", "ses_active", 2000);
  plugin.dispatch(firstSuccess);

  plugin.emit("started", "ses_active", 3000);
  plugin.dispatch(firstStart);
  plugin.dispatch(firstSuccess);
  assert.deepEqual(plugin.calls, [
    ["cancel", "ses_active"],
    ["start", "ses_active", 1000],
    ["cancel", "ses_active"],
  ]);

  plugin.emit("succeeded", "ses_active", 4000);
  assert.deepEqual(plugin.calls.at(-1), ["start", "ses_active", 3000]);
});

test("requires opt-in at both start and completion without narrating past turns", () => {
  const plugin = setup({ enabled: false });
  plugin.emit("started");
  plugin.setEnabled(true);
  plugin.emit("succeeded");

  plugin.emit("started");
  plugin.setEnabled(false);
  const skipped = plugin.emit("succeeded");
  plugin.setEnabled(true);
  plugin.dispatch(skipped);
  plugin.emit("succeeded");
  assert.deepEqual(plugin.calls.filter(([type]) => type === "start"), []);

  plugin.emit("started");
  plugin.emit("succeeded");
  assert.deepEqual(plugin.calls.at(-1), ["start", "ses_active", undefined]);
});

test("ignores off-screen starts and discards completions while another route is visible", () => {
  const plugin = setup();
  plugin.emit("started", "ses_other");
  plugin.setRoute({ type: "session", sessionID: "ses_other" });
  plugin.emit("succeeded", "ses_other");

  plugin.emit("started", "ses_other");
  plugin.setRoute({ type: "home" });
  const skipped = plugin.emit("succeeded", "ses_other");
  plugin.setRoute({ type: "session", sessionID: "ses_other" });
  plugin.dispatch(skipped);
  assert.deepEqual(plugin.calls.filter(([type]) => type === "start"), []);

  plugin.emit("started", "ses_other", 1000);
  plugin.emit("succeeded", "ses_active");
  plugin.emit("succeeded", "ses_other");
  assert.deepEqual(plugin.calls.at(-1), ["start", "ses_other", 1000]);
});

test("failure and interruption clear matching pending executions", () => {
  const plugin = setup();
  for (const outcome of ["failed", "interrupted"]) {
    plugin.emit("started");
    plugin.emit(outcome);
    plugin.emit("succeeded");
  }
  assert.deepEqual(plugin.calls, [["cancel", "ses_active"], ["cancel", "ses_active"]]);
});

test("a new execution requests same-session cancellation even while speech is pending", async () => {
  const { promise, reject } = Promise.withResolvers();
  let playing;
  const plugin = setup({
    start(id) {
      playing = id;
      return promise;
    },
    cancel(id) {
      if (id !== playing) return;
      playing = undefined;
      reject(new Error("Speech aborted"));
    },
  });

  plugin.emit("started");
  plugin.emit("succeeded");
  assert.equal(playing, "ses_active");
  plugin.emit("started", "ses_other");
  assert.equal(playing, "ses_active");
  plugin.setRoute({ type: "home" });
  plugin.emit("started");
  assert.equal(playing, undefined);
  await new Promise(setImmediate);
});

test("does not propagate synchronous start errors through the event bus", () => {
  const plugin = setup({ start: () => { throw new Error("Speech failed"); } });
  plugin.emit("started");
  assert.doesNotThrow(() => plugin.emit("succeeded"));
});

test("disposing removes all subscriptions and prevents pending playback after reload", () => {
  const plugin = setup();
  assert.deepEqual([...plugin.listeners.keys()], [
    "session.execution.started",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
  ]);
  plugin.emit("started", "ses_active", 1000);
  const [oldListener] = plugin.listeners.get("session.execution.succeeded");
  plugin.dispose();
  plugin.dispose();
  for (const set of plugin.listeners.values()) assert.equal(set.size, 0);

  const dispose = plugin.register();
  oldListener(plugin.emit("succeeded"));
  assert.deepEqual(plugin.calls, [["cancel", "ses_active"]]);
  dispose();
});

test("registration without data.on is a no-op", () => {
  const unexpected = () => assert.fail("No callbacks should be used without an event bus");
  registerAutomatic({ data: {} }, {
    isEnabled: unexpected,
    start: unexpected,
    cancel: unexpected,
  })();
});
