import assert from "node:assert/strict";
import test from "node:test";
import { registerSpeech } from "../lib/commands.js";

function setup({
  options = {},
  synthesize,
  playAudio,
  sync,
  answer = "Pruebas listas.\n\n**Ejemplo de ejecución:**\n\n```sh\npnpm test\n```",
} = {}) {
  const toasts = [];
  const calls = [];
  const layers = [];
  let sessionID = "ses_active";
  const context = {
    options,
    data: {
      session: {
        status: () => ({ type: "idle" }),
        message: {
          sync: sync ?? (async () => {}),
          list: (id) => {
            assert.equal(id, sessionID);
            return [
              { type: "user" },
              {
                type: "assistant",
                time: { completed: 1 },
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
    },
    keymap: { layer: (build) => layers.push(build()) },
  };
  const cleanup = registerSpeech(context, {
    createSpeechProvider: async (config) => ({
      async synthesize(value, request) {
        calls.push({ value, request, config });
        return synthesize?.(value, request) ?? {};
      },
    }),
    playAudio: playAudio ?? (async () => {}),
  });
  return {
    cleanup, calls, toasts,
    speak: layers[0].commands[0],
    stop: layers[0].commands[1],
    switchSession: () => { sessionID = "ses_other"; },
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
