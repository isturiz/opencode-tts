const spanishLetters = "a be ce de e efe ge hache i jota ka ele eme ene o pe cu erre ese te u uve".split(" ")
  .concat("uve doble", "equis", "ye", "zeta");
const spanishDigits = "cero uno dos tres cuatro cinco seis siete ocho nueve".split(" ");

// Accept one optional namespace and one optional tag, not arbitrary paths or code.
const identifier = /^(?:[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/i;
const version = /^v?\d{1,7}\.\d{1,7}(?:\.\d{1,7})?(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?(?:\+[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/i;
const address = /^(?:www\.|(?:https?|ftps?|file|mailto|data|tel|urn|ssh|wss?|localhost):)|\.(?:com|net|org)(?::|$)/i;
const secretPath = /(?:^|[./])(?:secrets?|credentials?|passwords?|passwd|api[-_]key|private[-_]key|id_(?:rsa|ecdsa|ed25519))(?=[./]|$)|\.(?:pem|key|p12|pfx)$/i;
const opaquePart = /(?:^|[._:/+-])(?:[a-z0-9]{24,}|[a-f0-9]{16,}|\d{8,})(?=[._:/+-]|$)/i;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const mentionName = "[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*";
const mention = new RegExp(`^@(${mentionName})$`, "i");
// Do not rewrite parts of emails, paths, scoped packages, or longer tokens.
const inlineMention = new RegExp(
  String.raw`(?<![\p{L}\p{M}\p{N}_@./\\~+?=&%-])@(${mentionName})(?![\p{L}\p{M}\p{N}_@/\\-]|\.[\p{L}\p{M}\p{N}])`,
  "giu",
);

function spellDigits(digits, spanish) {
  return [...digits].map((digit) => spanish ? spanishDigits[digit] : digit).join(" ");
}

export function pronounceIdentifier(value, locale = "und") {
  if (typeof value !== "string" || value.length > 64 || /\s/.test(value)) return "";
  if (!version.test(value) && (!identifier.test(value) || !/[a-z]/i.test(value))) return "";
  if (
    address.test(value) ||
    secretPath.test(value) ||
    opaquePart.test(value) ||
    uuid.test(value) ||
    // A namespace followed by a filename is indistinguishable from a relative path.
    /\/[^:]+\.[a-z][a-z0-9]*$/i.test(value)
  ) return "";

  const spanish = typeof locale === "string" && /^es(?:-|$)/i.test(locale);
  const parts = value.match(/\d+(?:\.\d+)*|[a-z]+|[._:/+-]/gi);
  const tag = parts.indexOf(":");
  return parts.map((part, index) => {
    if (part === ".") return spanish ? "punto" : "";
    if ("/:+".includes(part) || (part === "-" && tag !== -1 && index > tag)) return ",";
    if (part === "-" || part === "_") return "";
    if (/^\d/.test(part)) {
      if (!part.includes(".")) return spellDigits(part, spanish);
      // Keep multi-digit version components whole, rather than reading them as IDs.
      return spanish
        ? part.split(".").map((digits) => /^\d$|^0/.test(digits) ? spellDigits(digits, true) : digits).join(" punto ")
        : part;
    }

    // Treat short letter/number groups and vowel-less or all-caps runs as spelling.
    const nextToNumber = /^\d/.test(parts[index - 1] ?? "") || /^\d/.test(parts[index + 1] ?? "");
    if (part.length === 1 || (part.length === 2 && nextToNumber) || !/[aeiouy]/i.test(part) || /^[A-Z]+$/.test(part)) {
      return [...part.toUpperCase()].map((letter) => spanish ? spanishLetters[letter.charCodeAt(0) - 65] : letter).join(" ");
    }
    return part;
  }).filter(Boolean).join(" ").replace(/ ,/g, ",");
}

export function pronounceMention(value, locale = "und") {
  const name = mention.exec(value)?.[1];
  if (!name) return "";
  const spoken = pronounceIdentifier(name, locale);
  if (!spoken) return "";
  if (/^es(?:-|$)/i.test(locale)) return `arroba ${spoken}`;
  if (/^en(?:-|$)/i.test(locale)) return `at ${spoken}`;
  return `@ ${spoken}`;
}

export function pronounceMentionsInText(value, locale) {
  return value.replace(inlineMention, (original) => pronounceMention(original, locale) || original);
}
