# OpenCode TTS

A text-to-speech-only plugin for the OpenCode V2 terminal. Continue using Hex for
dictation. The plugin sends only prose from the final, completed answer in the
visible session. It skips earlier turns and tool steps, reasoning, code
blocks and inline code expressions, tables, raw HTML and images. Short
technical names embedded in prose are kept and adapted for pronunciation,
including model names used as link labels (the URL itself is not read).
Mentions such as `@reviewer` are also pronounced, including in inline code.
Recognized user directories are described by purpose: for example,
`~/.config/alacritty/alacritty.toml` is read as “your alacritty configuration”
in English, without reading the path. In Spanish and English, clearly marked
inline paths with no known role are referred to as the path shown on screen.
These substitutions do not infer what was installed or changed.
It also skips headings for sections without readable prose and short standalone labels
that only introduce an omitted block. Labels are recognized by their Markdown
structure, not their wording or the skill that generated them. It neither
changes the transcript nor calls a second language model to rewrite the answer.

## Setup

Use the [OpenCode V2 terminal client](https://opencode.ai/docs/), Node.js 22 or
later, and pnpm. This plugin is loaded from a local checkout; no npm
installation of the plugin is needed.

The default uses Ollama with `lfm3-audio` and its `female-spanish` voice. Pull the
model with `ollama pull lfm3-audio` if needed. Audio is played locally with
`ffplay` (part of FFmpeg; `brew install ffmpeg` on macOS). No Piper or microphone
access is required.

```sh
git clone https://github.com/isturiz/opencode-tts.git
cd opencode-tts
pnpm install --frozen-lockfile
```

In `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`), add
the absolute path to your checkout to the existing `plugins` array:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-tts",
      "options": {
        "provider": {
          "type": "openai-compatible",
          "baseUrl": "http://127.0.0.1:11434/v1",
          "model": "lfm3-audio",
          "voice": "female-spanish",
          "format": "wav",
          "parameters": {}
        }
      }
    }
  ]
}
```

Use `/tts-speak` or `leader`, then `Shift+S` to read the last answer. Use
`/tts-stop` or `Esc` to cancel synthesis and playback. `Esc` is left to OpenCode
when there is nothing to stop. Playback is manual; the plugin does not send
answers anywhere until you request speech. A successful background follow-up
with no visible assistant text does not replace the last answer.

## Configuration

| Option | Default / description |
| --- | --- |
| `provider.type` | `openai-compatible` (`POST <baseUrl>/audio/speech`) or `custom`. |
| `provider.baseUrl` | `http://127.0.0.1:11434/v1`. Non-loopback endpoints must use HTTPS and specify a model. |
| `provider.model` | `lfm3-audio` for the loopback configuration unless overridden. |
| `provider.voice` | `female-spanish` with the default local `lfm3-audio`; use `null` to omit it or supply a provider voice ID. |
| `provider.format` | `wav`. Also accepts `mp3`, `opus` (Ogg), `aac` (ADTS), `flac`, and `pcm`, when the endpoint supports them. |
| `provider.parameters` | Additional request fields documented by your provider. Cannot override `input`, `model`, `voice` or `response_format`. |
| `provider.apiKeyEnv` | Optional name of a shell environment variable containing a bearer token. Do not put the key itself in `cli.json`. |
| `player.command` | `ffplay` or an absolute path to it. |
| `player.volume` | `100` (0–100). |
| `player.pcmSampleRate`, `player.pcmChannels` | `24000`, `1`. Used only for signed little-endian 16-bit raw PCM. |
| `pronunciationLocale` | `es` for the default Ollama Spanish voice or a recognized Spanish voice ID, otherwise `und` (neutral). Override with a locale such as `es-MX` when the provider uses an opaque voice ID. This only changes how technical references and path descriptions are formatted, not the voice. |
| `maxChars`, `timeoutMs` | `4096` UTF-16 code units and `180000` ms per speech chunk. Use a smaller `maxChars` if your provider has a lower input limit. |
| `speakKey`, `stopKey` | `<leader>shift+s` and `escape`. Set either to `false` to disable that shortcut without removing the slash command. |

An explicitly configured remote provider receives the filtered answer text.
There is no automatic fallback to any other provider and redirects are not
followed. Provider settings are independent of the model OpenCode uses to
answer your prompts.

### Tuning Ollama speech

Run `ollama show lfm3-audio` to list its voices. To compare Spanish voices,
keep the text and model fixed and switch `provider.voice` between
`female-spanish` and `male-spanish`. Keep WAV unless you need raw PCM:
both carry the same 24 kHz mono audio.

With Ollama's `/v1/audio/speech`, `speed` only accepts `1`, nonempty
`instructions` is rejected, and the endpoint does not expose speech sampling
controls. Leave `provider.parameters` empty for this setup. `player.volume`
changes loudness only. `maxChars` changes how the plugin divides long answers
into requests, not how the model pronounces or paces a sentence.

### Non-compatible providers

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
The plugin streams the returned bytes to the local player. Run tests with
`pnpm test`.

## License

[MIT](LICENSE). The license covers the plugin, not the speech models or external
tools it uses.
