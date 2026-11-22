import assert from "node:assert/strict";
import test from "node:test";
import { registerSpeech } from "../lib/commands.js";

function setup({
  options = {},
  synthesize,
  playAudio,
  sync,
  answer = "Pruebas listas.\n\n**Ejemplo de ejecución:**\n\n```sh\npnpm test\n```",
  onPlaying,
  status = "idle",
} = {}) {
  const toasts = [];
  const calls = [];
  const layers = [];
  const handlers = new Map();
  let history;
  let sessionID = "ses_active";
  const context = {
    options,
    data: {
      on: (type, handle) => {
        handlers.set(type, handle);
        return () => handlers.delete(type);
      },
      session: {
        status: () => status,
        message: {
          sync: sync ?? (async () => {}),
          list: (id) => {
            assert.equal(id, sessionID);
            return history ?? [
              { type: "user" },
              {
                type: "assistant",
                id: "message-1",
                time: { completed: 200 },
                finish: "stop",
                content: [
                  { type: "reasoning", text: "No leer." },
                  { type: "text", text: answer },
                ],
              },
              { type: "idle", outcome: "succeeded" },
            ];
          },
        },
      },
    },
    ui: {
      toast: { show: (toast) => toasts.push(toast) },
      router: { current: () => ({ type: "session", sessionID }) },
      dialog: { select: async () => undefined },
    },
    storage: {
      store: (_key, { initial }) => [initial, async (update) => update(initial)],
    },
    keymap: { layer: (build) => layers.push(build()) },
  };
  const controls = registerSpeech(context, {
    createSpeechProvider: async (config) => ({
      async synthesize(value, request) {
        calls.push({ value, request, config });
        return synthesize?.(value, request) ?? {};
      },
    }),
    playAudio: playAudio ?? (async () => {}),
    onPlaying,
  });
  const [speak, stop, settings] = ["speak", "stop", "settings"].map((name) =>
    layers[0].commands.find(({ id }) => id === `opencode-tts.${name}`));
  return {
    cleanup: controls.dispose, toggle: controls.toggle, calls, toasts, speak, stop, settings,
    switchSession: () => { sessionID = "ses_other"; },
    emit: (type, created, id = sessionID) => handlers.get(type)?.({ type, created, data: { sessionID: id } }),
    setHistory: (messages) => { history = messages; },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("forwards options and only sends the final Markdown prose", async () => {
  const options = { provider: { model: "another", parameters: { speed: 1.2 } }, speakKey: false };
  const plugin = setup({ options });
  assert.equal(plugin.speak.bind, undefined);
  assert.equal(plugin.stop.bind, "escape");
  assert.equal(plugin.stop.run(), false);
  plugin.speak.run();
  await flush();
  assert.equal(plugin.calls.length, 1);
  assert.equal(plugin.calls[0].value, "Pruebas listas.");
  assert.deepEqual(plugin.calls[0].config.provider, options.provider);
  assert.equal(plugin.stop.run(), false);
});

test("infers pronunciation from English defaults and explicit voices, with an override", async () => {
  const answer = "Use `@reviewer`.";
  for (const [options, expected] of [
    [{}, "Use at reviewer."],
    [{ provider: { voice: "male-british-english" } }, "Use at reviewer."],
    [{ provider: { voice: "female-spanish" } }, "Use arroba reviewer."],
    [{ provider: { voice: "alloy" } }, "Use @ reviewer."],
    [{ provider: { voice: "alloy" }, pronunciationLocale: "en" }, "Use at reviewer."],
    [{ provider: { voice: "unrelated" }, pronunciationLocale: "es-MX" }, "Use arroba reviewer."],
  ]) {
    const plugin = setup({ options, answer });
    plugin.speak.run();
    await flush();
    assert.equal(plugin.calls[0].value, expected);
  }
  assert.throws(() => setup({ options: { pronunciationLocale: "es inválido" } }), /pronunciationLocale/);
});

test("Escape cancels in-flight synthesis and falls through when idle", async () => {
  const plugin = setup({
    synthesize: async (_, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    playAudio: async () => assert.fail("Playback must not start after cancellation"),
  });
  plugin.speak.run();
  await flush();
  assert.equal(plugin.calls[0].request.signal.aborted, false);
  plugin.stop.run();
  await flush();
  assert.equal(plugin.calls[0].request.signal.aborted, true);
  assert.equal(plugin.stop.run(), false);
  assert.equal(plugin.toasts.at(-1).message, "Stopped reading.");
});

test("shows settings only in the palette and the footer toggles the matching session", async () => {
  const changes = [];
  const plugin = setup({
    onPlaying: (id) => changes.push(id),
    synthesize: async (_, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  assert.equal(plugin.settings.palette, true);
  assert.equal(plugin.settings.slash, undefined);
  assert.equal(plugin.speak.bind, "<leader>shift+s");
  plugin.toggle("ses_active");
  await flush();
  assert.equal(plugin.calls.length, 1);
  plugin.toggle("ses_active");
  assert.equal(plugin.calls[0].request.signal.aborted, true);
  assert.deepEqual(changes, ["ses_active", undefined]);
});

test("automatic mode narrates a newly completed answer, never a stale or silent follow-up", async () => {
  const plugin = setup({ options: { playbackMode: "automatic" } });
  plugin.emit("session.execution.started", 100);
  plugin.emit("session.execution.succeeded", 210);
  await flush();
  assert.equal(plugin.calls.length, 1);
  plugin.emit("session.execution.started", 220);
  plugin.emit("session.execution.succeeded", 230);
  await flush();
  assert.equal(plugin.calls.length, 1);
  plugin.setHistory([
    { type: "user" },
    { type: "assistant", id: "some-newer-answer", finish: "stop", time: { completed: 255 }, content: [{ type: "text", text: "An older answer." }] },
    { type: "idle", outcome: "succeeded" },
    { type: "synthetic" },
    { type: "assistant", id: "silent", finish: "stop", time: { completed: 260 }, content: [{ type: "reasoning", text: "Silent follow-up" }] },
    { type: "idle", outcome: "succeeded" },
  ]);
  plugin.emit("session.execution.started", 250);
  plugin.emit("session.execution.succeeded", 270);
  await flush();
  assert.equal(plugin.calls.length, 1);
});

test("manual mode ignores automatic events", async () => {
  const plugin = setup();
  plugin.emit("session.execution.started", 100);
  plugin.emit("session.execution.succeeded", 210);
  await flush();
  assert.equal(plugin.calls.length, 0);
});

test("does not read a session while OpenCode reports it as running", async () => {
  const plugin = setup({ status: "running" });
  plugin.speak.run();
  await flush();
  assert.equal(plugin.calls.length, 0);
  assert.match(plugin.toasts.at(-1).message, /Wait for the current turn/);
});

test("does not synthesize if the visible session changes during history sync", async () => {
  let finish;
  const plugin = setup({ sync: () => new Promise((resolve) => { finish = resolve; }) });
  plugin.speak.run();
  plugin.switchSession();
  finish();
  await flush();
  assert.equal(plugin.calls.length, 0);
});

test("unloading the plugin cancels ongoing playback", async () => {
  let playbackSignal;
  const plugin = setup({
    playAudio: async (_, { signal }) => {
      playbackSignal = signal;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  plugin.speak.run();
  await flush();
  assert.equal(playbackSignal.aborted, false);
  plugin.cleanup();
  await flush();
  assert.equal(playbackSignal.aborted, true);
});
