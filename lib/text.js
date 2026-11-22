import { decodeHTML } from "entities";
import { marked } from "marked";
import { describePath, describePathsInText, isExplicitPath } from "./path-description.js";
import { pronounceIdentifier, pronounceMention, pronounceMentionsInText } from "./pronunciation.js";

// Some providers emit reasoning as literal tags rather than a typed part.
const hasReasoning = /<\/?(think|thinking|analysis|reasoning)(?=[\s/>])/i;
const reasoningTags = /<(\/?)(think|thinking|analysis|reasoning)(?=[\s/>])[^>]*>/gi;

function stripReasoning(markdown) {
  const open = [];
  const visible = [];
  let cursor = 0;
  for (const match of markdown.matchAll(reasoningTags)) {
    if (!open.length) visible.push(markdown.slice(cursor, match.index));
    const tag = match[2].toLowerCase();
    if (match[1]) {
      if (open.at(-1) === tag) open.pop();
    } else if (!match[0].endsWith("/>")) {
      open.push(tag);
    }
    cursor = match.index + match[0].length;
  }
  if (!open.length) visible.push(markdown.slice(cursor));
  return visible.join("");
}

function describeInlineCode(value, locale) {
  const described = describePath(value, locale);
  if (described) return described;
  if (isExplicitPath(value)) {
    if (/^es(?:-|$)/i.test(locale)) return "la ruta indicada";
    if (/^en(?:-|$)/i.test(locale)) return "the path shown";
    return "";
  }
  return pronounceMention(value, locale) || pronounceIdentifier(value, locale);
}

function inline(tokens, locale, references) {
  return tokens
    .map((token) => {
      switch (token.type) {
        case "text":
        case "escape": {
          if (token.tokens) return inline(token.tokens, locale, references);
          const text = decodeHTML(token.text);
          return references ? pronounceMentionsInText(describePathsInText(text, locale), locale) : text;
        }
        case "strong":
        case "em":
          return inline(token.tokens, locale, references);
        case "codespan":
          // Read names and recognizable locations, not commands or code expressions.
          return references ? describeInlineCode(token.text, locale) : "";
        case "link": {
          const label = inline(token.tokens, locale, references).trim();
          if (token.autolink || /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)/i.test(label)) {
            return "";
          }
          if (
            references &&
            token.tokens.length === 1 &&
            token.tokens[0].type === "text" &&
            /\d/u.test(label)
          ) {
            return pronounceIdentifier(label, locale) || label;
          }
          return label;
        }
        case "br":
          return " ";
        default:
          // Raw HTML, images and strikethrough are not spoken.
          return "";
      }
    })
    .join("");
}

function cleanProse(text) {
  return text
    .replace(/\(\s*\)/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/\s+([,.;:!?])/gu, "$1");
}

function prose(tokens, locale) {
  // Keep the artifact-label test independent of the expanded pronunciation.
  const plain = cleanProse(inline(tokens, locale, false));
  const line = /[\p{L}\p{N}]/u.test(plain) ? cleanProse(inline(tokens, locale, true)) : "";
  return { line, plain };
}

function isArtifactLabel(token, line) {
  if (
    /\n/u.test(token.text.trim()) ||
    /[;,]|[.!?…]$/u.test(line) ||
    line.split(" ").length > 8
  ) {
    return false;
  }
  const significant = token.tokens.filter((part) => part.type !== "text" || part.text.trim());
  const [first, second] = significant;
  const emphasized =
    (first?.type === "strong" || first?.type === "em") &&
    (significant.length === 1 ||
      (significant.length === 2 && second.type === "text" && second.text.trim() === ":"));
  return emphasized || line.endsWith(":");
}

function blockEntries(tokens, locale) {
  return tokens.flatMap((token) => {
    switch (token.type) {
      case "heading":
        return [{ kind: "heading", depth: token.depth, line: prose(token.tokens, locale).line }];
      case "paragraph":
      case "text": {
        const { line, plain } = token.tokens ? prose(token.tokens, locale) : {};
        return line
          ? [{ kind: "prose", lines: [line], label: isArtifactLabel(token, plain) }]
          : [{ kind: "artifact" }];
      }
      case "list":
      case "blockquote": {
        const lines = token.type === "list"
          ? token.items.flatMap((item) => blocks(item.tokens, locale))
          : blocks(token.tokens, locale);
        return [lines.length ? { kind: "prose", lines } : { kind: "artifact" }];
      }
      case "code":
      case "table":
      case "html":
        return [{ kind: "artifact" }];
      case "hr":
        return [{ kind: "boundary" }];
      default:
        return [];
    }
  });
}

function blocks(tokens, locale) {
  const entries = blockEntries(tokens, locale);
  const output = [];
  const headings = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.kind === "heading") {
      while (headings.length && headings.at(-1).depth >= entry.depth) headings.pop();
      headings.push(entry);
    } else if (entry.kind === "boundary") {
      headings.length = 0;
    } else if (entry.kind === "prose") {
      // A label pointing at an omitted block is just as non-narrative as the block.
      if (entry.label && entries[index + 1]?.kind === "artifact") continue;
      output.push(...headings.map(({ line }) => line).filter(Boolean), ...entry.lines);
      headings.length = 0;
    }
  }
  return output;
}

export function speechText(markdown, locale = "und") {
  let tokens = marked.lexer(markdown);
  if (hasReasoning.test(markdown)) {
    // Ignore tags in fenced/indented code examples before stripping actual
    // reasoning, but keep a code placeholder so its label can still be skipped.
    const visible = tokens.map((token) => token.type === "code" ? "\n\n```\n```\n\n" : token.raw).join("");
    tokens = marked.lexer(stripReasoning(visible));
  }
  return blocks(tokens, locale).join("\n\n");
}

const turnBoundaries = new Set(["user", "shell", "compaction"]);

function assistantText(message) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

function silentSyntheticBoundary(messages, start) {
  let synthetic = false;
  let silentStop = false;
  for (let i = start; i >= 0; i--) {
    const message = messages[i];
    if (message.type === "idle") return synthetic ? i : -1;
    if (turnBoundaries.has(message.type)) return -1;
    if (message.type === "synthetic") {
      if (!silentStop) return -1;
      synthetic = true;
    } else if (message.type === "assistant") {
      if (
        synthetic ||
        !message.time?.completed ||
        message.finish !== "stop" ||
        message.error ||
        message.content.some((part) => part.type === "tool") ||
        assistantText(message).trim()
      ) {
        return -1;
      }
      silentStop = true;
    }
  }
  return -1;
}

export function finalResponseText(messages, locale = "und") {
  let succeeded = false;
  for (let i = messages.length - 1; i >= 0;) {
    const message = messages[i];
    if (message.type === "idle") {
      if (succeeded || message.outcome !== "succeeded") return "";
      succeeded = true;
    } else if (turnBoundaries.has(message.type) || message.type === "synthetic") {
      return "";
    } else if (message.type === "assistant") {
      const text = assistantText(message);
      if (text.trim()) {
        // A visible final answer, even one without readable prose, is never
        // replaced by an earlier assistant step or answer.
        if (!message.time?.completed || message.finish !== "stop" || message.error) return "";
        if (message.content.some((part) => part.type === "tool")) return "";
        return speechText(text, locale);
      }
      // Background notifications can trigger a completely silent execution.
      // Skip it only if it ended successfully and has a synthetic input and a
      // prior execution boundary, with no newer prompt, tools, or assistant text.
      if (!succeeded) return "";
      i = silentSyntheticBoundary(messages, i);
      if (i < 0) return "";
      succeeded = false;
      continue;
    }
    i--;
  }
  return "";
}

export function* chunkSpeech(text, limit) {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new Error("Invalid speech chunk limit.");
  let remaining = text.trim();
  while (remaining.length > limit) {
    let end = limit;
    // JS counts UTF-16 code units. Do not split a surrogate pair even when
    // the provider has a stricter character limit than the paragraph length.
    if (/[\uD800-\uDBFF]/u.test(remaining[end - 1])) end--;
    const window = remaining.slice(0, end);
    const lastSentence = [...window.matchAll(/[.!?…]\s+|\n\n/gu)].pop();
    if (lastSentence && lastSentence.index >= end / 2) {
      end = lastSentence.index + lastSentence[0].length;
    } else {
      const lastSpace = window.search(/\s+\S*$/u);
      if (lastSpace >= end / 2) end = lastSpace;
    }
    yield remaining.slice(0, end).trim();
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) yield remaining;
}
