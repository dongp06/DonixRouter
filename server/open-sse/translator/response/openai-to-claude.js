import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import fs from "node:fs";

// Prefix for Claude OAuth tool names (must match request translator)
const CLAUDE_OAUTH_TOOL_PREFIX = "proxy_";

function tryParseJSONObject(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripToolPrefix(name) {
  return name?.startsWith?.(CLAUDE_OAUTH_TOOL_PREFIX)
    ? name.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
    : name;
}

function getToolSchema(state, toolName) {
  const normalizedName = stripToolPrefix(toolName);
  const tool = Array.isArray(state.requestTools)
    ? state.requestTools.find((t) => t?.name === normalizedName || t?.name === toolName)
    : null;
  return tool?.input_schema || tool?.inputSchema || null;
}

function applyCommonToolAliases(toolName, args) {
  const name = stripToolPrefix(toolName);
  const normalized = { ...args };

  if (["Read", "Write", "Edit", "MultiEdit"].includes(name) && normalized.file_path === undefined) {
    normalized.file_path = normalized.filePath
      ?? normalized.filepath
      ?? normalized.file
      ?? normalized.path
      ?? normalized.filename
      ?? normalized.fileName;
    delete normalized.filePath;
    delete normalized.filepath;
    delete normalized.file;
    delete normalized.fileName;
    if (name !== "Grep") delete normalized.filename;
    if (name !== "Grep" && name !== "Glob") delete normalized.path;
  }

  if (name === "Edit" || name === "MultiEdit") {
    if (normalized.old_string === undefined) {
      normalized.old_string = normalized.oldString
        ?? normalized.oldText
        ?? normalized.oldContent
        ?? normalized.search
        ?? normalized.find
        ?? normalized.from
        ?? normalized.old;
    }
    if (normalized.new_string === undefined) {
      normalized.new_string = normalized.newString
        ?? normalized.newText
        ?? normalized.newContent
        ?? normalized.replacement
        ?? normalized.replace
        ?? normalized.to
        ?? normalized.new;
    }
    if (normalized.replace_all === undefined) normalized.replace_all = normalized.replaceAll;
    delete normalized.oldString;
    delete normalized.oldText;
    delete normalized.oldContent;
    delete normalized.newString;
    delete normalized.newText;
    delete normalized.newContent;
    delete normalized.replaceAll;
    delete normalized.search;
    delete normalized.find;
    delete normalized.from;
    delete normalized.replacement;
    delete normalized.replace;
    delete normalized.to;
    delete normalized.old;
    delete normalized.new;
  }

  if (name === "MultiEdit" && Array.isArray(normalized.edits)) {
    normalized.edits = normalized.edits.map((edit) => {
      if (!edit || typeof edit !== "object" || Array.isArray(edit)) return edit;
      const normalizedEdit = { ...edit };
      if (normalizedEdit.old_string === undefined) {
        normalizedEdit.old_string = normalizedEdit.oldString
          ?? normalizedEdit.oldText
          ?? normalizedEdit.oldContent
          ?? normalizedEdit.search
          ?? normalizedEdit.find
          ?? normalizedEdit.from
          ?? normalizedEdit.old;
      }
      if (normalizedEdit.new_string === undefined) {
        normalizedEdit.new_string = normalizedEdit.newString
          ?? normalizedEdit.newText
          ?? normalizedEdit.newContent
          ?? normalizedEdit.replacement
          ?? normalizedEdit.replace
          ?? normalizedEdit.to
          ?? normalizedEdit.new;
      }
      if (normalizedEdit.replace_all === undefined) normalizedEdit.replace_all = normalizedEdit.replaceAll;
      if (typeof normalizedEdit.old_string !== "string" && normalizedEdit.old_string !== undefined) {
        normalizedEdit.old_string = String(normalizedEdit.old_string);
      }
      if (typeof normalizedEdit.new_string !== "string" && normalizedEdit.new_string !== undefined) {
        normalizedEdit.new_string = String(normalizedEdit.new_string);
      }
      if (typeof normalizedEdit.replace_all === "string") {
        const lower = normalizedEdit.replace_all.toLowerCase();
        if (lower === "true") normalizedEdit.replace_all = true;
        if (lower === "false") normalizedEdit.replace_all = false;
      }
      delete normalizedEdit.oldString;
      delete normalizedEdit.oldText;
      delete normalizedEdit.oldContent;
      delete normalizedEdit.newString;
      delete normalizedEdit.newText;
      delete normalizedEdit.newContent;
      delete normalizedEdit.replaceAll;
      delete normalizedEdit.search;
      delete normalizedEdit.find;
      delete normalizedEdit.from;
      delete normalizedEdit.replacement;
      delete normalizedEdit.replace;
      delete normalizedEdit.to;
      delete normalizedEdit.old;
      delete normalizedEdit.new;
      return normalizedEdit;
    });
  }

  if (name === "Bash" && normalized.command === undefined) {
    normalized.command = normalized.cmd
      ?? normalized.shell
      ?? normalized.script
      ?? normalized.code
      ?? normalized.input
      ?? normalized.value;
    delete normalized.cmd;
    delete normalized.shell;
    delete normalized.script;
    delete normalized.code;
    delete normalized.input;
    delete normalized.value;
  }

  if (name === "Bash" && typeof normalized.command === "string") {
    const command = normalized.command;
    const looksLikeForegroundInspection =
      /(?:^|[;&|]\s*)(?:sed|cat|tail|head|grep|rg|findstr|type|Get-Content|Select-String|wc|echo)\b/i.test(command)
      || />\s*["']?[^"';&|]+["']?/.test(command)
      || /\bnpx\s+tsx\b/i.test(command);

    if (looksLikeForegroundInspection) {
      normalized.run_in_background = false;
      if (normalized.timeout === undefined) normalized.timeout = 600000;
    }
  }

  if (name === "Write" && normalized.content === undefined) {
    normalized.content = normalized.text ?? normalized.data ?? normalized.value ?? normalized.new_string ?? normalized.newString;
    delete normalized.text;
    delete normalized.data;
    delete normalized.value;
    delete normalized.new_string;
    delete normalized.newString;
  }

  return normalized;
}

function isAbsolutePathLike(value) {
  return typeof value === "string" && (
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\") ||
    value.startsWith("/")
  );
}

function absolutizePath(value, workspaceDir) {
  if (typeof value !== "string" || !value || isAbsolutePathLike(value) || !workspaceDir) return value;
  const base = workspaceDir.replace(/[\\/]+$/, "");
  return `${base}\\${value.replace(/^[\\/]+/, "")}`;
}

function ensureWriteParentDirectory(cleaned, toolName) {
  const name = stripToolPrefix(toolName);
  if (name !== "Write" || typeof cleaned.file_path !== "string") return cleaned;
  try {
    const dir = cleaned.file_path.replace(/[\\/][^\\/]*$/, "");
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Let Claude Code surface the real write error if mkdir is not allowed.
  }
  return cleaned;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findWhitespaceEquivalentSubstring(content, needle) {
  if (typeof content !== "string" || typeof needle !== "string") return null;
  if (!needle.trim() || needle.length > 50000) return null;

  const lineMatch = findLineEquivalentSubstring(content, needle);
  if (lineMatch) return lineMatch;

  const tokens = needle.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4000) return null;

  try {
    const pattern = tokens.map(escapeRegExp).join("\\s+");
    const match = content.match(new RegExp(pattern));
    return match?.[0] || null;
  } catch {
    return null;
  }
}

function splitLinesWithEndings(value) {
  const matches = String(value).match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || [];
  if (matches.length > 0 && matches[matches.length - 1] === "") matches.pop();
  return matches;
}

function normalizeLineForEditMatch(line) {
  return String(line)
    .replace(/[\r\n]+$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/['`]/g, "\"");
}

function trimTrailingLineBreaks(value) {
  return typeof value === "string" ? value.replace(/(?:\r\n|\n|\r)+$/g, "") : value;
}

function isJsLikePath(filePath) {
  return typeof filePath === "string" && /\.(?:cjs|mjs|js|jsx|ts|tsx)$/i.test(filePath);
}

function leadingWhitespace(value) {
  const match = String(value || "").match(/^[ \t]*/);
  return match?.[0] || "";
}

function firstNonEmptyIndent(value) {
  const line = String(value || "").split(/\r?\n/).find((item) => item.trim());
  return leadingWhitespace(line || "");
}

function stripStringsForIndent(line) {
  let out = "";
  let quote = null;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (!quote && ch === "/" && next === "/") break;
    if (!quote && ch === "/" && next === "*") {
      i++;
      while (i + 1 < line.length && !(line[i] === "*" && line[i + 1] === "/")) i++;
      i++;
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      out += " ";
      continue;
    }

    if (ch === "'" || ch === "\"" || ch === "`") {
      quote = ch;
      out += " ";
      continue;
    }

    out += ch;
  }

  return out;
}

function countLeadingClosers(strippedLine) {
  let count = 0;
  const trimmed = strippedLine.trimStart();
  for (const ch of trimmed) {
    if (ch === "}" || ch === ")" || ch === "]") count++;
    else break;
  }
  return count;
}

function indentDelta(strippedLine) {
  let delta = 0;
  for (const ch of strippedLine) {
    if (ch === "{" || ch === "(" || ch === "[") delta++;
    else if (ch === "}" || ch === ")" || ch === "]") delta--;
  }
  return delta;
}

function hasSuspiciousIndentation(value) {
  const lines = String(value || "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 6) return false;

  let suspicious = 0;
  for (const line of lines) {
    const indent = leadingWhitespace(line).replace(/\t/g, "    ").length;
    if (indent % 2 !== 0) suspicious++;
  }

  return suspicious >= 2 || suspicious / lines.length >= 0.12;
}

function formatJsLikeText(value, baseIndent = "") {
  if (typeof value !== "string" || !value.includes("\n")) return value;
  if (!hasSuspiciousIndentation(value)) return value;

  const hasFinalNewline = /(?:\r\n|\n|\r)$/.test(value);
  const lines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let indent = 0;
  const formatted = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      formatted.push("");
      continue;
    }

    const stripped = stripStringsForIndent(trimmed);
    const lineIndentLevel = Math.max(0, indent - countLeadingClosers(stripped));
    formatted.push(`${baseIndent}${"    ".repeat(lineIndentLevel)}${trimmed}`);
    indent = Math.max(0, indent + indentDelta(stripped));
  }

  return formatted.join("\n") + (hasFinalNewline ? "\n" : "");
}

function normalizeToolCodeFormatting(cleaned, toolName) {
  const name = stripToolPrefix(toolName);

  if (name === "Write" && isJsLikePath(cleaned.file_path) && typeof cleaned.content === "string") {
    return { ...cleaned, content: formatJsLikeText(cleaned.content) };
  }

  if (name === "Edit" && isJsLikePath(cleaned.file_path) && typeof cleaned.new_string === "string") {
    return {
      ...cleaned,
      new_string: formatJsLikeText(cleaned.new_string, firstNonEmptyIndent(cleaned.old_string)),
    };
  }

  if (name === "MultiEdit" && isJsLikePath(cleaned.file_path) && Array.isArray(cleaned.edits)) {
    let changed = false;
    const edits = cleaned.edits.map((edit) => {
      if (!edit || typeof edit !== "object" || Array.isArray(edit) || typeof edit.new_string !== "string") return edit;
      const formatted = formatJsLikeText(edit.new_string, firstNonEmptyIndent(edit.old_string));
      if (formatted === edit.new_string) return edit;
      changed = true;
      return { ...edit, new_string: formatted };
    });
    return changed ? { ...cleaned, edits } : cleaned;
  }

  return cleaned;
}

function findLineEquivalentSubstring(content, needle) {
  const needleLines = splitLinesWithEndings(needle);
  const wanted = needleLines
    .map(normalizeLineForEditMatch)
    .filter(Boolean);

  if (wanted.length === 0 || wanted.length > 300) return null;

  const contentLines = splitLinesWithEndings(content);
  const normalizedContent = contentLines.map(normalizeLineForEditMatch);
  const maxSpan = Math.min(contentLines.length, wanted.length + 8);

  for (let start = 0; start < contentLines.length; start++) {
    if (normalizedContent[start] !== wanted[0]) continue;

    let cursor = start;
    let matched = 0;
    while (cursor < contentLines.length && cursor - start < maxSpan && matched < wanted.length) {
      if (!normalizedContent[cursor]) {
        cursor++;
        continue;
      }
      if (normalizedContent[cursor] !== wanted[matched]) break;
      matched++;
      cursor++;
    }

    if (matched === wanted.length) {
      return contentLines.slice(start, cursor).join("");
    }
  }

  return null;
}

function repairEditOldString(cleaned, toolName) {
  const name = stripToolPrefix(toolName);
  if (name !== "Edit" && name !== "MultiEdit") return cleaned;
  if (
    typeof cleaned.file_path !== "string" ||
    (name === "Edit"
      ? typeof cleaned.old_string !== "string" || cleaned.old_string.length === 0
      : !Array.isArray(cleaned.edits))
  ) {
    return cleaned;
  }

  try {
    const stat = fs.statSync(cleaned.file_path);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return cleaned;

    const content = fs.readFileSync(cleaned.file_path, "utf8");
    if (name === "MultiEdit") {
      let changed = false;
      const edits = cleaned.edits.map((edit) => {
        if (!edit || typeof edit !== "object" || Array.isArray(edit)) return edit;
        if (typeof edit.old_string !== "string" || edit.old_string.length === 0) return edit;
        const trimmedOldString = trimTrailingLineBreaks(edit.old_string);
        if (trimmedOldString !== edit.old_string && content.includes(trimmedOldString)) {
          changed = true;
          return { ...edit, old_string: trimmedOldString };
        }
        const lineRepaired = findLineEquivalentSubstring(content, edit.old_string);
        if (lineRepaired && lineRepaired !== edit.old_string) {
          changed = true;
          return { ...edit, old_string: lineRepaired };
        }
        if (content.includes(edit.old_string)) return edit;

        const repaired = findWhitespaceEquivalentSubstring(content, edit.old_string);
        if (!repaired) return edit;
        changed = true;
        return { ...edit, old_string: repaired };
      });
      return changed ? { ...cleaned, edits } : cleaned;
    }

    const trimmedOldString = trimTrailingLineBreaks(cleaned.old_string);
    if (trimmedOldString !== cleaned.old_string && content.includes(trimmedOldString)) {
      return { ...cleaned, old_string: trimmedOldString };
    }

    const lineRepaired = findLineEquivalentSubstring(content, cleaned.old_string);
    if (lineRepaired && lineRepaired !== cleaned.old_string) {
      return { ...cleaned, old_string: lineRepaired };
    }

    if (content.includes(cleaned.old_string)) return cleaned;

    const repaired = findWhitespaceEquivalentSubstring(content, cleaned.old_string);
    if (repaired) {
      return { ...cleaned, old_string: repaired };
    }
  } catch {
    // If the file is not locally readable, leave the tool call unchanged.
  }

  return cleaned;
}

function coerceSchemaValue(value, schema) {
  if (!schema || value === undefined || value === null) return value;

  if (schema.type === "string" && typeof value !== "string") {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }

  if (schema.type === "array" && typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return value;
    }
  }

  if (schema.type === "object" && typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return value;
    }
  }

  if ((schema.type === "number" || schema.type === "integer") && typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }

  if (schema.type === "boolean" && typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }

  return value;
}

function fallbackValueForSchema(schema) {
  if (!schema || schema.type === "string") return "";
  if (schema.type === "boolean") return false;
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "array") return [];
  if (schema.type === "object") return {};
  return "";
}

function completeRequiredToolArguments(cleaned, schema) {
  if (!Array.isArray(schema?.required)) return cleaned;
  const completed = { ...cleaned };
  for (const key of schema.required) {
    if (completed[key] !== undefined && completed[key] !== null) continue;
    completed[key] = fallbackValueForSchema(schema.properties?.[key]);
  }
  return completed;
}

function sanitizeToolArgumentsForClaude(toolName, rawArguments, state) {
  const parsed = tryParseJSONObject(rawArguments);
  if (!parsed) return rawArguments;

  const schema = getToolSchema(state, toolName);
  if (!schema?.properties || typeof schema.properties !== "object") {
    const normalizedToolName = stripToolPrefix(toolName);
    const aliased = applyCommonToolAliases(toolName, parsed);
    const cleaned = { ...aliased };
    if (["Read", "Write", "Edit", "MultiEdit"].includes(normalizedToolName)) {
      cleaned.file_path = absolutizePath(cleaned.file_path, state.workspaceDir);
    }
    const repaired = repairEditOldString(cleaned, toolName);
    const withParentDir = ensureWriteParentDirectory(repaired, toolName);
    const formatted = normalizeToolCodeFormatting(withParentDir, toolName);
    return JSON.stringify(formatted);
  }

  const aliased = applyCommonToolAliases(toolName, parsed);
  const cleaned = {};
  const allowExtra = schema.additionalProperties !== false;
  const normalizedToolName = stripToolPrefix(toolName);

  for (const [key, value] of Object.entries(aliased)) {
    const propertySchema = schema.properties[key];
    if (!propertySchema && !allowExtra) continue;
    const pathValue = key === "file_path" && ["Read", "Write", "Edit", "MultiEdit"].includes(normalizedToolName)
      ? absolutizePath(value, state.workspaceDir)
      : value;
    const coerced = coerceSchemaValue(pathValue, propertySchema);
    if (coerced !== undefined) cleaned[key] = coerced;
  }

  const repaired = repairEditOldString(cleaned, toolName);
  const withParentDir = ensureWriteParentDirectory(repaired, toolName);
  const formatted = normalizeToolCodeFormatting(withParentDir, toolName);
  return JSON.stringify(completeRequiredToolArguments(formatted, schema));
}

// Helper: stop thinking block if started
function stopThinkingBlock(state, results) {
  if (!state.thinkingBlockStarted) return;
  results.push({
    type: "content_block_stop",
    index: state.thinkingBlockIndex
  });
  state.thinkingBlockStarted = false;
}

// Helper: stop text block if started
function stopTextBlock(state, results) {
  if (!state.textBlockStarted || state.textBlockClosed) return;
  state.textBlockClosed = true;
  results.push({
    type: "content_block_stop",
    index: state.textBlockIndex
  });
  state.textBlockStarted = false;
}

// Convert OpenAI stream chunk to Claude format
export function openaiToClaudeResponse(chunk, state) {
  if (!chunk || !chunk.choices?.[0]) return null;

  const results = [];
  const choice = chunk.choices[0];
  const delta = choice.delta;

  // Track usage from OpenAI chunk if available
  if (chunk.usage && typeof chunk.usage === "object") {
    const promptTokens = typeof chunk.usage.prompt_tokens === "number" ? chunk.usage.prompt_tokens : 0;
    const outputTokens = typeof chunk.usage.completion_tokens === "number" ? chunk.usage.completion_tokens : 0;
    
    // Extract cache tokens from prompt_tokens_details
    const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
    const cacheCreationTokens = chunk.usage.prompt_tokens_details?.cache_creation_tokens;
    const cacheReadTokens = typeof cachedTokens === "number" ? cachedTokens : 0;
    const cacheCreateTokens = typeof cacheCreationTokens === "number" ? cacheCreationTokens : 0;
    
    // input_tokens = prompt_tokens - cached_tokens - cache_creation_tokens
    // Because OpenAI's prompt_tokens includes all prompt-side tokens
    const inputTokens = promptTokens - cacheReadTokens - cacheCreateTokens;
    
    state.usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    };
    
    // Add cache_read_input_tokens if present
    if (cacheReadTokens > 0) {
      state.usage.cache_read_input_tokens = cacheReadTokens;
    }
    
    // Add cache_creation_input_tokens if present
    if (cacheCreateTokens > 0) {
      state.usage.cache_creation_input_tokens = cacheCreateTokens;
    }
    
    // Note: completion_tokens_details.reasoning_tokens is already included in output_tokens
    // No need to add separately as Claude expects total output_tokens
  }

  // First chunk - ALWAYS send message_start first
  if (!state.messageStartSent) {
    state.messageStartSent = true;
    state.messageId = chunk.id?.replace("chatcmpl-", "") || `msg_${Date.now()}`;
    if (!state.messageId || state.messageId === "chat" || state.messageId.length < 8) {
      state.messageId = chunk.extend_fields?.requestId ||
        chunk.extend_fields?.traceId ||
        `msg_${Date.now()}`;
    }
    state.model = chunk.model || "unknown";
    state.nextBlockIndex = 0;
    results.push({
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  // Handle reasoning_content (thinking) - GLM, DeepSeek, etc.
  const reasoningContent = delta?.reasoning_content || delta?.reasoning;
  if (reasoningContent) {
    stopTextBlock(state, results);

    if (!state.thinkingBlockStarted) {
      state.thinkingBlockIndex = state.nextBlockIndex++;
      state.thinkingBlockStarted = true;
      results.push({
        type: "content_block_start",
        index: state.thinkingBlockIndex,
        content_block: { type: "thinking", thinking: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.thinkingBlockIndex,
      delta: { type: "thinking_delta", thinking: reasoningContent }
    });
  }

  // Handle regular content
  if (delta?.content) {
    stopThinkingBlock(state, results);

    if (!state.textBlockStarted) {
      state.textBlockIndex = state.nextBlockIndex++;
      state.textBlockStarted = true;
      state.textBlockClosed = false;
      results.push({
        type: "content_block_start",
        index: state.textBlockIndex,
        content_block: { type: "text", text: "" }
      });
    }

    results.push({
      type: "content_block_delta",
      index: state.textBlockIndex,
      delta: { type: "text_delta", text: delta.content }
    });
  }

  // Tool calls
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;

      if (tc.id) {
        stopThinkingBlock(state, results);
        stopTextBlock(state, results);

        const toolBlockIndex = state.nextBlockIndex++;
        state.toolCalls.set(idx, { id: tc.id, name: tc.function?.name || "", blockIndex: toolBlockIndex });
        
        // Strip prefix from tool name for response
        const toolName = stripToolPrefix(tc.function?.name || "");
        
        results.push({
          type: "content_block_start",
          index: toolBlockIndex,
          content_block: {
            type: "tool_use",
            id: tc.id,
            name: toolName,
            input: {}
          }
        });
      }

      if (tc.function?.arguments) {
        const toolInfo = state.toolCalls.get(idx);
        if (toolInfo) {
          const partialJson = sanitizeToolArgumentsForClaude(toolInfo.name, tc.function.arguments, state);
          results.push({
            type: "content_block_delta",
            index: toolInfo.blockIndex,
            delta: { type: "input_json_delta", partial_json: partialJson }
          });
        }
      }
    }
  }

  // Finish
  if (choice.finish_reason) {
    stopThinkingBlock(state, results);
    stopTextBlock(state, results);

    for (const [, toolInfo] of state.toolCalls) {
      results.push({
        type: "content_block_stop",
        index: toolInfo.blockIndex
      });
    }

    // Mark finish for later usage injection in stream.js
    state.finishReason = choice.finish_reason;
    
    // Use tracked usage (will be estimated in stream.js if not valid)
    const finalUsage = state.usage || { input_tokens: 0, output_tokens: 0 };
    results.push({
      type: "message_delta",
      delta: { stop_reason: convertFinishReason(choice.finish_reason) },
      usage: finalUsage
    });
    results.push({ type: "message_stop" });
  }

  return results.length > 0 ? results : null;
}

// Convert OpenAI finish_reason to Claude stop_reason
function convertFinishReason(reason) {
  switch (reason) {
    case "stop": return "end_turn";
    case "length": return "max_tokens";
    case "tool_calls": return "tool_use";
    default: return "end_turn";
  }
}

// Register
register(FORMATS.OPENAI, FORMATS.CLAUDE, null, openaiToClaudeResponse);
