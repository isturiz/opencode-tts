import assert from "node:assert/strict";
import test from "node:test";
import { chunkSpeech, finalResponseText, speechText } from "../lib/text.js";

const user = { type: "user" };
const done = { type: "idle", outcome: "succeeded" };
const text = (value) => ({ type: "text", text: value });
const synthetic = { type: "synthetic", metadata: { source: "subagent" } };
const silent = { type: "reasoning", text: "Internal follow-up, not for playback." };
const assistant = (content, overrides = {}) => ({
  type: "assistant",
  time: { completed: 100 },
  finish: "stop",
  content,
  ...overrides,
});

test("reads only the final answer, not preceding steps, typed reasoning or tool output", () => {
  const result = finalResponseText([
    user,
    assistant([text("Una respuesta anterior.")]),
    done,
    user,
    assistant(
      [text("Voy a revisar."), { type: "tool", state: { output: "OUTPUT PRIVADO" } }],
      { finish: "tool-calls" },
    ),
    assistant([{ type: "reasoning", text: "PENSAMIENTO" }, text("Listo. Las pruebas pasaron.")]),
    done,
  ]);
  assert.equal(result, "Listo. Las pruebas pasaron.");
});

test("does not fall back to an older answer or read a partial response", () => {
  const previous = [user, assistant([text("Una respuesta anterior.")]), done];
  for (const current of [
    [user],
    [user, done],
    [user, assistant([text("Parcial")], { time: {} })],
    [user, assistant([text("Parcial")], { finish: "length" }), done],
    [user, assistant([text("A medias")]), { type: "idle", outcome: "interrupted" }],
    [user, assistant([text("Se cortó")]), { type: "idle", outcome: "failed" }],
    [user, assistant([text("Intermedio"), { type: "tool" }]), done],
    [user, assistant([text("```sh\npnpm test\n```")]), done],
  ]) {
    assert.equal(finalResponseText([...previous, ...current]), "");
  }
});

test("skips completed synthetic-only follow-ups to find the last visible final answer", () => {
  const visible = [user, assistant([text("La respuesta sigue disponible.")]), done];
  for (const followUps of [
    [synthetic, assistant([silent]), done, { type: "system" }],
    [synthetic, assistant([silent, text(" ")]), done],
    [synthetic, assistant([silent]), done, synthetic, assistant([]), done],
  ]) {
    assert.equal(finalResponseText([...visible, ...followUps]), "La respuesta sigue disponible.");
  }
});

test("does not skip through failed, incomplete, user-initiated or publicly visible executions", () => {
  const visible = [user, assistant([text("No se debe recuperar esta respuesta.")]), done];
  const interrupted = { type: "idle", outcome: "interrupted" };
  const failed = { type: "idle", outcome: "failed" };
  for (const followUp of [
    [user, synthetic, assistant([silent]), done],
    [user, assistant([silent]), done, synthetic, assistant([silent]), done],
    [synthetic, assistant([silent])],
    [synthetic, assistant([silent]), interrupted],
    [synthetic, assistant([silent]), failed],
    [synthetic, assistant([silent], { time: {} }), done],
    [synthetic, assistant([silent], { finish: "length" }), done],
    [synthetic, assistant([{ type: "tool" }], { finish: "tool-calls" }), assistant([silent]), done],
    [synthetic, assistant([text("```sh\npnpm test\n```")]), done],
    [assistant([silent]), synthetic, done],
    [synthetic, done],
    [assistant([silent]), done],
  ]) {
    assert.equal(finalResponseText([...visible, ...followUp]), "");
  }
});

test("prefers a new final answer if a synthetic follow-up did produce public prose", () => {
  assert.equal(
    finalResponseText([user, assistant([text("Anterior.")]), done, synthetic, assistant([text("Nueva respuesta.")]), done]),
    "Nueva respuesta.",
  );
});

test("removes code blocks, inline commands, tables, raw HTML, and literal reasoning tags", () => {
  const markdown = [
    "<think>no leer\n\nni esto</think>",
    "# Resumen",
    "",
    "Ver **[las pruebas](https://example.com)** antes de continuar (`pnpm test`).",
    "",
    "```js",
    "console.log('No leer');",
    "```",
    "",
    "    npm run test",
    "",
    "| Comando | Salida |",
    "| --- | --- |",
    "| no leer | no leer |",
    "",
    "<details>no leer</details>",
    "",
    "1. Paso uno",
    "2. *Paso dos* &amp; listo.",
  ].join("\n");
  assert.equal(
    speechText(markdown),
    "Resumen\n\nVer las pruebas antes de continuar.\n\nPaso uno\n\nPaso dos & listo.",
  );
  assert.equal(speechText("Visible.<analysis>No leer aunque quede abierto"), "Visible.");
  assert.equal(
    speechText("<think>oculto<think>también oculto</think> sigue oculto</think>Visible."),
    "Visible.",
  );
  assert.equal(speechText("```html\n<think>\n```\n\nEsto sí se lee."), "Esto sí se lee.");
  assert.equal(speechText("~~~ts\nno leer incluso sin cerrar"), "");
  assert.equal(speechText("~~no leer~~ `code`"), "");
});

test("reads pronounceable model names, versions and settings instead of dropping link labels", () => {
  const markdown = "- **Modelo (`provider.model`).** Tu variante actual es `nvfp4`. " +
    "Si notas pronunciaciones raras o una entonación irregular, puedes comparar con " +
    "[`lfm3-audio:2b-q8_0`](https://ollama.com/library/lfm3-audio:2b-q8_0) manteniendo la misma voz.";
  assert.equal(
    speechText(markdown, "es"),
    "Modelo (provider punto model). Tu variante actual es ene uve efe pe cuatro. " +
    "Si notas pronunciaciones raras o una entonación irregular, puedes comparar con " +
    "ele efe eme tres audio, dos be, cu ocho cero manteniendo la misma voz.",
  );
  assert.equal(
    speechText("Prueba [gemma4](https://example.com), manteniendo el mismo texto.", "es"),
    "Prueba gemma cuatro, manteniendo el mismo texto.",
  );
  assert.equal(speechText("Prueba [gemma4](gemma4).", "es"), "Prueba gemma cuatro.");
});

test("leaves snippets, bare URLs and standalone inline code out of narration", () => {
  const markdown = [
    "`pnpm`", "", "[`lfm3-audio:2b-q8_0`](https://ollama.com/library/lfm3-audio:2b-q8_0)", "",
    "Resumen sin enlaces directos [https://example.com](https://example.com).", "",
    "Hay una alternativa (`call()`).", "",
    "**Identificador `provider.model`**", "",
    "```sh\nollama run lfm3-audio\n```",
  ].join("\n");
  assert.equal(
    speechText(markdown, "es"),
    "Resumen sin enlaces directos.\n\nHay una alternativa.",
  );
});

test("reads mentions in plain prose, inline code and link labels", () => {
  const markdown = [
    "`@commit` ya está instalada globalmente en `~/.config/opencode/skills/commit/`. Verifiqué que OpenCode la detecta.",
    "",
    "Para pedir solo un mensaje, escribe @commit y elige **Message only**. " +
      "Consulta [@reviewer](https://example.com/skill) o [`@build-check`](file:///skills/build), sin leer `@reviewer --help`.",
  ].join("\n");
  const spoken = speechText(markdown, "es");
  assert.match(spoken, /^arroba commit ya está instalada/);
  assert.match(spoken, /escribe arroba commit y elige Message only/);
  assert.match(spoken, /Consulta arroba reviewer o arroba build check/);
  assert.doesNotMatch(spoken, /https?:|file:|--help/);
});

test("narrates the role of a configuration path instead of its technical spelling", () => {
  assert.equal(
    speechText("`@commit` ya está instalada globalmente en `~/.config/opencode/skills/commit/`.", "es"),
    "arroba commit ya está instalada globalmente en tu configuración de opencode.",
  );
  assert.equal(
    speechText("Se guardaron las preferencias en ~/.config/alacritty/alacritty.toml.", "es"),
    "Se guardaron las preferencias en tu configuración de alacritty.",
  );
  assert.equal(
    speechText("Se actualizaron las preferencias (ver [`/home/alex/.config/helix/config.toml`](https://example.com)).", "es"),
    "Se actualizaron las preferencias (ver tu configuración de helix).",
  );
  assert.equal(
    speechText("The local preferences are in `~/.config/alacritty/alacritty.toml`.", "en"),
    "The local preferences are in your alacritty configuration.",
  );
  assert.equal(
    speechText("Las preferencias están en [`$XDG_CONFIG_HOME/helix/config.toml`](#ajustes).", "es"),
    "Las preferencias están en tu configuración de helix.",
  );
});

test("describes unknown inline paths neutrally without guessing or reading link targets", () => {
  assert.equal(
    speechText(
      "Cambios listos (detalle en `/work/project/config/opencode`). " +
        "Ver [el resumen](https://example.com/?path=~/.config/opencode).",
      "es",
    ),
    "Cambios listos (detalle en la ruta indicada). Ver el resumen.",
  );
  assert.equal(
    speechText("Cambios listos [https://example.com/?path=~/.config/opencode](https://example.com).", "es"),
    "Cambios listos.",
  );
  assert.equal(
    speechText("Puedes ver el comando (`cat ~/.config/opencode/cli.json`).", "es"),
    "Puedes ver el comando.",
  );
  assert.equal(speechText("```\n~/.config/opencode/skills/commit/\n```", "es"), "");
});

test("skips labels that only introduce visual artifacts, regardless of wording", () => {
  const examples = [
    ["**Suggested commit message**", "```text\nfix: improve the test\n```"],
    ["**Comando de instalación:**", "```sh\npnpm install\n```"],
    ["_Informe de ejecución_", "    123 logs"],
    ["Comparativo:", "| Nombre | Estado |\n| -- | -- |\n| A | B |"],
    ["**Vorschau**:", "![imagen](preview.png)"],
    ["**Registro**", "<details>Logs omitidos</details>"],
  ];
  for (const [label, artifact] of examples) {
    const markdown = `La operación terminó.\n\n${label}\n\n${artifact}`;
    assert.equal(speechText(markdown), "La operación terminó.", label);
  }
});

test("retains headings with prose descendants, and drops artifact-only sibling sections", () => {
  const markdown = [
    "# Informe", "",
    "## Parche", "", "```diff\n+ example\n```", "",
    "## Validación", "", "- Pasaron las pruebas.", "",
    "# Apéndice", "", "```log\nexample\n```", "",
    "## Referencias", "", "![Imagen](details.png)", "",
    "# Anexo", "", "Véase el código en pantalla.",
  ].join("\n");
  assert.equal(speechText(markdown), "Informe\n\nValidación\n\nPasaron las pruebas.\n\nAnexo\n\nVéase el código en pantalla.");
  assert.equal(speechText("## Comando\n\n```sh\nls\n```\n\n---\n\nFin."), "Fin.");
});

test("does not drop real prose just because it is emphasized or sits by an artifact", () => {
  const markdown = [
    "**Resultados**", "", "La comprobación pasó.", "",
    "**La operación terminó bien.**", "", "```sh\nls\n```", "",
    "Ante un error, vuelve al estado anterior:", "", "```sh\nrestore\n```", "",
    "Para reproducir este comportamiento en un directorio distinto, ejecuta el siguiente comando:", "",
    "```sh\npnpm test\n```", "",
    "**Listo**",
  ].join("\n");
  assert.equal(
    speechText(markdown),
    "Resultados\n\nLa comprobación pasó.\n\nLa operación terminó bien.\n\nAnte un error, vuelve al estado anterior:\n\nPara reproducir este comportamiento en un directorio distinto, ejecuta el siguiente comando:\n\nListo",
  );
});

test("reasoning removal keeps the artifact boundary for its label", () => {
  assert.equal(speechText("<think>Oculto</think>\n\n**Ejemplo**\n\n```html\n<think>\n```\n\nFin."), "Fin.");
});

test("chunks long answers at sentence or word boundaries without splitting Unicode pairs", () => {
  assert.deepEqual([...chunkSpeech("Primera. Segunda. Tercera.", 16)], ["Primera.", "Segunda.", "Tercera."]);
  assert.deepEqual([...chunkSpeech("🔊🔊🔊", 3)], ["🔊", "🔊", "🔊"]);
  assert.deepEqual([...chunkSpeech("abcdefgh", 3)], ["abc", "def", "gh"]);
});
