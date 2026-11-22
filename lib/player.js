import { spawn } from "node:child_process";
import { ReadableStream } from "node:stream/web";
import { types } from "node:util";

const demuxers = Object.freeze({
  wav: "wav",
  mp3: "mp3",
  opus: "ogg",
  aac: "aac",
  flac: "flac",
  pcm: "s16le",
});

function spawnError(code) {
  if (code === "ENOENT") {
    return new Error("Audio player executable not found. Install ffplay or configure its path.");
  }
  if (code === "EACCES" || code === "EPERM") {
    return new Error("Audio player executable could not be run: permission denied.");
  }
  return new Error("Could not start the audio player.");
}

function abortError() {
  return new DOMException("Audio playback was aborted.", "AbortError");
}

function writeChunk(stdin, chunk) {
  return new Promise((resolve, reject) => {
    stdin.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

export async function playAudio(
  audio,
  { signal, command = "ffplay", volume = 100, pcmSampleRate = 24000, pcmChannels = 1 } = {},
) {
  const { stream, format } = audio ?? {};
  if (!(stream instanceof ReadableStream) || stream.locked) {
    throw new TypeError("Audio must have an unlocked ReadableStream.");
  }
  if (typeof format !== "string" || !Object.hasOwn(demuxers, format)) {
    throw new TypeError("Unsupported audio format. Use wav, mp3, opus, aac, flac, or pcm.");
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("Playback signal must be an AbortSignal.");
  }
  if (typeof command !== "string" || !command.trim() || command.includes("\0")) {
    throw new TypeError("Audio player command must be an executable name or path.");
  }
  if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
    throw new RangeError("Playback volume must be a number from 0 to 100.");
  }

  const args = [
    "-hide_banner", "-loglevel", "error", "-nostats", "-nodisp", "-vn", "-sn", "-autoexit",
    "-volume", String(Math.round(volume)),
    "-protocol_whitelist", "pipe",
    "-f", demuxers[format],
  ];
  if (format === "pcm") {
    if (!Number.isInteger(pcmSampleRate) || pcmSampleRate < 1 || pcmSampleRate > 2147483647) {
      throw new RangeError("PCM sample rate must be a positive 32-bit integer.");
    }
    if (!Number.isInteger(pcmChannels) || pcmChannels < 1 || pcmChannels > 8) {
      throw new RangeError("PCM channel count must be an integer from 1 to 8.");
    }
    args.push("-sample_rate", String(pcmSampleRate), "-ch_layout", `${pcmChannels}c`);
  }
  args.push("-i", "pipe:0");

  const reader = stream.getReader();
  let stopped = false;
  let inputEnded = false;
  function stopInput() {
    if (stopped) return;
    stopped = true;
    // A custom cancel hook can reject or never settle; cancellation still unblocks read().
    if (!inputEnded) void reader.cancel().catch(() => {});
  }

  try {
    if (signal?.aborted) throw abortError();

    let child;
    try {
      child = spawn(command, args, { shell: false, stdio: ["pipe", "ignore", "pipe"] });
    } catch (error) {
      throw spawnError(error.code);
    }
    const { stdin, stderr } = child;
    let processFailure;
    let sourceFailure;
    let pipeFailed = false;
    let reportedError = false;
    let killTimer;

    function killPlayer() {
      stopInput();
      stdin.destroy();
      stderr.destroy();
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }

    function onPipeFailure() {
      if (stopped) return;
      pipeFailed = true;
      stopInput();
      // EPIPE often precedes the real exit status. Give it a chance to arrive,
      // but don't hang if the player closes stdin and keeps running.
      killTimer = setTimeout(killPlayer, 250);
    }

    const closed = new Promise((resolve) => {
      child.once("close", (code, exitSignal) => {
        stopInput();
        clearTimeout(killTimer);
        resolve({ code, exitSignal });
      });
    });
    child.on("error", (error) => {
      processFailure ??= spawnError(error.code);
      stopInput();
    });
    stdin.on("error", onPipeFailure);
    stdin.once("close", () => {
      if (!stdin.writableFinished) onPipeFailure();
    });
    // Some ffplay decoding failures exit with code 0. Notice error-level output,
    // but never buffer or pass any of it through to the terminal.
    stderr.on("data", () => { reportedError = true; });
    stderr.on("error", () => { reportedError = true; });

    signal?.addEventListener("abort", killPlayer, { once: true });
    if (signal?.aborted) killPlayer();
    try {
      const transfer = (async () => {
        let reading = true;
        try {
          while (!stopped) {
            reading = true;
            const { done, value } = await reader.read();
            if (stopped) return;
            if (!done && !types.isUint8Array(value)) {
              sourceFailure = new TypeError("Audio stream chunks must be Uint8Array values.");
              killPlayer();
              return;
            }
            reading = false;
            if (done) {
              inputEnded = true;
              stdin.end();
              return;
            }
            if (value.byteLength > 0) await writeChunk(stdin, value);
          }
        } catch {
          if (stopped) return;
          if (reading) {
            sourceFailure = new Error("Could not read from the audio stream.");
            killPlayer();
          } else {
            onPipeFailure();
          }
        }
      })();

      const { code, exitSignal } = await closed;
      await transfer;
      if (signal?.aborted) throw abortError();
      if (processFailure) throw processFailure;
      if (sourceFailure) throw sourceFailure;
      if (code !== null && code !== 0) throw new Error(`Audio player exited with status ${code}.`);
      if (exitSignal && !pipeFailed) throw new Error(`Audio player was terminated by ${exitSignal}.`);
      if (reportedError) throw new Error("Audio player reported an error while decoding or playing audio.");
      if (pipeFailed || !inputEnded || !stdin.writableFinished) {
        throw new Error("Audio player closed its input before all audio was sent.");
      }
    } finally {
      signal?.removeEventListener("abort", killPlayer);
    }
  } catch (error) {
    if (error.name !== "AbortError") console.error(`[opencode-tts] ${error.message}`);
    throw error;
  } finally {
    stopInput();
    reader.releaseLock();
  }
}
