import assert from "node:assert/strict";
import test from "node:test";
import { describePath, describePathsInText, isExplicitPath } from "../lib/path-description.js";

test("describes XDG configuration without the account name, subpath, or installation claims", () => {
  assert.equal(describePath("~/.config/opencode/skills/commit/", "es-ES"), "tu configuración de opencode");
  assert.equal(describePath("/Users/Alice/.config/zed/settings.json", "en-US"), "your zed configuration");
  assert.equal(describePath("/home/bob/.config/helix/config.toml", "es"), "tu configuración de helix");
  assert.equal(describePath("$XDG_CONFIG_HOME/my-app", "en"), "your my-app configuration");
  assert.equal(describePath("${XDG_CONFIG_HOME}/zellij/"), "zellij configuration");
  assert.equal(describePath("~/.config/nvim", "fr-FR"), "nvim configuration");
});

test("describes standard data and cache paths and exact known directory roots", () => {
  assert.equal(describePath("~/.local/share/fish/history", "es"), "tus datos de fish");
  assert.equal(describePath("${XDG_DATA_HOME}/fish", "en"), "your fish data");
  assert.equal(describePath("/home/bob/.cache/pnpm/index", "en"), "your pnpm cache");
  assert.equal(describePath("$XDG_CACHE_HOME/pnpm", "es"), "tu caché de pnpm");
  assert.equal(describePath("/Users/alice/", "en"), "your home directory");
  assert.equal(describePath("~", "es"), "tu directorio personal");
  assert.equal(describePath("~/.config/", "es"), "tu directorio de configuración");
  assert.equal(describePath("${XDG_CONFIG_HOME}", "en"), "your configuration directory");
  assert.equal(describePath("~/.cache"), "cache directory");
});

test("does not infer a role from unknown, ambiguous, sensitive, or nonliteral paths", () => {
  for (const value of [
    "",
    "/some/project/config/app",
    "/etc/app",
    "/home",
    "/Users/Shared/.config/app",
    "/Users/alice/projects/example/.config/app",
    "~bob/.config/app",
    "~/.ssh/id_ed25519",
    "~/.config/ssh/config",
    "~/.config/app/credentials.json",
    "~/.config/app/auth.json",
    "~/.config/app/private-key.pem",
    "~/.config/app/.env.local",
    "~/.config/0123abcdef987654",
    "~/.config/app/2fb2f300-3a67-4622-99fe-6363abc12073.json",
    "~/.config/config.json",
    "~/.config/.hidden",
    "~/.config/app//file",
    "~/.config/../app",
    "~/.config/app/../other",
    "~/.config/app/./file",
    "$HOME/.config/app",
    "${XDG_CONFIG_HOME:-~/.config}/app",
    "$XDG_CONFIG_HOME2/app",
    "file:///Users/alice/.config/app",
    "https://host/?path=~/.config/app",
    "cat ~/.config/app",
    "~/.config/app --verbose",
    "~/Library/Application Support/app",
  ]) {
    assert.equal(describePath(value, "es"), "", value);
  }
});

test("describes only whole canonical prose tokens and preserves their visible punctuation", () => {
  assert.equal(
    describePathsInText(
      "Está en ~/.config/opencode/skills/commit/, luego en («${XDG_CONFIG_HOME}/zed»).",
      "es-MX",
    ),
    "Está en tu configuración de opencode, luego en («tu configuración de zed»).",
  );
  assert.equal(
    describePathsInText('¿~/.cache/zed?  "See /home/bob/.config/helix."  (Not /etc/app.)', "en"),
    '¿your zed cache?  "See your helix configuration."  (Not /etc/app.)',
  );
});

test("leaves URL queries, email addresses, assignments, and malformed path fragments untouched", () => {
  for (const value of [
    "See https://host/?path=(~/.config/app), https://host/#/home/alice/.config/app.",
    "See www.host.test/?dir=${XDG_CONFIG_HOME}/app, or file:///Users/alice/.config/app.",
    "See ~/.config/app?query, ~/.config/app#anchor and ~/.config/app%20stuff.",
    "Send to ~/.config/app@example.test or me@/home/alice/.config/app.",
    "Set CONFIG=~/.config/app or CONFIG='~/.config/app'.",
    "Not project/~/.config/app, ./home/alice/.config/app, or scheme:~/.config/app.",
    "Not ~/.config/app/.., ~/.config/app/../file, or ~/.config/app/...",
    "Not (~/.config/app)nested nor (~/.config/app.",
    "Not `~/.config/app` in this plain-text pass.",
    "The value is ~ 2.",
  ]) {
    assert.equal(describePathsInText(value, "en"), value);
  }
});

test("recognizes isolated explicit path syntax without inferring a role", () => {
  assert.equal(isExplicitPath("~"), true);
  for (const value of [
    "/",
    "/etc",
    "/etc/hosts",
    "~/Documents/draft.txt",
    "~/.ssh/id_ed25519",
    "./src/index.js",
    "../../project/",
    "../",
    "C:/Users/alice/config.txt",
    String.raw`D:\work\file.txt`,
  ]) {
    assert.equal(isExplicitPath(value), true, value);
    assert.equal(describePath(value), "", value);
    assert.equal(describePathsInText(`See ${value}.`), `See ${value}.`, value);
  }
});

test("does not accept ambiguous slash tokens, commands, links, or markup as explicit paths", () => {
  for (const value of [
    "org/app",
    "app.json",
    "/regex/",
    "/regex/i",
    "/foo.*/gi",
    "/[ab]/",
    "/api/*",
    "file:///etc/hosts",
    "https://host/test",
    "path=/etc/hosts",
    "cat /etc/hosts",
    "/usr/bin/tool --help",
    "<path>/etc/hosts</path>",
    "`/etc/hosts`",
    "(/etc/hosts)",
    "/etc/../passwd",
    "~/folder//file",
    String.raw`C:\some folder\file`,
  ]) {
    assert.equal(isExplicitPath(value), false, value);
  }
});
