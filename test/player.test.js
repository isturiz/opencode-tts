import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { playAudio } from "../lib/player.js";

async function fakePlayer(t, script) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-tts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = join(directory, "fake player; no shell");
  const result = join(directory, "result.json");
  await writeFile(
    command,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const report = (data) => writeFileSync(${JSON.stringify(result)}, JSON.stringify(data));
${script}
`,
    { mode: 0o700 },
  );
  return { command, result };
}

function audioStream(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function pendingAudio(onCancel) {
  return new ReadableStream({ cancel: onCancel });
}

async function readReport(path) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      await delay(10);
    }
  }
  throw new Error("Fake player did not report its status.");
}

test("pipes binary audio unchanged and uses explicit ffplay demuxers", { timeout: 5000 }, async (t) => {
  const { command, result } = await fakePlayer(t, `
(async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  report({ args: process.argv.slice(2), bytes: [...Buffer.concat(chunks)] });
})();
`);
  for (const [format, demuxer] of [
    ["wav", "wav"], ["mp3", "mp3"], ["opus", "ogg"], ["aac", "aac"], ["flac", "flac"], ["pcm", "s16le"],
  ]) {
    const stream = audioStream(Uint8Array.of(0, 255, 10), new Uint8Array(), Uint8Array.of(27, 128));
    await playAudio({ stream, format }, { command });
    const { args, bytes } = await readReport(result);
    assert.deepEqual(bytes, [0, 255, 10, 27, 128]);
    assert.deepEqual(args, [
      "-hide_banner", "-loglevel", "error", "-nostats", "-nodisp", "-vn", "-sn", "-autoexit",
      "-volume", "100", "-protocol_whitelist", "pipe", "-f", demuxer,
      ...(format === "pcm" ? ["-sample_rate", "24000", "-ch_layout", "1c"] : []),
      "-i", "pipe:0",
    ]);
    assert.equal(stream.locked, false);
  }

  await playAudio(
    { stream: audioStream(Uint8Array.of(1, 2)), format: "pcm" },
    { command, volume: 35, pcmSampleRate: 48000, pcmChannels: 2 },
  );
  const { args } = await readReport(result);
  assert.equal(args[args.indexOf("-volume") + 1], "35");
  assert.equal(args[args.indexOf("-sample_rate") + 1], "48000");
  assert.equal(args[args.indexOf("-ch_layout") + 1], "2c");
});

test("cancels a pending read and reaps the player on abort", { timeout: 5000 }, async (t) => {
  const { command, result } = await fakePlayer(t, `
report({ pid: process.pid });
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
  const logs = t.mock.method(console, "error", () => {});
  const controller = new AbortController();
  let canceled = false;
  const stream = pendingAudio(() => {
    canceled = true;
    return new Promise(() => {});
  });
  const playback = playAudio({ stream, format: "wav" }, { command, signal: controller.signal });
  try {
    const { pid } = await readReport(result);
    controller.abort(new Error("private abort reason"));
    await assert.rejects(playback, { name: "AbortError", message: "Audio playback was aborted." });
    assert.equal(canceled, true);
    assert.equal(stream.locked, false);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(logs.mock.callCount(), 0);
  } finally {
    controller.abort();
    await playback.catch(() => {});
  }
});

test("honors backpressure and cancels when a write is blocked", { timeout: 5000 }, async (t) => {
  const { command, result } = await fakePlayer(t, `
report({ pid: process.pid });
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  let pulls = 0;
  let canceled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream({
    pull(reader) {
      pulls++;
      reader.enqueue(chunk);
    },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 });

  const playback = playAudio({ stream, format: "pcm" }, { command, signal: controller.signal });
  try {
    const { pid } = await readReport(result);
    assert.ok(pulls >= 1 && pulls <= 2, `Unexpected read-ahead while stdin is blocked: ${pulls}`);
    controller.abort();
    await assert.rejects(playback, { name: "AbortError" });
    assert.equal(canceled, true);
    assert.equal(stream.locked, false);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    controller.abort();
    await playback.catch(() => {});
  }
});

test("cancels an already aborted request body without starting a player", async (t) => {
  const logs = t.mock.method(console, "error", () => {});
  let canceled = false;
  const stream = pendingAudio(() => { canceled = true; });
  await assert.rejects(
    playAudio({ stream, format: "wav" }, {
      signal: AbortSignal.abort(),
      command: "/nonexistent/player",
    }),
    { name: "AbortError" },
  );
  assert.equal(canceled, true);
  assert.equal(stream.locked, false);
  assert.equal(logs.mock.callCount(), 0);
});

test("reports missing executables and their paths never reach the console", async (t) => {
  const { command } = await fakePlayer(t, "");
  const logs = t.mock.method(console, "error", () => {});
  let canceled = false;
  const stream = pendingAudio(() => { canceled = true; });
  const message = "Audio player executable not found. Install ffplay or configure its path.";
  await assert.rejects(playAudio({ stream, format: "wav" }, { command: `${command}.missing` }), { message });
  assert.deepEqual(logs.mock.calls.map(({ arguments: args }) => args), [[`[opencode-tts] ${message}`]]);
  assert.equal(canceled, true);
  assert.equal(stream.locked, false);
});

test("reports the exit status and drops potentially sensitive stdout and stderr", { timeout: 5000 }, async (t) => {
  const { command } = await fakePlayer(t, `
process.stdout.write("private stdout");
process.stderr.write("private stderr", () => process.exit(23));
`);
  const logs = t.mock.method(console, "error", () => {});
  let canceled = false;
  const stream = pendingAudio(() => { canceled = true; });
  const message = "Audio player exited with status 23.";
  await assert.rejects(playAudio({ stream, format: "wav" }, { command }), { message });
  assert.deepEqual(logs.mock.calls.map(({ arguments: args }) => args), [[`[opencode-tts] ${message}`]]);
  assert.equal(canceled, true);
  assert.equal(stream.locked, false);
});

test("reports error-level output even when ffplay exits with code zero", async (t) => {
  const { command } = await fakePlayer(t, `
process.stdin.resume();
process.stdin.on("end", () => process.stderr.write("private error"));
`);
  const logs = t.mock.method(console, "error", () => {});
  const message = "Audio player reported an error while decoding or playing audio.";
  await assert.rejects(playAudio({ stream: audioStream(Uint8Array.of(1)), format: "wav" }, { command }), { message });
  assert.deepEqual(logs.mock.calls.map(({ arguments: args }) => args), [[`[opencode-tts] ${message}`]]);
});

test("stops and reaps a player that closes stdin but stays alive", { timeout: 5000 }, async (t) => {
  const { command, result } = await fakePlayer(t, `
require("node:fs").closeSync(0);
report({ pid: process.pid });
setInterval(() => {}, 1000);
`);
  t.mock.method(console, "error", () => {});
  let canceled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { canceled = true; },
  });
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, t.signal]);
  const playback = playAudio({ stream, format: "wav" }, {
    command, signal,
  });
  try {
    await assert.rejects(playback, { message: "Audio player closed its input before all audio was sent." });
    const { pid } = await readReport(result);
    assert.equal(canceled, true);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    controller.abort();
    await playback.catch(() => {});
  }
});

test("validates malformed input from custom adapters", async (t) => {
  const stream = audioStream(Uint8Array.of(1));
  await assert.rejects(playAudio(null), { name: "TypeError", message: /unlocked ReadableStream/ });
  await assert.rejects(playAudio({ stream, format: "constructor" }), { name: "TypeError", message: /format/ });
  await assert.rejects(playAudio({ stream, format: "wav" }, { volume: "20" }), { name: "RangeError" });
  await assert.rejects(playAudio({ stream, format: "pcm" }, { pcmChannels: 0 }), { name: "RangeError" });
  await assert.rejects(playAudio({ stream, format: "pcm" }, { pcmSampleRate: 1.2 }), { name: "RangeError" });
  await assert.rejects(playAudio({ stream, format: "wav" }, { signal: {} }), { name: "TypeError" });
  await assert.rejects(playAudio({ stream, format: "wav" }, { command: "ffplay\0" }), { name: "TypeError" });
  const reader = stream.getReader();
  await assert.rejects(playAudio({ stream, format: "wav" }), { name: "TypeError", message: /unlocked/ });
  reader.releaseLock();

  const { command } = await fakePlayer(t, "process.stdin.resume();");
  const logs = t.mock.method(console, "error", () => {});
  const badStream = audioStream("private payload");
  await assert.rejects(playAudio({ stream: badStream, format: "wav" }, { command }), {
    name: "TypeError",
    message: "Audio stream chunks must be Uint8Array values.",
  });
  assert.equal(badStream.locked, false);
  const brokenStream = new ReadableStream({
    pull() { throw new Error("private source error"); },
  });
  await assert.rejects(playAudio({ stream: brokenStream, format: "wav" }, { command }), {
    message: "Could not read from the audio stream.",
  });
  assert.equal(brokenStream.locked, false);
  assert.ok(!JSON.stringify(logs.mock.calls.map(({ arguments: args }) => args)).includes("private"));
});
