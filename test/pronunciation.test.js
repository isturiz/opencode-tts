import assert from "node:assert/strict";
import test from "node:test";
import { pronounceIdentifier, pronounceMention, pronounceMentionsInText } from "../lib/pronunciation.js";

test("spells technical identifiers and speaks dots in Spanish", () => {
  assert.equal(pronounceIdentifier("lfm3-audio:2b-q8_0", "es"), "ele efe eme tres audio, dos be, cu ocho cero");
  assert.equal(pronounceIdentifier("nvfp4", "es-ES"), "ene uve efe pe cuatro");
  assert.equal(pronounceIdentifier("provider.model", "es-MX"), "provider punto model");
});

test("uses separate letters and digits without forcing a language in other locales", () => {
  assert.equal(pronounceIdentifier("lfm3-audio:2b-q8_0"), "L F M 3 audio, 2 B, Q 8 0");
  assert.equal(pronounceIdentifier("nvfp4", "en-US"), "N V F P 4");
  assert.equal(pronounceIdentifier("provider.model", "fr"), "provider model");
});

test("keeps pronounceable words and handles namespaces and model variants", () => {
  for (const [value, expected] of [
    ["qwen3", "qwen tres"],
    ["gemma4", "gemma cuatro"],
    ["mistral", "mistral"],
    ["meta-llama/Llama-3.2-1B-Instruct", "meta llama, Llama tres punto dos uno be Instruct"],
    ["deepseek-r1:7b", "deepseek erre uno, siete be"],
    ["gpt-4o-mini", "ge pe te cuatro o mini"],
    ["Phi-4-mini-instruct", "Phi cuatro mini instruct"],
    ["bf16", "be efe uno seis"],
    ["A100", "a uno cero cero"],
    ["example.js", "example punto jota ese"],
  ]) {
    assert.equal(pronounceIdentifier(value, "es"), expected, value);
  }
});

test("keeps dotted numeric version components intact", () => {
  assert.equal(pronounceIdentifier("12.10.3"), "12.10.3");
  assert.equal(pronounceIdentifier("v12.10.3", "es"), "uve 12 punto 10 punto tres");
  assert.equal(pronounceIdentifier("qwen2.5", "es"), "qwen dos punto cinco");
  assert.equal(pronounceIdentifier("1.2.3-rc.1+build.5"), "1.2.3 R C 1, build 5");
});

test("omits commands, expressions, URLs, sensitive paths, and opaque payloads", () => {
  for (const value of [
    "",
    null,
    "pnpm test",
    "pnpm\ninstall",
    "--force",
    "call()",
    "x=42",
    "https://example.com/model",
    "www.example.com",
    "example.com:8080",
    "localhost:8080",
    "mailto:user",
    "127.0.0.1",
    "../secrets/.env",
    "config/credentials.json",
    "secrets/production",
    "private-key.pem",
    "src/example.js",
    "0123456789abcdef0123456789abcdef",
    "550e8400-e29b-41d4-a716-446655440000",
    "mzxw6ytboi2gc3rpo3sxqk3u",
    "model-".repeat(11) + "id",
  ]) {
    assert.equal(pronounceIdentifier(value, "es"), "", String(value));
  }
});

test("speaks the mention prefix in the selected language and rejects non-mentions", () => {
  assert.equal(pronounceMention("@reviewer-2", "es-MX"), "arroba reviewer dos");
  assert.equal(pronounceMention("@reviewer", "en-US"), "at reviewer");
  assert.equal(pronounceMention("@reviewer"), "@ reviewer");
  for (const token of ["@reviewer --help", "@scope/package", "@reviewer.example", "me@example.org", "@@reviewer"]) {
    assert.equal(pronounceMention(token, "es"), "", token);
  }
});

test("only rewrites standalone mentions inside plain text", () => {
  assert.equal(
    pronounceMentionsInText("Usa (@reviewer) y luego @build-check. No: a@b.example, /tmp/@dir, @scope/pkg, @@x.", "es"),
    "Usa (arroba reviewer) y luego arroba build check. No: a@b.example, /tmp/@dir, @scope/pkg, @@x.",
  );
});
