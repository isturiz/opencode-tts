const roles = [
  { root: "/.config", variable: "XDG_CONFIG_HOME", en: "configuration", es: "configuración" },
  { root: "/.local/share", variable: "XDG_DATA_HOME", en: "data", es: "datos", plural: true },
  { root: "/.cache", variable: "XDG_CACHE_HOME", en: "cache", es: "caché" },
];

const homeRoot = /^(?:~|\/(?:Users|home)\/([a-zA-Z0-9_][a-zA-Z0-9._-]{0,31}))(?=\/|$)/u;
const variableRoot = /^\$(?:([A-Z_]+)|\{([A-Z_]+)\})(?=\/|$)/u;
const appName = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/i;
const opaquePart = /(?:^|[._-])(?:[a-z0-9]{24,}|[a-f0-9]{16,}|\d{8,}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?=$|[._-])/i;
const sensitivePart = /(?:^|[._-])(?:auth|secrets?|credentials?|passwords?|passwd|tokens?|(?:api|private|access)[_-]?keys?|keyrings?|keychains?|ssh|gnupg|gpg|id_(?:rsa|ecdsa|ed25519))(?=$|[._-])|^\.env(?:$|\.)|^\.?keys?$|\.(?:pem|key|p12|pfx|kdbx)$/i;

function pathParts(path, separator = "/") {
  return (path.endsWith(separator) ? path.slice(0, -1) : path).split(separator);
}

function isLiteralSegment(part) {
  return /^[a-z0-9._-]+$/i.test(part) && /[^.]/u.test(part);
}

function label(role, app, locale) {
  const language = typeof locale === "string" ? locale.split("-")[0].toLowerCase() : "und";
  if (language === "es") {
    if (app) return `${role.plural ? "tus" : "tu"} ${role.es} de ${app}`;
    return role ? `tu directorio de ${role.es}` : "tu directorio personal";
  }
  // Use the same vocabulary without a possessive when the locale is unknown or unsupported.
  const prefix = language === "en" ? "your " : "";
  return prefix + (app ? `${app} ${role.en}` : `${role?.en ?? "home"} directory`);
}

export function describePath(value, locale = "und") {
  if (typeof value !== "string" || /\s/u.test(value)) return "";

  let role;
  let tail;
  const variable = variableRoot.exec(value);
  if (variable) {
    role = roles.find(({ variable: name }) => name === (variable[1] ?? variable[2]));
    tail = value.slice(variable[0].length);
  } else {
    const home = homeRoot.exec(value);
    if (!home || home[0].toLowerCase() === "/users/shared" || opaquePart.test(home[1] ?? "")) return "";
    tail = value.slice(home[0].length);
    if (!tail || tail === "/") return label(null, null, locale);
    role = roles.find(({ root }) => tail === root || tail.startsWith(`${root}/`));
    if (role) tail = tail.slice(role.root.length);
  }

  if (!role) return "";
  if (!tail || tail === "/") return label(role, null, locale);
  const parts = pathParts(tail.slice(1));
  const app = parts[0];
  if (
    app.length > 32 ||
    !appName.test(app) ||
    parts.some((part) => !isLiteralSegment(part) || opaquePart.test(part) || sensitivePart.test(part))
  ) return "";
  return label(role, app, locale);
}

// Syntax only. Callers can acknowledge an isolated code span without speaking its contents.
export function isExplicitPath(value) {
  if (typeof value !== "string" || /\s/u.test(value)) return false;
  if (value === "~") return true;
  const drive = /^[a-z]:([/\\])/i.exec(value);
  const prefix = drive ?? /^(?:\/|~\/|(?:\.\.?\/)+)/u.exec(value);
  if (!prefix || /^\/[^/]+\/[dgimsuvy]*$/u.test(value)) return false;
  const tail = value.slice(prefix[0].length);
  return !tail || pathParts(tail, drive?.[1] ?? "/").every(isLiteralSegment);
}

const pairedPunctuation = new Map([
  ["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"],
  ['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"], ["«", "»"],
]);

export function describePathsInText(value, locale = "und") {
  if (typeof value !== "string") return value;
  // Match entire whitespace-delimited tokens, not possible fragments after ?, =, @, or /.
  return value.replace(/\S+/gu, (token) => {
    let start = 0;
    let end = token.length;
    while (start < end) {
      while (end > start && ".,;:!?…".includes(token[end - 1])) {
        // Don't disguise a traversal segment or an abbreviated path as punctuation.
        if (token[end - 1] === "." && token[end - 2] === ".") return token;
        end--;
      }
      if (start === end) return token;
      if (token[start] === "¿" || token[start] === "¡") {
        start++;
        continue;
      }
      const close = pairedPunctuation.get(token[start]);
      if (close) {
        if (close !== token[end - 1]) break;
        start++;
        end--;
        continue;
      }
      // An opening parenthesis or quote may belong to an earlier word.
      if (!`)]"'”’»`.includes(token[end - 1])) break;
      end--;
    }
    const path = token.slice(start, end);
    // A lone tilde in prose could mean "approximately."
    const description = path === "~" ? "" : describePath(path, locale);
    return description ? token.slice(0, start) + description + token.slice(end) : token;
  });
}
