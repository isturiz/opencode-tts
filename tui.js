import { Plugin } from "@opencode/plugin/tui";
import { registerSpeech } from "./lib/commands.js";
import { playAudio } from "./lib/player.js";
import { createSpeechProvider } from "./lib/provider.js";

export default Plugin.define({
  id: "opencode-tts",
  setup(context) {
    return registerSpeech(context, { createSpeechProvider, playAudio });
  },
});
