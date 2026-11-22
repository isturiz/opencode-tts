/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { Show, createSignal } from "solid-js";
import { registerSpeech } from "./lib/commands.js";
import { playAudio } from "./lib/player.js";
import { createSpeechProvider } from "./lib/provider.js";

export default Plugin.define({
  id: "opencode-tts",
  setup(context) {
    const [playing, setPlaying] = createSignal<string>();
    const speech = registerSpeech(context, { createSpeechProvider, playAudio, onPlaying: setPlaying });
    const removeButton = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => (
        <Show when={input.sessionID && input.mode === "normal"}>
          <text
            id="opencode-tts-listen"
            selectable={false}
            fg={context.theme.text.base}
            onMouseDown={(event) => {
              if (event.button === 0) speech.toggle(input.sessionID);
            }}
          >{playing() === input.sessionID ? "[Stop voice]" : "[Listen]"}</text>
        </Show>
      ),
    });

    return () => {
      removeButton();
      speech.dispose();
    };
  },
});
