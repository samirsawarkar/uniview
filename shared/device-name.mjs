// Friendly device names: turn a user-agent model token such as "RMX2002 Build/RP1A.200720.011; wv"
// into something a person would recognise. Pure and shared by the phone (default name) and the
// computer (display of names saved by older builds).

const BRANDS = [
  [/^RMX\d+/i, "realme"],
  [/^SM-[A-Z0-9]+/i, "Samsung"],
  [/^CPH\d+/i, "OPPO"],
];

/** @param {unknown} raw @returns {string} cleaned name, or "" when nothing meaningful is left */
export function friendlyDeviceName(raw) {
  let s = String(raw ?? "");
  s = s.replace(/\s*\bBuild\/[^;)]*/gi, " "); // " Build/RP1A.200720.011"
  s = s.replace(/\s*;\s*(?:wv|U|Mobile)\b/gi, " ");
  let prev;
  do {
    prev = s;
    s = s
      .trim()
      .replace(/[\s;,]+(?:wv|Mobile|Safari)$/i, "") // WebView / UA tokens
      .replace(/[\s;,]+(?:version\/|v)?\d+(?:\.\d+)+$/i, ""); // trailing dotted version numbers
  } while (s !== prev);
  s = s.replace(/\s+/g, " ").trim();
  if (!s || s === "K" || /^android(\s+[\d.]+)?$/i.test(s)) return "";
  for (const [re, brand] of BRANDS) {
    if (re.test(s)) return `${brand} ${s}`;
  }
  return s;
}

/**
 * A name a person may have typed: leave it alone unless it carries the raw user-agent build token
 * (older builds saved "RMX2002 Build/RP1A.200720.011" as the default name).
 * @param {string} name
 */
export function cleanSavedName(name) {
  return /\bBuild\//i.test(name) ? friendlyDeviceName(name) || name : name;
}
