import { createHash } from "node:crypto"
import { isIP } from "node:net"
import { resolveOpenAISpeechTarget } from "./provider.js"

const settingsTitle = "Text-to-speech settings"
const back = { title: "Back", value: "back" }
const defaultVoice = { title: "Provider default", value: "default" }
const isDefaultVoice = (voice) => voice === null || voice === "default"
const modeTitle = { manual: "Manual", automatic: "Automatic" }
const isMode = (value) => value === "manual" || value === "automatic"
const normalizeMode = (value) => isMode(value) ? value : "manual"
const identifier = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined
const record = (value) => value && typeof value === "object" && !Array.isArray(value)

function providerScope(provider = {}) {
  // Invalidate saved choices on config changes without storing endpoints or credentials.
  const json = JSON.stringify(provider, (_, value) => record(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
    : value)
  return createHash("sha256").update(json).digest("hex")
}

function speechTarget(provider = {}) {
  if (!record(provider) || (provider.type !== undefined && provider.type !== "openai-compatible")) return
  try {
    return resolveOpenAISpeechTarget(provider)
  } catch {
    // A broken provider configuration must not prevent changing playback mode or resetting.
  }
}

function ollamaOrigin(target) {
  // Ollama serves its native API at the root; don't probe a proxy with a different path.
  if (target?.url.pathname !== "/v1/audio/speech") return
  const { hostname, origin } = target.url
  if (hostname === "localhost" || hostname === "localhost." || hostname === "[::1]"
    || (isIP(hostname) === 4 && hostname.startsWith("127."))) return origin
}

class CatalogError extends Error {}

async function ollamaRequest(origin, path, signal, model) {
  signal.throwIfAborted()
  let response
  try {
    response = await fetch(new URL(`/api/${path}`, origin), {
      method: model === undefined ? "GET" : "POST",
      headers: model === undefined ? undefined : { "Content-Type": "application/json" },
      body: model === undefined ? undefined : JSON.stringify({ model }),
      credentials: "omit",
      redirect: "error",
      signal,
    })
  } catch {
    signal.throwIfAborted()
    throw new CatalogError("Could not reach local Ollama. Check that it is running and that the configured URL is correct.")
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new CatalogError(`Local Ollama could not read its model catalog (HTTP ${response.status}).`)
  }
  try {
    return await response.json()
  } catch {
    signal.throwIfAborted()
    throw new CatalogError("Local Ollama returned invalid catalog data.")
  }
}

const hasSpeech = (info) => Array.isArray(info?.capabilities) && info.capabilities.includes("speech")
const isRemoteModel = (info) => Boolean(info?.remote_model || info?.remote_host)
const isCloudName = (name) => /:(?:[^/]*-)?cloud$/i.test(name)

async function installedSpeechModels(origin, signal) {
  const list = await ollamaRequest(origin, "tags", signal)
  if (!Array.isArray(list?.models)) throw new CatalogError("Local Ollama did not return an installed model list.")
  const names = [...new Set(list.models
    .filter((entry) => !isRemoteModel(entry))
    .map((entry) => identifier(entry?.name) ?? identifier(entry?.model))
    .filter((name) => name && !isCloudName(name)))]
  const speech = []
  let failed
  for (let i = 0; i < names.length; i += 4) {
    await Promise.all(names.slice(i, i + 4).map(async (model) => {
      try {
        const info = await ollamaRequest(origin, "show", signal, model)
        if (hasSpeech(info) && !isRemoteModel(info)) speech.push(model)
      } catch (error) {
        signal.throwIfAborted()
        failed ??= error
      }
    }))
  }
  if (!speech.length) {
    if (failed) throw failed
    throw new CatalogError("No installed Ollama models advertise speech. Install a speech model in Ollama and try again.")
  }
  return speech.sort()
}

async function modelVoices(origin, signal, model) {
  if (isCloudName(model)) throw new CatalogError("The voice catalog only supports local Ollama models.")
  const info = await ollamaRequest(origin, "show", signal, model)
  if (isRemoteModel(info)) throw new CatalogError("The voice catalog only supports local Ollama models.")
  if (!hasSpeech(info)) throw new CatalogError("The current Ollama model does not advertise speech.")
  return Array.isArray(info.voices)
    ? [...new Set(info.voices.map(identifier).filter((voice) => voice && voice !== "default"))]
    : []
}

const nameChoice = (name) => ({ title: name, value: `name:${name}` })

export function createSettings(context, options = context.options ?? {}) {
  const [settings, updateSettings] = context.storage.store("settings", { initial: {} })
  const { dialog, toast } = context.ui
  let disposed = false
  let active
  let pendingDialog

  function getOptions() {
    const saved = settings[providerScope(options.provider)]
    const playbackMode = isMode(saved?.playbackMode) ? saved.playbackMode
      : normalizeMode(options.playbackMode)
    const merged = { ...options, playbackMode }
    const overrideModel = identifier(saved?.model)
    const voice = saved?.voice === null ? null : identifier(saved?.voice)
    if (overrideModel === undefined && voice === undefined) return merged
    const configured = speechTarget(options.provider)
    if (!ollamaOrigin(configured)) return merged

    const model = overrideModel ?? configured.model
    const overrides = {}
    if (overrideModel !== undefined) overrides.model = overrideModel
    if (voice !== undefined && saved.voiceModel === model) overrides.voice = voice
    else if (model !== configured.model) overrides.voice = null
    if (Object.keys(overrides).length) merged.provider = { ...options.provider, ...overrides }
    return merged
  }

  async function select(input) {
    const token = {}
    pendingDialog = token
    try {
      return await dialog.select(input)
    } finally {
      if (pendingDialog === token) pendingDialog = undefined
    }
  }

  async function catalog(kind, target, origin, signal) {
    const abort = new AbortController()
    const timeout = AbortSignal.timeout(5_000)
    const requestSignal = AbortSignal.any([signal, abort.signal, timeout])
    const model = kind === "model"
    const loading = select({ title: model ? "Finding speech models…" : "Finding voices…", options: [back] })
    const token = pendingDialog
    const request = model ? installedSpeechModels(origin, requestSignal) : modelVoices(origin, requestSignal, target.model)
    try {
      const result = await Promise.race([
        loading.then((choice) => ({ choice })),
        request.then((names) => ({ names }), (error) => ({ error })),
      ])
      if (signal.aborted) return
      if ("choice" in result) return result.choice
      // If Escape or a different dialog closed the loading screen, don't reopen it.
      if (pendingDialog !== token) return
      if ("error" in result) {
        const description = timeout.aborted ? "Local Ollama discovery timed out."
          : result.error instanceof CatalogError ? result.error.message : "Could not read the local Ollama catalog."
        return await select({
          title: model ? "Could not list speech models" : "Could not list voices",
          options: [{ ...back, description }],
        })
      }
      const choices = result.names.map(nameChoice)
      const voiceDefault = result.names.length ? defaultVoice
        : { ...defaultVoice, description: "Ollama did not list any named voices for this model." }
      const selected = model ? target.model : target.voice
      const current = model && result.names.includes(`${selected}:latest`) && !result.names.includes(selected)
        ? `${selected}:latest` : selected
      return await select({
        title: model ? "Speech model" : "Speech voice",
        current: !model && isDefaultVoice(current) ? defaultVoice.value : nameChoice(current).value,
        options: [...(model ? [] : [voiceDefault]), ...choices, back],
      })
    } finally {
      abort.abort()
    }
  }

  async function open() {
    if (disposed || active) return
    active = new AbortController()
    const { signal } = active
    try {
      while (!signal.aborted) {
        const scope = providerScope(options.provider)
        const current = getOptions()
        const target = speechTarget(current.provider)
        const origin = ollamaOrigin(target)
        const note = origin ? "" : " · Change in cli.json (catalog is local Ollama only)"
        const voice = !target ? "Configured by provider"
          : target.voice === null || (origin && isDefaultVoice(target.voice)) ? defaultVoice.title : target.voice
        const setting = await select({
          title: settingsTitle,
          options: [
            { title: "Mode", value: "mode", description: modeTitle[current.playbackMode] },
            { title: "Model", value: "model", description: `${target?.model ?? "Configured by provider"}${note}`, disabled: !origin },
            { title: "Voice", value: "voice", description: `${voice}${note}`, disabled: !origin },
            { title: "Reset", value: "reset", description: `Restore cli.json and defaults (${modeTitle[normalizeMode(options.playbackMode)]} mode).` },
          ],
        })
        if (signal.aborted || setting === undefined) return
        let change
        if (setting === "mode") {
          const destination = target ? `the speech provider (${target.url.hostname})` : "the configured speech provider"
          const mode = await select({
            title: "Playback mode",
            current: current.playbackMode,
            options: [
              { title: "Manual", value: "manual", description: "Read only when requested" },
              { title: "Automatic", value: "automatic", description: `Send filtered final answers to ${destination} without a separate request` },
              back,
            ],
          })
          if (mode === undefined) return
          if (mode === back.value) continue
          if (!isMode(mode)) return
          change = { playbackMode: mode }
        } else if ((setting === "model" || setting === "voice") && origin) {
          const choice = await catalog(setting, target, origin, signal)
          if (choice === undefined) return
          if (choice === back.value) continue
          const name = choice.startsWith("name:") ? choice.slice(5) : undefined
          if (setting === "model") {
            if (!name || name === target.model) continue
            change = { model: name, voice: null, voiceModel: name }
          } else {
            if (!name && choice !== defaultVoice.value) continue
            change = { voice: name ?? null, voiceModel: target.model }
          }
        } else if (setting !== "reset") {
          return
        }
        if (signal.aborted) return
        await updateSettings((draft) => {
          if (signal.aborted || providerScope(options.provider) !== scope) return
          if (setting === "reset") delete draft[scope]
          else {
            const saved = record(draft[scope]) ? draft[scope] : {}
            const configuredModel = speechTarget(options.provider)?.model
            if (setting === "voice" && (identifier(saved.model) ?? configuredModel) !== target.model) return
            draft[scope] = { ...saved, ...change }
          }
        })
      }
    } catch {
      if (!signal.aborted) {
        toast.show({ title: settingsTitle, message: "Could not update speech settings.", variant: "error" })
      }
    } finally {
      active = undefined
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    active?.abort()
    const owned = pendingDialog
    // Let a select already dismissed by the host settle before calling global clear.
    if (owned) queueMicrotask(() => {
      if (pendingDialog === owned) dialog.clear()
    })
  }

  return { getOptions, open, dispose }
}
