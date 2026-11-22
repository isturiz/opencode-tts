import assert from "node:assert/strict"
import test from "node:test"
import { createSettings } from "../lib/settings.js"

const menu = "Text-to-speech settings"
const wait = Symbol("wait")
const json = (value) => Response.json(value)

function ui(script = [], state = {}) {
  const dialogs = []
  const toasts = []
  let dismiss
  let cleared = 0
  let writes = 0
  const context = {
    storage: {
      store(key, options) {
        assert.equal(key, "settings")
        assert.deepEqual(options, { initial: {} })
        return [state, async (edit) => { writes++; edit(state) }]
      },
    },
    ui: {
      dialog: {
        select(input) {
          dismiss?.()
          dialogs.push(input)
          const { promise, resolve } = Promise.withResolvers()
          dismiss = (value) => {
            dismiss = undefined
            resolve(value)
          }
          if (input.title.startsWith("Finding") && script[0]?.[0] !== input.title) return promise
          const next = script.shift()
          if (!next) dismiss()
          else {
            const [title, choice] = next
            assert.equal(input.title, title)
            if (choice !== wait) {
              const option = input.options.find((option) => option.title === choice)
              if (choice !== undefined) assert.ok(option && !option.disabled, `Missing enabled choice: ${choice}`)
              dismiss(option?.value)
            }
          }
          return promise
        },
        clear() { cleared++; dismiss?.() },
      },
      toast: { show: (toast) => toasts.push(toast) },
    },
  }
  return {
    context, dialogs, toasts, state, cancel: () => dismiss?.(),
    get cleared() { return cleared },
    get writes() { return writes },
  }
}

test("prefers saved mode over cli.json and resets to cli.json without changing other options", async () => {
  const choices = ui([
    [menu, "Mode"], ["Playback mode", "Manual"],
    [menu, "Reset"], [menu],
  ])
  const options = Object.freeze({ playbackMode: "automatic", pronunciationLocale: "es-MX", player: { volume: 60 } })
  const settings = createSettings(choices.context, options)
  assert.deepEqual(settings.getOptions(), options)
  await settings.open()
  assert.equal(choices.dialogs[2].options[0].description, "Manual")
  assert.equal(choices.dialogs[3].options[0].description, "Automatic")
  assert.deepEqual(choices.state, {})
  assert.deepEqual(settings.getOptions(), options)
  assert.equal(createSettings(choices.context, { playbackMode: true }).getOptions().playbackMode, "manual")
})

test("discovers only installed local speech models and persists actual voice names", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.pathname === "/api/tags") {
      return json({ models: [
        { name: "demo:latest" }, { model: "chat:latest" }, { model: "demo:latest" },
        { name: "alias", remote_host: "https://upstream.example" }, { name: "x:cloud" }, { name: "x:8b-cloud" },
      ] })
    }
    const { model } = JSON.parse(init.body)
    if (model === "demo:latest") {
      return json({ capabilities: ["speech"], voices: ["voice-a", "default", "voice-b", "voice-b"] })
    }
    if (model === "chat:latest") return json({ capabilities: ["completion", "audio"] })
    assert.fail(`unexpected lookup: ${model}`)
  })
  const choices = ui([
    [menu, "Model"], ["Speech model", "demo:latest"],
    [menu, "Voice"], ["Speech voice", "voice-b"],
    [menu],
  ])
  const provider = Object.freeze({
    baseUrl: "http://127.0.0.1:15434/v1", apiKeyEnv: "TEST_PROVIDER_SECRET",
    model: "old-model", voice: "old-voice", format: "pcm", parameters: { speed: 1 },
  })
  const options = Object.freeze({ provider, pronunciationLocale: "en-GB", maxChars: 555 })
  const settings = createSettings(choices.context, options)
  assert.deepEqual(settings.getOptions(), { ...options, playbackMode: "manual" })
  await settings.open()

  assert.deepEqual(choices.toasts, [])
  assert.deepEqual(choices.dialogs[2].options.map(({ title }) => title), ["demo:latest", "Back"])
  assert.match(choices.dialogs[3].options[2].description, /Provider default/)
  assert.deepEqual(choices.dialogs[5].options.map(({ title }) => title), ["Provider default", "voice-a", "voice-b", "Back"])
  assert.deepEqual(settings.getOptions(), {
    ...options, playbackMode: "manual", provider: { ...provider, model: "demo:latest", voice: "voice-b" },
  })
  assert.doesNotMatch(JSON.stringify(choices.state), /127\.0\.0\.1|TEST_PROVIDER_SECRET|parameters|old-model/)
  assert.deepEqual(fetch.mock.calls.map(({ arguments: [url, init] }) => [
    url.href, init.method, init.body ? JSON.parse(init.body).model : null,
  ]), [
    ["http://127.0.0.1:15434/api/tags", "GET", null],
    ["http://127.0.0.1:15434/api/show", "POST", "demo:latest"],
    ["http://127.0.0.1:15434/api/show", "POST", "chat:latest"],
    ["http://127.0.0.1:15434/api/show", "POST", "demo:latest"],
  ])
  for (const { arguments: [, init] } of fetch.mock.calls) {
    assert.equal(new Headers(init.headers).has("authorization"), false)
    assert.equal(init.redirect, "error")
    assert.equal(init.credentials, "omit")
  }
})

test("empty voices still allow the null provider default, and reset restores resolved defaults", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => json({ capabilities: ["speech"] }))
  const choices = ui([[menu, "Voice"], ["Speech voice", "Provider default"], [menu]])
  const settings = createSettings(choices.context)
  await settings.open()
  assert.match(choices.dialogs[0].options[1].description, /lfm3-audio/)
  assert.match(choices.dialogs[0].options[2].description, /female-american-english/)
  assert.match(choices.dialogs[2].options[0].description, /did not list any named voices/)
  assert.equal(JSON.parse(fetch.mock.calls[0].arguments[1].body).model, "lfm3-audio")
  assert.deepEqual(settings.getOptions(), { playbackMode: "manual", provider: { voice: null } })

  const reset = ui([[menu, "Reset"], [menu]], choices.state)
  const reloaded = createSettings(reset.context)
  await reloaded.open()
  assert.deepEqual(reloaded.getOptions(), { playbackMode: "manual" })
})

test("highlights Provider default for the literal default voice and keeps other named voices", async (t) => {
  t.mock.method(globalThis, "fetch", async () => json({
    capabilities: ["speech"], voices: ["default", "Default", "default-narrator"],
  }))
  const choices = ui([[menu, "Voice"], ["Speech voice"]])
  const settings = createSettings(choices.context, { provider: { voice: "default" } })
  await settings.open()
  assert.equal(choices.dialogs[0].options[2].description, "Provider default")
  const voiceDialog = choices.dialogs[2]
  assert.deepEqual(voiceDialog.options.map(({ title }) => title), ["Provider default", "Default", "default-narrator", "Back"])
  assert.equal(voiceDialog.current, voiceDialog.options[0].value)
  assert.deepEqual(settings.getOptions().provider, { voice: "default" })
  assert.equal(choices.writes, 0)
})

test("remote and custom providers never run discovery, but can explicitly opt into automatic playback", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("unexpected discovery"))
  const provider = { baseUrl: "https://speech.example/v1", model: "remote", apiKeyEnv: "REMOTE_KEY" }
  const choices = ui([[menu, "Mode"], ["Playback mode", "Automatic"], [menu]])
  await createSettings(choices.context, { provider }).open()
  assert.equal(choices.dialogs[0].options[1].disabled, true)
  assert.equal(choices.dialogs[0].options[2].disabled, true)
  assert.match(choices.dialogs[1].options[1].description, /speech\.example/)
  assert.doesNotMatch(JSON.stringify(choices.state), /speech\.example|REMOTE_KEY/)
  const reload = createSettings(choices.context, { provider: { ...provider } })
  assert.deepEqual(reload.getOptions(), { provider, playbackMode: "automatic" })
  for (const changed of [
    { ...provider, baseUrl: "https://other.example/v1" },
    { ...provider, apiKeyEnv: "OTHER_KEY" },
    { ...provider, model: "other" },
  ]) {
    assert.equal(createSettings(choices.context, { provider: changed }).getOptions().playbackMode, "manual")
  }
  const customUI = ui([[menu, "Mode"], ["Playback mode", "Automatic"], [menu]], choices.state)
  const custom = { type: "custom", module: "/speech.mjs", options: { destination: "private" } }
  const customSettings = createSettings(customUI.context, { provider: custom })
  assert.equal(customSettings.getOptions().playbackMode, "manual")
  await customSettings.open()
  assert.equal(customUI.dialogs[0].options[1].disabled, true)
  assert.deepEqual(customSettings.getOptions(), { provider: custom, playbackMode: "automatic" })
  assert.equal(fetch.mock.callCount(), 0)
})

test("changed endpoints do not take local model overrides or automatic mode", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => url.pathname === "/api/tags"
    ? json({ models: [{ name: "replacement" }] }) : json({ capabilities: ["speech"] }))
  const options = { provider: { model: "original", voice: "original-voice" } }
  const choices = ui([
    [menu, "Model"], ["Speech model", "replacement"],
    [menu, "Mode"], ["Playback mode", "Automatic"], [menu],
  ])
  const settings = createSettings(choices.context, options)
  await settings.open()
  assert.deepEqual(settings.getOptions(), { provider: { model: "replacement", voice: null }, playbackMode: "automatic" })
  options.provider.baseUrl = "https://new.example/v1"
  assert.deepEqual(settings.getOptions(), { ...options, playbackMode: "manual" })
  delete options.provider.baseUrl
  assert.deepEqual(settings.getOptions(), { provider: { model: "replacement", voice: null }, playbackMode: "automatic" })
})

test("shows actionable errors for empty, failed, and invalid catalog responses without changing settings", async (t) => {
  const replies = [
    [json({ models: [] }), /No installed Ollama models advertise speech/],
    [new Response("private detail", { status: 503 }), /HTTP 503/],
    [json({ unexpected: [] }), /did not return an installed model list/],
  ]
  t.mock.method(globalThis, "fetch", async () => replies.shift()[0])
  for (const [, expected] of [...replies]) {
    const choices = ui([[menu, "Model"], ["Could not list speech models", "Back"], [menu]])
    const settings = createSettings(choices.context, { pronunciationLocale: "es" })
    await settings.open()
    assert.match(choices.dialogs[2].options[0].description, expected)
    assert.doesNotMatch(choices.dialogs[2].options[0].description, /private detail/)
    assert.equal(choices.writes, 0)
    assert.deepEqual(settings.getOptions(), { pronunciationLocale: "es", playbackMode: "manual" })
  }
})

test("Back returns to settings and Escape cancels without a write", async () => {
  const choices = ui([[menu, "Mode"], ["Playback mode", "Back"], [menu, "Mode"], ["Playback mode"]])
  await createSettings(choices.context).open()
  assert.equal(choices.dialogs.length, 4)
  assert.equal(choices.writes, 0)
})

test("disposing during discovery aborts fetch, clears the owned dialog, and cannot reopen it", async (t) => {
  const { promise: requested, resolve: requestStarted } = Promise.withResolvers()
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    requestStarted(signal)
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  })
  const choices = ui([[menu, "Model"]])
  const settings = createSettings(choices.context)
  const opening = settings.open()
  const signal = await requested
  await settings.open() // An overlapping command does not create another dialog.
  settings.dispose()
  settings.dispose()
  await opening
  await settings.open()
  assert.equal(signal.aborted, true)
  assert.equal(choices.cleared, 1)
  assert.equal(choices.dialogs.length, 2)
  assert.equal(choices.writes, 0)
  assert.deepEqual(choices.toasts, [])
})

test("Escape during discovery aborts it without reopening the menu", async (t) => {
  const { promise: requested, resolve: requestStarted } = Promise.withResolvers()
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    requestStarted(signal)
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  })
  const choices = ui([[menu, "Voice"]])
  const settings = createSettings(choices.context)
  const opening = settings.open()
  const signal = await requested
  choices.cancel()
  await opening
  assert.equal(signal.aborted, true)
  assert.equal(choices.cleared, 0)
  assert.equal(choices.dialogs.length, 2)
  assert.equal(choices.writes, 0)
})

test("dispose does not close a different dialog that already replaced settings", async () => {
  const choices = ui([[menu, wait], ["Unrelated", wait]])
  const settings = createSettings(choices.context)
  const opening = settings.open()
  const foreign = choices.context.ui.dialog.select({ title: "Unrelated", options: [] })
  settings.dispose()
  await opening
  assert.equal(choices.cleared, 0)
  choices.cancel()
  await foreign
})
