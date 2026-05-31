/**
 * Kiro tool-name compatibility layer (shared by request + response translators).
 *
 * Kiro/CodeWhisperer only accepts tool names matching ^[a-zA-Z][a-zA-Z0-9_]*$
 * with a bounded length. Most real names (native Claude Code tools, standard
 * `mcp__server__tool` names) already satisfy this, so sanitizing is an identity
 * no-op for them. Exotic names (containing '.', '-', ':', '/', spaces, or a
 * leading digit) would otherwise make Kiro reject the request as "Improperly
 * formed request".
 *
 * When a name MUST be rewritten, we keep a deterministic, collision-safe forward
 * mapping (original -> kiro) and record the reverse (kiro -> original) so the
 * response translator can restore the client-facing name. Without the reverse
 * step, a rewritten tool_use echoed back by Kiro would not match the client's
 * registered tool and the call would fail.
 */

const KIRO_TOOL_NAME_MAX = 64;
const KIRO_TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

// kiroName -> originalName. Only populated for names that were actually changed.
const reverseMap = new Map();
// originalName -> kiroName cache for deterministic, stable forward mapping.
const forwardMap = new Map();
const MAX_ENTRIES = 2000;

function shortHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function remember(original, kiro) {
  if (forwardMap.size >= MAX_ENTRIES) {
    forwardMap.clear();
    reverseMap.clear();
  }
  forwardMap.set(original, kiro);
  reverseMap.set(kiro, original);
}

/**
 * Map any tool name into Kiro's allowed charset. Identity for already-valid
 * names. Deterministic and collision-safe for the rest.
 */
export function sanitizeKiroToolName(rawName) {
  const original = String(rawName || "").trim();
  if (!original) return "tool";
  if (KIRO_TOOL_NAME_RE.test(original) && original.length <= KIRO_TOOL_NAME_MAX) {
    return original;
  }

  const cached = forwardMap.get(original);
  if (cached) return cached;

  let name = original.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z]/.test(name)) name = `t_${name}`;
  if (!/[a-zA-Z0-9]/.test(name)) name = "tool";
  if (name.length > KIRO_TOOL_NAME_MAX) name = name.slice(0, KIRO_TOOL_NAME_MAX);

  // Disambiguate collisions: two different originals must not collapse onto the
  // same kiro name, otherwise the reverse mapping would be ambiguous.
  if (reverseMap.has(name) && reverseMap.get(name) !== original) {
    const suffix = `_${shortHash(original)}`;
    const base = name.slice(0, Math.max(1, KIRO_TOOL_NAME_MAX - suffix.length));
    name = `${base}${suffix}`;
  }

  remember(original, name);
  return name;
}

/**
 * Restore the client-facing tool name from a name Kiro echoed back. Returns the
 * input unchanged when it was never rewritten (the common case).
 */
export function restoreKiroToolName(kiroName) {
  if (!kiroName) return kiroName;
  return reverseMap.get(kiroName) || kiroName;
}
