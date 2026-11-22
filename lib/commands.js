import { chunkSpeech, finalResponseText } from "./text.js";

const defaults = {
  maxChars: 4096,
  timeoutMs: 180_000,
  speakKey: "<leader>shift+s",
  stopKey: "escape",
};

function positiveInteger(value, max, key) {
  if (!Number.isSafeInteger(value) || value < 2 || value > max) {
    throw new Error(`${key} must be an integer between 2 and ${max}.`);
  }
  return value;
}

function binding(value, key) {
  if (value === false || value === "none") return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a key binding string or false.`);
  }
  return value;
}

function pronunciationLocale(options) {
  const { pronunciationLocale: configured, provider } = options;
  if (configured !== undefined) {
    try {
      if (typeof configured === "string") return Intl.getCanonicalLocales(configured)[0];
    } catch {
      // Report malformed locales like other configuration errors.
    }
    throw new Error('pronunciationLocale must be a locale such as "es" or "und".');
  }
  if (provider?.type === "custom" || provider?.voice === null) return "und";
  if (typeof provider?.voice === "string") {
    return /^(?:(?:female|male)-)?(?:spanish|es)(?:-[a-z]{2})?$/i.test(provider.voice.trim()) ? "es" : "und";
  }
  // Match the Spanish voice chosen by the default local Ollama configuration.
  try {
    const host = new URL(provider?.baseUrl ?? "http://127.0.0.1:11434/v1").hostname;
    if (
      (provider?.model?.trim() ?? "lfm3-audio") === "lfm3-audio" &&
      (/^localhost\.?$|^\[::1\]$|^127\.\d+\.\d+\.\d+$/i.test(host))
    ) {
      return "es";
    }
  } catch {
    // The provider reports invalid URLs/models when it is initialized.
  }
  return "und";
}

export function registerSpeech(context, { createSpeechProvider, playAudio }) {
  const options = { ...defaults, ...context.options };
  const maxChars = positiveInteger(options.maxChars, 100_000, "maxChars");
  const timeoutMs = positiveInteger(options.timeoutMs, 2_147_483_647, "timeoutMs");
  const speakKey = binding(options.speakKey, "speakKey");
  const stopKey = binding(options.stopKey, "stopKey");
  const locale = pronunciationLocale(options);
  if (
    options.player !== undefined &&
    (!options.player || typeof options.player !== "object" || Array.isArray(options.player))
  ) {
    throw new Error("player must be an object.");
  }
  const { session } = context.data;
  const toast = (message, variant = "info") =>
    context.ui.toast.show({ title: "Text to speech", message, variant });
  const currentSession = () => {
    const route = context.ui.router.current();
    return route.type === "session" ? route.sessionID : undefined;
  };
  const busy = (id) => {
    const status = session.status(id)?.type;
    return status === "busy" || status === "retry";
  };

  let active;
  let provider;
  function stop() {
    if (!active) return false;
    const job = active;
    active = undefined;
    job.abort();
    return true;
  }

  async function speak() {
    const id = currentSession();
    if (!id) return toast("Open a session first.", "warning");
    if (busy(id)) return toast("Wait for the current turn to finish.", "warning");
    stop();
    const job = new AbortController();
    active = job;
    try {
      await session.message.sync(id);
      if (job.signal.aborted || currentSession() !== id || busy(id)) return;
      const text = finalResponseText(session.message.list(id) ?? [], locale);
      if (!text) return toast("No completed answer with prose to read.", "warning");
      provider ??= await createSpeechProvider(options);
      job.signal.throwIfAborted();
      if (currentSession() !== id || busy(id)) return;
      toast("Reading the last answer…");
      for (const chunk of chunkSpeech(text, maxChars)) {
        if (currentSession() !== id || busy(id)) break;
        const request = new AbortController();
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = AbortSignal.any([job.signal, request.signal, timeout]);
        try {
          const audio = await provider.synthesize(chunk, { signal });
          // Even a custom adapter can return after cancellation; never start that playback.
          if (signal.aborted || currentSession() !== id || busy(id)) {
            if (audio?.stream instanceof ReadableStream && !audio.stream.locked) {
              void audio.stream.cancel().catch(() => {});
            }
            signal.throwIfAborted();
            break;
          }
          await playAudio(audio, { ...options.player, signal });
        } catch (error) {
          if (timeout.aborted && !job.signal.aborted) throw new Error("Voice request timed out.");
          throw error;
        } finally {
          request.abort();
        }
      }
    } catch (error) {
      if (!job.signal.aborted) {
        toast(error instanceof Error ? error.message : "Could not read the answer.", "error");
      }
    } finally {
      if (active === job) active = undefined;
    }
  }

  context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [
      {
        id: "opencode-tts.speak",
        title: "TTS: Read final answer",
        bind: speakKey,
        palette: true,
        slash: { name: "tts-speak" },
        run: () => void speak(),
      },
      {
        id: "opencode-tts.stop",
        title: "TTS: Stop reading",
        bind: stopKey,
        palette: true,
        slash: { name: "tts-stop" },
        run() {
          if (!stop()) return false;
          toast("Stopped reading.");
        },
      },
    ],
  }));

  return () => {
    stop();
  };
}
