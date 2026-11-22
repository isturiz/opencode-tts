import { registerAutomatic } from "./automatic.js";
import { createSettings } from "./settings.js";
import { chunkSpeech, finalResponse } from "./text.js";
import { resolveOpenAISpeechTarget } from "./provider.js";

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
    throw new Error('pronunciationLocale must be a locale such as "en" or "und".');
  }
  if (provider?.type === "custom") return "und";
  try {
    // Match the effective voice, including the local default.
    const { voice } = resolveOpenAISpeechTarget(provider);
    if (!voice) return "und";
    const name = voice.replace(/^(?:female|male)-/i, "");
    if (/^(?:(?:american-|british-)?english|en(?:-[a-z]{2})?)$/i.test(name)) return "en";
    if (/^(?:spanish|es(?:-[a-z]{2})?)$/i.test(name)) return "es";
  } catch {
    // The provider reports invalid URLs/models when it is initialized.
  }
  return "und";
}

export function registerSpeech(context, { createSpeechProvider, playAudio, onPlaying = () => {} }) {
  const options = { ...defaults, ...context.options };
  const maxChars = positiveInteger(options.maxChars, 100_000, "maxChars");
  const timeoutMs = positiveInteger(options.timeoutMs, 2_147_483_647, "timeoutMs");
  const speakKey = binding(options.speakKey, "speakKey");
  const stopKey = binding(options.stopKey, "stopKey");
  pronunciationLocale(options);
  if (
    options.player !== undefined &&
    (!options.player || typeof options.player !== "object" || Array.isArray(options.player))
  ) {
    throw new Error("player must be an object.");
  }
  const { session } = context.data;
  const settings = createSettings(context, options);
  const toast = (message, variant = "info") =>
    context.ui.toast.show({ title: "Text to speech", message, variant });
  const currentSession = () => {
    const route = context.ui.router.current();
    return route.type === "session" ? route.sessionID : undefined;
  };
  const busy = (id) => {
    return session.status(id) === "running";
  };

  let active;
  let providerCache;
  let played = { sessionID: null, answerID: null };

  function stop() {
    if (!active) return false;
    const job = active;
    active = undefined;
    job.controller.abort();
    onPlaying(undefined);
    return true;
  }

  async function speak(request = {}) {
    const { sessionID: id = currentSession(), automatic = false, startedAt } = request;
    if (!id || currentSession() !== id) {
      if (!automatic) toast("Open a session first.", "warning");
      return;
    }
    if (automatic) {
      if (active || settings.getOptions().playbackMode !== "automatic" || !Number.isFinite(startedAt)) return;
    } else if (busy(id)) {
      return toast("Wait for the current turn to finish.", "warning");
    }
    stop();
    const controller = new AbortController();
    const { signal: jobSignal } = controller;
    const job = { controller, sessionID: id, automatic };
    active = job;
    onPlaying(id);
    const eligible = () =>
      !jobSignal.aborted && currentSession() === id && !busy(id) &&
      (!automatic || settings.getOptions().playbackMode === "automatic");
    try {
      await session.message.sync(id);
      if (!eligible()) return;
      const effective = settings.getOptions();
      const answer = finalResponse(session.message.list(id) ?? [], pronunciationLocale(effective), {
        allowSilentFallback: !automatic,
        requireSucceeded: automatic,
      });
      if (!answer?.text) {
        if (!automatic) toast("No completed answer with prose to read.", "warning");
        return;
      }
      if (automatic && (!answer.id || answer.completedAt < startedAt ||
        (played.sessionID === id && played.answerID === answer.id))) return;
      const key = JSON.stringify(effective.provider ?? {});
      let provider = providerCache?.key === key ? providerCache.provider : undefined;
      if (!provider) {
        provider = await createSpeechProvider(effective);
        if (!eligible()) return;
        providerCache = { key, provider };
      }
      if (!eligible()) return;
      played = { sessionID: id, answerID: answer.id };
      if (!automatic) toast("Reading the last answer…");
      for (const chunk of chunkSpeech(answer.text, maxChars)) {
        if (!eligible()) break;
        const request = new AbortController();
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = AbortSignal.any([jobSignal, request.signal, timeout]);
        try {
          const audio = await provider.synthesize(chunk, { signal });
          // Even a custom adapter can return after cancellation; never start that playback.
          if (signal.aborted || !eligible()) {
            if (audio?.stream instanceof ReadableStream && !audio.stream.locked) {
              void audio.stream.cancel().catch(() => {});
            }
            signal.throwIfAborted();
            break;
          }
          await playAudio(audio, { ...effective.player, signal });
        } catch (error) {
          if (timeout.aborted && !jobSignal.aborted) throw new Error("Voice request timed out.");
          throw error;
        } finally {
          request.abort();
        }
      }
    } catch (error) {
      if (!jobSignal.aborted) {
        toast(error instanceof Error ? error.message : "Could not read the answer.", "error");
      }
    } finally {
      if (active === job) {
        active = undefined;
        onPlaying(undefined);
      }
    }
  }

  context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    commands: [
      {
        id: "opencode-tts.settings",
        title: "Text-to-speech settings",
        group: "Text to speech",
        palette: true,
        run: async () => {
          await settings.open();
          if (active?.automatic && settings.getOptions().playbackMode !== "automatic") stop();
        },
      },
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

  const disposeAutomatic = registerAutomatic(context, {
    isEnabled: () => settings.getOptions().playbackMode === "automatic",
    start: (sessionID, startedAt) => speak({ sessionID, automatic: true, startedAt }),
    cancel: (sessionID) => { if (active?.sessionID === sessionID) stop(); },
  });
  return {
    toggle(sessionID) {
      if (active?.sessionID === sessionID) stop();
      else void speak({ sessionID });
    },
    dispose() {
      disposeAutomatic();
      settings.dispose();
      stop();
    },
  };
}
