import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { createSpeechProvider } from "../lib/provider.js"

async function readAudio(stream) {
  return [...new Uint8Array(await new Response(stream).arrayBuffer())]
}

async function listen(t, handle) {
  const server = createServer(handle)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(async () => {
    const closed = once(server, "close")
    server.close()
    server.closeAllConnections()
    await closed
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function adapterFile(t, source, name = "adapter.mjs") {
  const directory = await mkdtemp(join(tmpdir(), "opencode-tts-provider-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, name)
  await writeFile(file, source)
  return file
}

test("local defaults request Spanish WAV and return audio bytes", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    new Response(Uint8Array.of(1, 2), { headers: { "content-type": "Audio/WAV; codec=pcm" } }))
  const provider = await createSpeechProvider()
  const { stream, format } = await provider.synthesize(" Hola ")
  assert.equal(format, "wav")
  assert.ok(stream instanceof ReadableStream)
  assert.deepEqual(await readAudio(stream), [1, 2])
  assert.equal(fetch.mock.callCount(), 1)
  const [url, request] = fetch.mock.calls[0].arguments
  assert.equal(String(url), "http://127.0.0.1:11434/v1/audio/speech")
  assert.equal(request.method, "POST")
  assert.equal(request.redirect, "error")
  const headers = new Headers(request.headers)
  assert.equal(headers.get("content-type"), "application/json")
  assert.equal(headers.get("authorization"), null)
  assert.deepEqual(JSON.parse(request.body), {
    input: " Hola ",
    model: "lfm3-audio",
    voice: "female-spanish",
    response_format: "wav",
  })
})

test("uses the configured path prefix, model, voice, format, env key and nested parameters", async (t) => {
  let received
  const baseUrl = await listen(t, async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received = {
      path: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    }
    response.writeHead(200, { "content-type": "application/octet-stream" })
    response.end(Buffer.from([5, 6, 7]))
  })
  const apiKeyEnv = "OPENCODE_TTS_TEST_PROVIDER_KEY"
  const previousKey = process.env[apiKeyEnv]
  process.env[apiKeyEnv] = "test-only-key"
  t.after(() => {
    if (previousKey === undefined) delete process.env[apiKeyEnv]
    else process.env[apiKeyEnv] = previousKey
  })
  const parameters = { speed: 1.2, instructions: "Speak calmly", extras: { values: [true, null, "x"] } }
  const provider = await createSpeechProvider({ provider: {
    baseUrl: `${baseUrl}/prefix/v1///`, model: "example", voice: "example-voice",
    format: "opus", parameters, apiKeyEnv,
  } })
  parameters.extras.values[0] = false
  const { stream, format } = await provider.synthesize("Good morning")
  assert.equal(format, "opus")
  assert.deepEqual(await readAudio(stream), [5, 6, 7])
  assert.deepEqual(received, {
    path: "/prefix/v1/audio/speech",
    authorization: "Bearer test-only-key",
    body: {
      input: "Good morning", model: "example", voice: "example-voice", response_format: "opus",
      speed: 1.2, instructions: "Speak calmly", extras: { values: [true, null, "x"] },
    },
  })
})

test("supports remote HTTPS with an explicit model and sends no implicit Spanish voice", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(Uint8Array.of(1)))
  for (const config of [
    { baseUrl: "https://speech.example/v1", model: "lfm3-audio" },
    { baseUrl: "http://[::1]:11434/v1", model: "another-local-model" },
    { voice: null },
  ]) {
    const provider = await createSpeechProvider({ provider: config })
    const { stream } = await provider.synthesize("Speak")
    await stream.cancel()
  }
  assert.equal(String(fetch.mock.calls[0].arguments[0]), "https://speech.example/v1/audio/speech")
  for (const { arguments: [, request] } of fetch.mock.calls) {
    assert.equal(Object.hasOwn(JSON.parse(request.body), "voice"), false)
  }
})

test("rejects unsupported configuration before sending text", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("unexpected fetch"))
  for (const provider of [false, null, "openai-compatible", []]) {
    await assert.rejects(createSpeechProvider({ provider }), /provider must be an object/)
  }
  const invalidConfigs = [
    [{ type: "ollama" }, /Unsupported speech provider type/],
    [{ type: false }, /Unsupported speech provider type/],
    [{ format: "ogg" }, /provider\.format/],
    [{ model: " " }, /provider\.model/],
    [{ voice: false }, /provider\.voice/],
    [{ parameters: null }, /provider\.parameters/],
    [{ parameters: { extras: { bad: undefined } } }, /provider\.parameters/],
    [{ parameters: { speed: Infinity } }, /provider\.parameters/],
    [{ apiKey: "not-an-env-key" }, /provider\.apiKeyEnv/],
    [{ apiKeyEnv: "not a variable" }, /environment variable name/],
    [{ baseUrl: "http://speech.example/v1", model: "tts" }, /must use HTTPS/],
    [{ baseUrl: "http://localhost.speech.example/v1", model: "tts" }, /must use HTTPS/],
    [{ baseUrl: "https://speech.example/v1" }, /Set provider\.model explicitly/],
  ]
  for (const [provider, pattern] of invalidConfigs) {
    await assert.rejects(createSpeechProvider({ provider }), pattern)
  }
  for (const field of ["input", "model", "voice", "response_format"]) {
    await assert.rejects(
      createSpeechProvider({ provider: { parameters: { [field]: "override" } } }),
      /reserved field/,
    )
  }
  for (const baseUrl of [
    "http://u:password@localhost/v1", "http://@localhost/v1", "http://localhost/v1?",
    "http://localhost/v1#secret", "http://localhost\\@example.com", "/v1",
    "ftp://localhost/v1",
  ]) {
    await assert.rejects(createSpeechProvider({ provider: { baseUrl } }), (error) => {
      assert.match(error.message, /provider\.baseUrl/)
      assert.doesNotMatch(error.message, /password|secret/)
      return true
    })
  }
  const provider = await createSpeechProvider()
  await assert.rejects(provider.synthesize("\n"), /Speech input/)
  assert.equal(fetch.mock.callCount(), 0)
})

test("requires the selected env key and never contacts a fallback backend", async (t) => {
  const apiKeyEnv = `OPENCODE_TTS_TEST_MISSING_${process.pid}`
  assert.equal(process.env[apiKeyEnv], undefined)
  await assert.rejects(createSpeechProvider({ provider: { apiKeyEnv } }), /API|apiKeyEnv/)
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("backend echoed transcript and test-only-key")
  })
  const provider = await createSpeechProvider()
  await assert.rejects(provider.synthesize("transcript"), (error) => {
    assert.match(error.message, /check the provider URL and connection/)
    assert.doesNotMatch(String(error), /transcript|test-only-key/)
    assert.equal(error.cause, undefined)
    return true
  })
  assert.equal(fetch.mock.callCount(), 1)
})

test("does not follow redirects to another port", async (t) => {
  let redirected = false
  const destination = await listen(t, (_request, response) => {
    redirected = true
    response.writeHead(200, { "content-type": "audio/wav" }).end(Buffer.from([1]))
  })
  const origin = await listen(t, (_request, response) => {
    response.writeHead(307, { location: `${destination}/audio/speech` }).end()
  })
  const provider = await createSpeechProvider({ provider: { baseUrl: origin } })
  await assert.rejects(provider.synthesize("private transcript"), /redirects are not followed/)
  assert.equal(redirected, false)
})

test("rejects HTTP failures and obvious successful non-audio without reading backend text", async (t) => {
  const samples = [
    [new Response("backend echoed the secret", { status: 401 }), /HTTP 401/],
    [new Response('{"error":"secret"}', { headers: { "content-type": "application/problem+json" } }), /did not contain audio/],
    [new Response("<html>secret</html>", { headers: { "content-type": "text/html; charset=utf-8" } }), /did not contain audio/],
    [new Response(null, { status: 204 }), /did not contain audio/],
    [new Response("", { headers: { "content-type": "audio/wav", "content-length": "0" } }), /did not contain audio/],
  ]
  t.mock.method(globalThis, "fetch", async () => samples.shift()[0])
  const provider = await createSpeechProvider()
  for (const [, expected] of [...samples]) {
    await assert.rejects(provider.synthesize("secret"), (error) => {
      assert.match(error.message, expected)
      assert.doesNotMatch(String(error), /secret/)
      return true
    })
  }
})

test("aborts a pending fetch and never sends an already-aborted request", { timeout: 5000 }, async (t) => {
  let seen
  const requestSeen = new Promise((resolve) => { seen = resolve })
  let requests = 0
  const baseUrl = await listen(t, (request) => {
    requests++
    request.resume()
    seen()
  })
  const provider = await createSpeechProvider({ provider: { baseUrl } })
  const abort = new AbortController()
  const pending = provider.synthesize("secret", { signal: abort.signal })
  await requestSeen
  abort.abort(new Error("private abort reason"))
  const expectAbort = (error) => {
    assert.equal(error.name, "AbortError")
    assert.doesNotMatch(error.message, /secret|private/)
    return true
  }
  await assert.rejects(pending, expectAbort)
  await assert.rejects(provider.synthesize("secret", { signal: abort.signal }), expectAbort)
  assert.equal(requests, 1)
})

test("streams audio before the HTTP response finishes and aborts a pending read", { timeout: 5000 }, async (t) => {
  const baseUrl = await listen(t, (request, response) => {
    request.resume()
    response.writeHead(200, { "content-type": "audio/wav" })
    response.write(Buffer.from([1, 2]))
  })
  const provider = await createSpeechProvider({ provider: { baseUrl } })
  const abort = new AbortController()
  const { stream } = await provider.synthesize("Start streaming", { signal: abort.signal })
  const reader = stream.getReader()
  assert.deepEqual(await reader.read(), { done: false, value: Uint8Array.of(1, 2) })
  const pendingRead = reader.read()
  abort.abort()
  await assert.rejects(pendingRead, { name: "AbortError" })
  reader.releaseLock()
})

test("loads trusted custom adapters by absolute path and file URL, passing options and signal", async (t) => {
  const file = await adapterFile(t, `
    export default async function createProvider(options) {
      return {
        prefix: options.speech.prefix,
        synthesize(text, { signal }) {
          const bytes = new TextEncoder().encode(this.prefix + text + ":" + (signal instanceof AbortSignal))
          return {
            format: "pcm",
            stream: new ReadableStream({ start(controller) {
              controller.enqueue(bytes)
              controller.close()
            } }),
          }
        },
      }
    }
  `)
  for (const module of [file, pathToFileURL(file).href]) {
    const provider = await createSpeechProvider({ provider: {
      type: "custom", module, options: { speech: { prefix: "Demo: " } },
    } })
    const { stream, format } = await provider.synthesize("Hola", { signal: new AbortController().signal })
    assert.equal(format, "pcm")
    assert.equal(await new Response(stream).text(), "Demo: Hola:true")
  }
})

test("rejects remote or non-JavaScript adapters and invalid adapter contracts", async (t) => {
  const create = (module) => createSpeechProvider({ provider: { type: "custom", module } })
  for (const specifier of ["https://speech.example/adapter.mjs", "file://remote.example/adapter.mjs",
    "data:text/javascript,export default 1", "node:os", "./adapter.mjs"]) {
    await assert.rejects(create(specifier), /absolute local JavaScript/)
  }
  const jsonFile = await adapterFile(t, "{}", "adapter.json")
  await assert.rejects(create(jsonFile), /local JavaScript file/)
  const noDefault = await adapterFile(t, "export const factory = () => ({})")
  await assert.rejects(create(noDefault), /default-export createProvider/)
  const noSynthesize = await adapterFile(t, "export default function createProvider() { return {} }")
  await assert.rejects(create(noSynthesize), /must expose synthesize/)
  const badResult = await adapterFile(t, `
    export default () => ({
      synthesize: () => ({ stream: new ReadableStream(), format: "ogg" })
    })
  `)
  const provider = await create(badResult)
  await assert.rejects(provider.synthesize("Hola"), /supported format/)
  await assert.rejects(createSpeechProvider({ provider: {
    type: "custom", module: badResult, options: false,
  } }), /provider\.options must be a JSON object/)
})

test("cancels custom audio on consumer request and rejects non-byte chunks", async (t) => {
  const file = await adapterFile(t, `
    export default () => {
      let cancelled = false
      return {
        synthesize(text) {
          return {
            format: "mp3",
            stream: new ReadableStream({
              start(controller) { if (text !== "cancel") controller.enqueue(cancelled ? "bad chunk" : Uint8Array.of(1)) },
              cancel() { cancelled = true },
            })
          }
        },
      }
    }
  `)
  const provider = await createSpeechProvider({ provider: { type: "custom", module: file } })
  const { stream } = await provider.synthesize("cancel")
  const reader = stream.getReader()
  const pending = reader.read()
  await reader.cancel()
  assert.deepEqual(await pending, { done: true, value: undefined })
  const invalid = await provider.synthesize("Hola")
  await assert.rejects(invalid.stream.getReader().read(), /non-byte audio chunk/)
})

test("sanitizes errors thrown by a custom adapter or its audio stream", async (t) => {
  const file = await adapterFile(t, `
    export default () => ({
      synthesize(text) {
        if (text === "fail") throw new Error("private transcript and key")
        return { format: "aac", stream: new ReadableStream({
          pull() { throw new Error("private transcript and key") },
        }) }
      },
    })
  `)
  const provider = await createSpeechProvider({ provider: { type: "custom", module: file } })
  const sanitized = (pattern) => (error) => {
    assert.match(error.message, pattern)
    assert.doesNotMatch(String(error), /private transcript|key/)
    assert.equal(error.cause, undefined)
    return true
  }
  await assert.rejects(provider.synthesize("fail"), sanitized(/could not synthesize audio/))
  const { stream } = await provider.synthesize("speak")
  await assert.rejects(stream.getReader().read(), sanitized(/audio stream was interrupted/))
})
