# OpenCode TTS

Listen to the final answer in your [OpenCode V2](https://opencode.ai/docs/)
terminal session without listening to code blocks, logs, or intermediate
steps. Use a local or hosted text-to-speech provider. Ollama with
`lfm3-audio` is the built-in default and the setup tested end to end.

## Quick start

You need OpenCode V2, Node.js 22 or later, pnpm, and `ffplay` from FFmpeg
(`brew install ffmpeg` on macOS). For the default setup, start
[Ollama](https://ollama.com/) and pull the speech model:

```sh
ollama pull lfm3-audio
```

```sh
git clone https://github.com/isturiz/opencode-tts.git
cd opencode-tts
pnpm install --frozen-lockfile
```

Add the absolute path to your checkout to the `plugins` array in
`~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`).
This is a terminal plugin, so use `cli.json`, not `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "/absolute/path/to/opencode-tts"
  ]
}
```

The default voice is American English (`female-american-english`).

| Command | Default shortcut | Action |
| --- | --- | --- |
| `/tts-speak` | Leader (usually `Ctrl+X`), then `Shift+S` | Read the last completed answer in the visible session. |
| `/tts-stop` | `Esc` | Cancel synthesis and playback. When speech is idle, `Esc` behaves normally. |

## What gets read?

Playback is manual. The plugin prepares a spoken copy only when requested and
leaves the transcript unchanged. It skips reasoning, tool output, code
blocks, tables, and headings or labels that only introduce skipped material.
A silent background follow-up does not replace the last visible answer.

Names that matter to a sentence are kept: `@reviewer` becomes “at reviewer”
in English, model names are made pronounceable, and a recognized path like
`~/.config/alacritty/alacritty.toml` becomes “your alacritty configuration.”
These are local rules, not a second model call or a rewrite of the answer.

**Looking for speech-to-text?** This plugin does not capture audio or transcribe
speech. [Hex](https://github.com/anomalyco/hex), a separate local dictation tool
from Anomaly, the team behind OpenCode, is one option for voice input.
Hex is optional; typing and other dictation tools work as usual.

## Speech providers

| Provider | How it works | Verification |
| --- | --- | --- |
| **Ollama** | The default local setup uses `lfm3-audio`. | Tested end to end in the OpenCode terminal. |
| **Other OpenAI-compatible endpoints** | Use `POST <baseUrl>/audio/speech` with the model and voice identifiers your service accepts. Supports loopback HTTP and remote HTTPS. | HTTP adapter covered by tests; other live services have not been verified. Compatibility with a chat endpoint alone is not enough. |
| **Custom providers** | Use a [trusted local adapter](#custom-adapters) for a different protocol or engine. | Adapter contract covered by tests. |

The speech provider is independent of the model OpenCode uses to write the
answer. If you configure a remote speech provider, it receives the filtered
answer text only when you request playback. The plugin does not follow redirects
or fall back to another provider.

### Use a different endpoint

Replace the path string in `plugins` with an object containing `package` and
`options`. For example, with a hosted speech API:

```json
{
  "package": "/absolute/path/to/opencode-tts",
  "options": {
    "provider": {
      "baseUrl": "https://speech.example.com/v1",
      "model": "your-speech-model",
      "voice": "your-voice",
      "apiKeyEnv": "SPEECH_API_KEY"
    },
    "pronunciationLocale": "en"
  }
}
```

Use the API base URL (keep `/v1` if the service requires it) and set the API
key in the terminal environment before starting OpenCode. Omit `apiKeyEnv`
for unauthenticated services.

### Choose an Ollama voice

Run `ollama show lfm3-audio` to list voices. For example, set `provider.voice`
to `female-british-english` for British English or `female-spanish` for Spanish.
Set `pronunciationLocale` explicitly if your provider uses an opaque voice ID;
it changes how the plugin makes references speakable, not the synthesis voice.

With Ollama, keep `provider.parameters` empty unless your version documents
the options you need. Its speech endpoint accepts WAV and PCM, does not expose
speech sampling controls, and currently accepts only `speed: 1`.

## Configuration

| Option | Default / description |
| --- | --- |
| `provider.type` | `openai-compatible` (`POST <baseUrl>/audio/speech`) or `custom`. |
| `provider.baseUrl` | `http://127.0.0.1:11434/v1`. Non-loopback endpoints must use HTTPS and specify a model. |
| `provider.model` | `lfm3-audio` for the loopback configuration unless overridden. |
| `provider.voice` | `female-american-english` with the default local `lfm3-audio`. Supply a provider voice ID, or use `null` to let the provider choose. |
| `provider.format` | `wav`. Also accepts `mp3`, `opus` (Ogg), `aac` (ADTS), `flac`, and `pcm`, when the endpoint supports them. |
| `provider.parameters` | Additional request fields documented by your provider. Cannot override `input`, `model`, `voice` or `response_format`. |
| `provider.apiKeyEnv` | Optional name of a shell environment variable containing a bearer token. Do not put the key itself in `cli.json`. |
| `player.command` | `ffplay` or an absolute path to it. |
| `player.volume` | `100` (0–100). |
| `player.pcmSampleRate`, `player.pcmChannels` | `24000`, `1`. Used only for signed little-endian 16-bit raw PCM. |
| `pronunciationLocale` | `en` or `es` for recognized English or Spanish voice IDs, otherwise `und` (neutral). Override with a locale such as `en-GB` or `es-MX`. |
| `maxChars`, `timeoutMs` | `4096` UTF-16 code units and `180000` ms per speech chunk. Use a smaller `maxChars` if your provider has a lower input limit. |
| `speakKey`, `stopKey` | `<leader>shift+s` and `escape`. Set either to `false` to disable that shortcut without removing the slash command. |

### Custom adapters

Use `provider.type: "custom"`, `provider.module` (an absolute path or `file:`
URL), and optional `provider.options` to load a trusted local JavaScript module
at the first speech request. It runs in the terminal process, so only load code
you trust. Default-export an async or sync `createProvider(options)` function
returning an object with:

```ts
synthesize(text: string, request: { signal: AbortSignal }): Promise<{
  stream: ReadableStream<Uint8Array>
  format: "wav" | "mp3" | "opus" | "aac" | "flac" | "pcm"
}>
```

Honor the abort signal and avoid putting text or credentials in error messages.
The plugin streams the returned bytes to the local player.

## Development

After installing the dependencies, run `pnpm test`. The test suite does not
require a live speech provider or audio device.

## License

[MIT](LICENSE). The license covers the plugin, not the speech models or external
tools it uses.
