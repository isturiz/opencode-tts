import { realpath, stat } from "node:fs/promises"
import { isIP } from "node:net"
import { extname, isAbsolute } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { types } from "node:util"

const defaultBaseUrl = "http://127.0.0.1:11434/v1"
const defaultModel = "lfm3-audio"
const formats = new Set(["wav", "mp3", "opus", "aac", "flac", "pcm"])
const reservedParameters = ["input", "model", "voice", "response_format"]
const binaryMediaTypes = new Set([
  "application/octet-stream", "binary/octet-stream",
  "application/wav", "application/x-wav",
  "application/ogg", "application/x-ogg", "application/opus", "application/flac", "application/x-flac",
])
const javascriptExtensions = new Set([".js", ".mjs", ".cjs"])

function isObject(value) {
  if (value === null || typeof value !== "object") return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cloneJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || Number.isFinite(value)) {
    return value
  }
  const array = Array.isArray(value)
  if ((!array && !isObject(value)) || ancestors.has(value)) throw new TypeError()
  ancestors.add(value)
  const copy = array
    ? Array.from(value, (item) => cloneJson(item, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item, ancestors)]))
  ancestors.delete(value)
  return copy
}

function jsonObject(value = {}, field) {
  try {
    if (isObject(value)) return cloneJson(value)
  } catch {
    // Report the invalid field without including its contents.
  }
  throw new TypeError(`provider.${field} must be a JSON object`)
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be a non-empty string`)
  return value.trim()
}

function checkKeys(config, allowed) {
  if (Object.keys(config).some((name) => !allowed.includes(name))) {
    const fields = allowed.map((name) => `provider.${name}`).join(", ")
    throw new TypeError(`Unsupported speech provider option; allowed fields: ${fields}`)
  }
}

function speechEndpoint(baseUrl) {
  const value = requiredString(baseUrl, "provider.baseUrl")
  const authority = /^https?:\/\/([^/]+)/i.exec(value)?.[1]
  if (!authority || authority.includes("@") || /[?#\\\s]/.test(value)) {
    throw new TypeError("provider.baseUrl must be an absolute HTTP(S) URL without credentials, a query, or a fragment")
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("provider.baseUrl is not a valid URL")
  }
  const host = url.hostname
  const loopback = host === "localhost" || host === "localhost." || host === "[::1]"
    || (isIP(host) === 4 && host.startsWith("127."))
  if (!loopback && url.protocol !== "https:") {
    throw new TypeError("provider.baseUrl must use HTTPS for non-loopback hosts")
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/audio/speech`
  return { url, loopback }
}

function speechHeaders(apiKeyEnv) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "audio/*, application/octet-stream",
  }
  if (apiKeyEnv !== undefined) {
    if (typeof apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      throw new TypeError("provider.apiKeyEnv must be an environment variable name")
    }
    const key = process.env[apiKeyEnv]
    if (!key) throw new Error("The environment variable configured by provider.apiKeyEnv is not set")
    if (!/^[\x21-\x7e]+$/.test(key)) throw new Error("The speech provider API key is not a valid bearer token")
    headers.Authorization = `Bearer ${key}`
  }
  return headers
}

function abortError() {
  return new DOMException("Speech synthesis was aborted", "AbortError")
}

// Preserve backpressure and cancellation while keeping source errors out of the UI.
function audioStream(stream, signal) {
  const reader = stream.getReader()
  let cancelled = false
  async function cancel() {
    cancelled = true
    try {
      await reader.cancel()
    } catch {
      // Ignore errors while discarding audio.
    } finally {
      reader.releaseLock()
    }
  }
  return new ReadableStream({
    async pull(controller) {
      let result
      try {
        result = await reader.read()
      } catch {
        if (cancelled) return
        reader.releaseLock()
        controller.error(signal?.aborted ? abortError() : new Error("The speech audio stream was interrupted"))
        return
      }
      if (cancelled) return
      if (result.done) {
        reader.releaseLock()
        controller.close()
      } else if (!types.isUint8Array(result.value)) {
        controller.error(new Error("The speech provider returned a non-byte audio chunk"))
        await cancel()
      } else {
        controller.enqueue(result.value)
      }
    },
    cancel,
  }, { highWaterMark: 0 })
}

function openaiCompatible(config) {
  checkKeys(config, ["type", "baseUrl", "model", "voice", "format", "apiKeyEnv", "parameters"])
  const { baseUrl = defaultBaseUrl, format = "wav", apiKeyEnv } = config
  const { url, loopback } = speechEndpoint(baseUrl)
  if (!loopback && config.model === undefined) {
    throw new TypeError("Set provider.model explicitly for a non-loopback speech provider")
  }
  const model = requiredString(config.model === undefined ? defaultModel : config.model, "provider.model")
  const defaultVoice = loopback && model === defaultModel ? "female-spanish" : null
  const { voice = defaultVoice } = config
  const selectedVoice = voice === null ? null : requiredString(voice, "provider.voice")
  if (!formats.has(format)) throw new TypeError("provider.format must be wav, mp3, opus, aac, flac, or pcm")
  const parameters = jsonObject(config.parameters, "parameters")
  for (const field of reservedParameters) {
    if (Object.hasOwn(parameters, field)) throw new TypeError(`provider.parameters cannot set reserved field ${field}`)
  }
  const headers = speechHeaders(apiKeyEnv)

  return {
    async synthesize(text, { signal } = {}) {
      if (signal?.aborted) throw abortError()
      requiredString(text, "Speech input")
      const request = { ...parameters, input: text, model, response_format: format }
      if (selectedVoice !== null) request.voice = selectedVoice
      let response
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal,
          redirect: "error",
        })
      } catch {
        if (signal?.aborted) throw abortError()
        throw new Error("Speech request failed; check the provider URL and connection (redirects are not followed)")
      }
      if (signal?.aborted) {
        void response.body?.cancel().catch(() => {})
        throw abortError()
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new Error(`Speech request failed (HTTP ${response.status})`)
      }
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
      if (!response.body || response.headers.get("content-length") === "0"
        || (mediaType && !mediaType.startsWith("audio/") && !binaryMediaTypes.has(mediaType))) {
        void response.body?.cancel().catch(() => {})
        throw new Error("Speech provider response did not contain audio")
      }
      return { stream: audioStream(response.body, signal), format }
    },
  }
}

function adapterPath(specifier) {
  const value = requiredString(specifier, "provider.module")
  if (isAbsolute(value)) return value
  try {
    if (/^file:\//i.test(value) && !/[?#\\]/.test(value)) {
      const url = new URL(value)
      if (url.protocol === "file:" && !url.hostname) return fileURLToPath(url)
    }
  } catch {
    // Invalid file URLs use the same configuration error as a non-local path.
  }
  throw new TypeError("provider.module must be an absolute local JavaScript path or file: URL")
}

async function customProvider(config) {
  checkKeys(config, ["type", "module", "options"])
  const path = adapterPath(config.module)
  const options = jsonObject(config.options, "options")
  if (!javascriptExtensions.has(extname(path))) throw new TypeError("provider.module must be a local JavaScript file")
  let localPath
  try {
    localPath = await realpath(path)
    if (!(await stat(localPath)).isFile()) throw new TypeError()
  } catch {
    throw new Error("Could not resolve the custom speech provider module to a local file")
  }
  if (!javascriptExtensions.has(extname(localPath))) throw new TypeError("provider.module must be a local JavaScript file")

  // An explicitly configured module is trusted code, not a sandbox.
  let module
  try {
    module = await import(pathToFileURL(localPath).href)
  } catch {
    throw new Error("Could not load the custom speech provider module")
  }
  if (typeof module.default !== "function") throw new TypeError("The custom speech module must default-export createProvider(options)")
  let adapter
  try {
    adapter = await module.default(options)
  } catch {
    throw new Error("Could not initialize the custom speech provider")
  }
  if (typeof adapter?.synthesize !== "function") throw new TypeError("The custom speech provider must expose synthesize(text, { signal })")

  return {
    async synthesize(text, { signal } = {}) {
      if (signal?.aborted) throw abortError()
      requiredString(text, "Speech input")
      let stream, format
      try {
        const result = await adapter.synthesize(text, { signal })
        stream = result?.stream
        format = result?.format
      } catch {
        if (signal?.aborted) throw abortError()
        throw new Error("The custom speech provider could not synthesize audio")
      }
      const readable = stream instanceof ReadableStream && !stream.locked
      if (signal?.aborted || !readable || !formats.has(format)) {
        if (readable) void stream.cancel().catch(() => {})
        if (signal?.aborted) throw abortError()
        throw new TypeError("The custom speech provider must return an audio ReadableStream and a supported format")
      }
      return { stream: audioStream(stream, signal), format }
    },
  }
}

export async function createSpeechProvider(options = {}) {
  if (!isObject(options)) throw new TypeError("Speech provider options must be an object")
  const { provider = {} } = options
  if (!isObject(provider)) throw new TypeError("provider must be an object")
  const { type = "openai-compatible" } = provider
  if (type === "openai-compatible") return openaiCompatible(provider)
  if (type === "custom") return customProvider(provider)
  throw new TypeError("Unsupported speech provider type; expected openai-compatible or custom")
}
