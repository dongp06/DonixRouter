/**
 * OpenAI to Kiro Request Translator
 * Converts OpenAI Chat Completions format to Kiro/AWS CodeWhisperer format
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { v4 as uuidv4 } from "uuid";

function getUserInput(item) {
  return item?.userInputMessage || null;
}

function getAssistantResponse(item) {
  return item?.assistantResponseMessage || null;
}

function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readIntEnv(name, defaultValue) {
  const raw = process.env?.[name];
  if (raw === undefined || raw === "") return defaultValue;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : defaultValue;
}

const KIRO_MAX_TOOL_RESULT_CHARS = readIntEnv("KIRO_MAX_TOOL_RESULT_CHARS", 12_000);
const KIRO_MAX_HISTORY_ENTRIES = readIntEnv("KIRO_MAX_HISTORY_ENTRIES", 240);
const KIRO_MAX_WORKFLOW_HISTORY_ENTRIES = readIntEnv("KIRO_MAX_WORKFLOW_HISTORY_ENTRIES", 48);
const KIRO_MAX_TASK_NOTIFICATION_RESULT_CHARS = readIntEnv("KIRO_MAX_TASK_NOTIFICATION_RESULT_CHARS", 3_000);
const KIRO_MAX_CURRENT_MESSAGE_CHARS = readIntEnv("KIRO_MAX_CURRENT_MESSAGE_CHARS", 24_000);
const KIRO_COMPAT_MODE = !/^(0|false|off|no)$/i.test(process.env?.KIRO_COMPAT_MODE || "true");

function compactClaudeTaskNotifications(text) {
  if (typeof text !== "string" || !text.includes("<task-notification>")) return text;

  return text.replace(
    /<task-notification>([\s\S]*?)<result>([\s\S]*?)<\/result>([\s\S]*?)<\/task-notification>/g,
    (full, beforeResult, result, afterResult) => {
      const summaryMatch = beforeResult.match(/<summary>([\s\S]*?)<\/summary>/);
      const outputFileMatch = beforeResult.match(/<output-file>([\s\S]*?)<\/output-file>/);
      const statusMatch = beforeResult.match(/<status>([\s\S]*?)<\/status>/);
      const taskIdMatch = beforeResult.match(/<task-id>([\s\S]*?)<\/task-id>/);
      const usageMatch = afterResult.match(/<usage>([\s\S]*?)<\/usage>/);
      const firstLines = result
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, 8)
        .join("\n");
      const compactResult = [
        taskIdMatch?.[1]?.trim() ? `Task: ${taskIdMatch[1].trim()}` : "",
        summaryMatch?.[1]?.trim() ? `Summary: ${summaryMatch[1].trim()}` : "",
        statusMatch?.[1]?.trim() ? `Status: ${statusMatch[1].trim()}` : "",
        outputFileMatch?.[1]?.trim() ? `Output file: ${outputFileMatch[1].trim()}` : "",
        usageMatch?.[1]?.trim() ? `Usage: ${usageMatch[1].trim().replace(/\s+/g, " ")}` : "",
        firstLines ? `Result preview:\n${firstLines.slice(0, KIRO_MAX_TASK_NOTIFICATION_RESULT_CHARS)}` : "",
        `[DonixRouter compacted background agent result: ${result.length} chars omitted for Kiro stability]`,
      ].filter(Boolean).join("\n");
      return `<task-notification>${beforeResult}<result>${compactResult}</result>${afterResult}</task-notification>`;
    }
  );
}

function stripClaudeSystemReminderNoise(text) {
  if (typeof text !== "string" || !text.includes("<system-reminder>")) return text;
  return text
    .replace(/<system-reminder>\s*As you answer the user's questions, you can use the following context:[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<system-reminder>\s*The following skills are available for use with the Skill tool:[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<system-reminder>\s*The user included the keyword "workflow" or "workflows"[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<system-reminder>\s*The task tools haven't been used recently[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<system-reminder>\s*## Exited Plan Mode[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<system-reminder>\s*The user opened the file [\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "")
    .replace(/<command-name>\/model<\/command-name>[\s\S]*?<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeTextForKiro(text) {
  return stripClaudeSystemReminderNoise(compactClaudeTaskNotifications(text));
}

function clampCurrentMessageForKiro(text) {
  if (typeof text !== "string" || text.length <= KIRO_MAX_CURRENT_MESSAGE_CHARS) return text;
  const headLen = Math.floor(KIRO_MAX_CURRENT_MESSAGE_CHARS * 0.55);
  const tailLen = KIRO_MAX_CURRENT_MESSAGE_CHARS - headLen;
  return [
    text.slice(0, headLen),
    `\n\n[DonixRouter compacted current turn: ${text.length - headLen - tailLen} chars omitted for Kiro stability]\n\n`,
    text.slice(-tailLen),
  ].join("");
}

function isSyntheticKiroErrorText(text) {
  return typeof text === "string" && /^\s*(?:\[[^\]]+\]\s*)?\[Kiro Error\]\s+/i.test(text.trim());
}

function compactClaudeAgentLaunchResult(text) {
  if (typeof text !== "string" || !text.includes("Async agent launched successfully.")) return text;

  const agentId = text.match(/agentId:\s*([^\s]+)/)?.[1];
  const outputFile = text.match(/output_file:\s*(.+)/)?.[1]?.trim();
  return [
    "Async agent launched successfully.",
    agentId ? `agentId: ${agentId}` : "",
    outputFile ? `output_file: ${outputFile}` : "",
    "[DonixRouter compacted Claude subagent launch boilerplate for Kiro stability]",
  ].filter(Boolean).join("\n");
}

function truncateForKiroToolResult(text) {
  text = compactClaudeAgentLaunchResult(sanitizeTextForKiro(text));
  if (typeof text !== "string" || text.length <= KIRO_MAX_TOOL_RESULT_CHARS) return text;
  const headLen = Math.max(1000, Math.floor(KIRO_MAX_TOOL_RESULT_CHARS * 0.35));
  const tailLen = Math.max(1000, KIRO_MAX_TOOL_RESULT_CHARS - headLen);
  return [
    text.slice(0, headLen),
    `\n\n[DonixRouter truncated ${text.length - headLen - tailLen} chars from long tool result for Kiro stability]\n\n`,
    text.slice(-tailLen),
  ].join("");
}

function stringifyToolResultContent(content) {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return safeJsonStringify(part);
      })
      .filter(Boolean)
      .join("\n");
  }

  if (typeof content === "object") return safeJsonStringify(content);
  return String(content);
}

function compactToolUseForKiro(toolUse) {
  if (!toolUse || typeof toolUse !== "object") return toolUse;
  const name = toolUse.function?.name || toolUse.name || "";
  const input = toolUse.function
    ? parseToolArguments(toolUse.function.arguments)
    : (toolUse.input || {});

  if (name !== "Agent" && name !== "TaskCreate") {
    return {
      toolUseId: toolUse.id || uuidv4(),
      name,
      input,
    };
  }

  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const compactInput = {
    ...input,
    ...(prompt.length > 600 && {
      prompt: [
        prompt.slice(0, 420),
        `[DonixRouter compacted ${prompt.length - 600} chars from ${name} prompt for Kiro stability]`,
        prompt.slice(-180),
      ].join("\n"),
    }),
  };

  return {
    toolUseId: toolUse.id || uuidv4(),
    name,
    input: compactInput,
  };
}

function hasWorkflowPressure(payload) {
  const state = payload?.conversationState;
  if (!state) return false;
  const currentContent = state.currentMessage?.userInputMessage?.content || "";
  if (typeof currentContent === "string" && (
    currentContent.includes("<task-notification>")
    || currentContent.includes("Async agent launched successfully")
    || currentContent.includes("agent đang chạy")
    || currentContent.includes("subagent")
  )) {
    return true;
  }

  const history = Array.isArray(state.history) ? state.history : [];
  return history.some(item => {
    const userContent = item?.userInputMessage?.content || "";
    const assistant = item?.assistantResponseMessage;
    return (typeof userContent === "string" && (
      userContent.includes("<task-notification>")
      || userContent.includes("Async agent launched successfully")
    ))
      || assistant?.toolUses?.some(toolUse => toolUse?.name === "Agent" || toolUse?.name === "TaskCreate");
  });
}

function cleanupUserContext(userInput) {
  const context = userInput?.userInputMessageContext;
  if (!context) return;
  if (Array.isArray(context.toolResults) && context.toolResults.length === 0) {
    delete context.toolResults;
  }
  if (Object.keys(context).length === 0) {
    delete userInput.userInputMessageContext;
  }
}

function getToolUseIds(assistantItem) {
  const toolUses = getAssistantResponse(assistantItem)?.toolUses;
  if (!Array.isArray(toolUses) || toolUses.length === 0) return new Set();
  return new Set(toolUses.map(toolUse => toolUse.toolUseId).filter(Boolean));
}

function filterToolResults(userItem, previousAssistantItem) {
  const userInput = getUserInput(userItem);
  const context = userInput?.userInputMessageContext;
  const toolResults = context?.toolResults;
  if (!Array.isArray(toolResults) || toolResults.length === 0) return 0;

  const allowedToolUseIds = getToolUseIds(previousAssistantItem);
  const before = toolResults.length;
  if (allowedToolUseIds.size === 0) {
    delete context.toolResults;
  } else {
    context.toolResults = toolResults.filter(result => allowedToolUseIds.has(result.toolUseId));
  }
  cleanupUserContext(userInput);
  return before - (context?.toolResults?.length || 0);
}

function hasMatchingToolResults(assistantItem, nextUserItem) {
  const toolUseIds = getToolUseIds(assistantItem);
  if (toolUseIds.size === 0) return true;

  const toolResults = getUserInput(nextUserItem)?.userInputMessageContext?.toolResults;
  if (!Array.isArray(toolResults) || toolResults.length === 0) return false;
  const resultIds = new Set(toolResults.map(result => result.toolUseId).filter(Boolean));
  return [...toolUseIds].every(id => resultIds.has(id));
}

function sanitizeToolContext(history, currentMessage) {
  let removedToolResults = 0;
  let removedToolUses = 0;

  for (let i = 0; i < history.length; i++) {
    if (getUserInput(history[i])) {
      removedToolResults += filterToolResults(history[i], history[i - 1]);
    }
  }
  if (currentMessage) {
    removedToolResults += filterToolResults(currentMessage, history[history.length - 1]);
  }

  for (let i = 0; i < history.length; i++) {
    const assistant = getAssistantResponse(history[i]);
    if (!assistant?.toolUses?.length) continue;
    const nextUser = history[i + 1] || currentMessage;
    if (!hasMatchingToolResults(history[i], nextUser)) {
      removedToolUses += assistant.toolUses.length;
      delete assistant.toolUses;
    }
  }

  for (let i = 0; i < history.length; i++) {
    if (getUserInput(history[i])) {
      removedToolResults += filterToolResults(history[i], history[i - 1]);
    }
  }
  if (currentMessage) {
    removedToolResults += filterToolResults(currentMessage, history[history.length - 1]);
  }

  return { removedToolResults, removedToolUses };
}

function normalizeHistoryShape(history, currentMessage = null, model = "") {
  if (
    history.length > 0 &&
    getAssistantResponse(history[0]) &&
    currentMessage &&
    hasMatchingToolResults(history[0], currentMessage)
  ) {
    history.unshift({
      userInputMessage: {
        content: "Continue",
        modelId: model,
      },
    });
  }

  while (history.length > 0 && !getUserInput(history[0])) {
    history.shift();
  }
  while (history.length > 0 && !getAssistantResponse(history[history.length - 1])) {
    history.pop();
  }
  if (
    history.length === 1 &&
    !(currentMessage && getAssistantResponse(history[0]) && hasMatchingToolResults(history[0], currentMessage))
  ) {
    history.length = 0;
  }
}

function getPayloadSizeBytes(obj) {
  return Buffer.byteLength(JSON.stringify(obj), "utf8");
}

function trimHistoryToSize(payload, maxBytes) {
  const history = payload?.conversationState?.history;
  if (!Array.isArray(history) || history.length === 0) return 0;

  let removed = 0;
  let payloadSize = getPayloadSizeBytes(payload);
  while (payloadSize > maxBytes && history.length > 0) {
    history.shift();
    removed += 1;
    if (history.length > 0) {
      history.shift();
      removed += 1;
    }
    payloadSize = getPayloadSizeBytes(payload);
  }

  return removed;
}

function trimHistoryToEntryLimit(payload, maxEntries) {
  const history = payload?.conversationState?.history;
  if (!Array.isArray(history) || maxEntries <= 0 || history.length <= maxEntries) return 0;

  let preserveHead = 0;
  const firstContent = history[0]?.userInputMessage?.content || "";
  if (firstContent.startsWith("<system-instructions>") && history[1]?.assistantResponseMessage) {
    preserveHead = 2;
  }

  const keepTail = Math.max(2, maxEntries - preserveHead);
  let removeCount = history.length - preserveHead - keepTail;
  if (removeCount <= 0) return 0;
  if (removeCount % 2 === 1) removeCount += 1;
  removeCount = Math.min(removeCount, history.length - preserveHead);
  history.splice(preserveHead, removeCount);
  return removeCount;
}

function measureContentSize(obj) {
  let size = 0;
  const visit = (value) => {
    if (typeof value === "string") size += Buffer.byteLength(value, "utf8");
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(obj);
  return size;
}

const CORE_TOOL_ORDER = [
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "Bash",
  "PowerShell",
  "Grep",
  "Glob",
  "TaskOutput",
  "TaskStop",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TodoWrite",
  "TodoRead",
];

const CORE_TOOL_RANK = new Map(CORE_TOOL_ORDER.map((name, index) => [name, index]));
const KIRO_COMPAT_BLOCKED_TOOLS = new Set([
  "Workflow",
  "Skill",
  "EnterPlanMode",
  "ExitPlanMode",
  "AskUserQuestion",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "CronCreate",
  "CronDelete",
  "CronList",
  "PushNotification",
  "Monitor",
  "EnterWorktree",
  "ExitWorktree",
]);

function getToolName(tool) {
  return tool?.function?.name || tool?.name || "";
}

function clampToolDescription(text, maxChars = 1400) {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n[DonixRouter compacted ${trimmed.length - maxChars} chars from tool description for Kiro stability]`;
}

function sanitizeToolSchemaForKiro(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 8) {
    return {};
  }

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || key === "$id" || key === "examples" || key === "default") continue;
    if (key === "description" && typeof value === "string") {
      out.description = clampToolDescription(value, 900);
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map(item => (
        item && typeof item === "object" && !Array.isArray(item)
          ? sanitizeToolSchemaForKiro(item, depth + 1)
          : item
      ));
      continue;
    }
    if (value && typeof value === "object") {
      out[key] = sanitizeToolSchemaForKiro(value, depth + 1);
      continue;
    }
    out[key] = value;
  }

  if (out.type === "object") {
    out.properties = out.properties && typeof out.properties === "object" && !Array.isArray(out.properties)
      ? out.properties
      : {};
    out.required = Array.isArray(out.required) ? out.required : [];
  }

  return out;
}

function prioritizeTools(tools) {
  if (!Array.isArray(tools) || tools.length < 2) return tools || [];
  return [...tools].sort((a, b) => {
    const aName = getToolName(a);
    const bName = getToolName(b);
    const aRank = CORE_TOOL_RANK.has(aName) ? CORE_TOOL_RANK.get(aName) : Number.MAX_SAFE_INTEGER;
    const bRank = CORE_TOOL_RANK.has(bName) ? CORE_TOOL_RANK.get(bName) : Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return 0;
  });
}

function capToolsForKiro(tools) {
  if (!Array.isArray(tools)) return [];
  const filtered = [];
  const blocked = [];
  for (const tool of tools) {
    const name = getToolName(tool);
    if (KIRO_COMPAT_MODE && KIRO_COMPAT_BLOCKED_TOOLS.has(name)) {
      blocked.push(name);
      continue;
    }
    filtered.push(tool);
  }

  const effectiveTools = filtered;
  const effectiveMaxTools = KIRO_COMPAT_MODE ? Math.min(KIRO_MAX_TOOLS, 32) : KIRO_MAX_TOOLS;
  if (effectiveMaxTools <= 0 || effectiveTools.length <= effectiveMaxTools) {
    if (blocked.length > 0) {
      console.log(`[KIRO] Compat-filtered ${blocked.length} unsupported tools: ${[...new Set(blocked)].join(", ")}`);
    }
    return effectiveTools;
  }

  const core = [];
  const rest = [];
  const seenNames = new Set();

  for (const tool of effectiveTools) {
    const name = getToolName(tool);
    if (name && seenNames.has(name)) continue;
    if (name) seenNames.add(name);
    if (CORE_TOOL_RANK.has(name)) core.push(tool);
    else rest.push(tool);
  }

  const capped = [...core, ...rest].slice(0, effectiveMaxTools);
  console.log(`[KIRO] Trimmed tools ${tools.length} -> ${capped.length} (KIRO_MAX_TOOLS=${effectiveMaxTools}, blocked=${blocked.length}, kept ${core.length} core tools first)`);
  return capped;
}

function buildToolUseGuidance(tools) {
  const names = new Set((tools || []).map(getToolName).filter(Boolean));
  const lines = [];

  if (KIRO_COMPAT_MODE) {
    lines.push("Kiro Claude-Code compatibility mode is active. Workflow/Skill/Plan/MCP tools are not available here; continue directly with the available file, shell, search, and task-output tools.");
    lines.push("If the user says workflow/continue/tiếp tục, infer the latest concrete task from the compacted summaries and proceed without calling Workflow or PlanMode.");
    lines.push("If background agent output is needed, use TaskOutput or Read the output-file path from the task notification instead of asking the user.");
  }

  if (names.has("Write") || names.has("Edit") || names.has("MultiEdit")) {
    lines.push("File editing tools are available: use Write for creating/replacing a whole file, Edit/MultiEdit for modifying existing files.");
    lines.push("Do not write files through Bash/node -e/perl/python when Write/Edit/MultiEdit can do it.");
    lines.push("When writing JavaScript/TypeScript, keep indentation consistent and run the project formatter when available.");
    lines.push("When you need to use a tool, emit the tool call directly with complete JSON arguments. Do not write a preamble like 'I will edit...' before the tool call.");
  } else if (names.has("Bash")) {
    lines.push("No Write/Edit tools are available in this request. To create or modify files, use Bash with a robust script.");
    lines.push("Never say you will start writing and then stop; if work requires file changes, call Bash in the same response.");
    lines.push("If the current message is a recap/continue instruction that names the next action, do that next action with Bash instead of only restating the recap.");
    lines.push("For file writes on Windows, prefer Node.js fs scripts. Do not use python/python3/perl/sed for editing files unless Node.js is unavailable.");
    lines.push("For multiline file writes, avoid fragile node -e quoting. Prefer node with a temporary script, heredoc, or JSON.stringify-based writer that preserves UTF-8.");
    lines.push("Do not use commands starting with python, python3, py, perl, or sed -i to modify files in this environment.");
    lines.push("When you need Bash, emit the Bash tool call directly with complete JSON arguments. Do not write a preamble before the tool call.");
  }

  if (names.has("Bash") && (names.has("Write") || names.has("Edit") || names.has("MultiEdit"))) {
    lines.push("Use Bash for commands and verification only. For long commands that must return output, keep run_in_background false.");
  } else if (names.has("Bash")) {
    lines.push("For long Bash commands that must return output, keep run_in_background false.");
    lines.push("Use Node.js for small local automation because this environment is Windows/Node-based; avoid Python for quick file edits.");
    lines.push("If you are about to write a python heredoc for editing, stop and write the same operation as a Node.js fs script instead.");
  }

  if (lines.length === 0) return "";
  return `<tool-guidance>\n${lines.join("\n")}\n</tool-guidance>`;
}

// Payload size budgets for Kiro history trimming.
// Kiro upstream (CodeWhisperer) reliably accepts ~1.5-2.5 MB before returning
// 400 "Input is too long". Token estimate: ~4 bytes/token, so:
//   1.5 MB ≈  380k tokens   (soft trim target)
//   2.5 MB ≈  640k tokens   (hard limit before send)
// Override via env if your account has a larger context allowance.
function readByteEnv(name, defaultBytes) {
  const raw = process.env?.[name];
  if (!raw) return defaultBytes;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultBytes;
}

export const KIRO_SOFT_PAYLOAD_BYTES = readByteEnv("KIRO_SOFT_PAYLOAD_BYTES", 1_500_000);
export const KIRO_HARD_PAYLOAD_BYTES = readByteEnv("KIRO_HARD_PAYLOAD_BYTES", 2_500_000);
export const KIRO_MAX_TOOLS = readIntEnv("KIRO_MAX_TOOLS", 96);

function extractSystemPrompt(messages) {
  const parts = [];

  for (const msg of messages) {
    if (msg?.role !== "system") continue;

    if (typeof msg.content === "string") {
      const trimmed = msg.content.trim();
      if (trimmed) parts.push(trimmed);
      continue;
    }

    if (!Array.isArray(msg.content)) continue;
    const text = msg.content
      .map(part => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
    if (text) parts.push(text);
  }

  return parts.join("\n\n");
}

/**
 * Convert OpenAI messages to Kiro format
 * Rules: tool -> user role, merge consecutive same roles
 */
function convertMessages(messages, tools, model) {
  const orderedTools = capToolsForKiro(prioritizeTools(tools));
  const toolUseGuidance = buildToolUseGuidance(orderedTools);
  let history = [];
  let currentMessage = null;
  
  let pendingUserContent = [];
  let pendingAssistantContent = [];
  let pendingToolResults = [];
  let pendingImages = [];
  let currentRole = null;

  // Image support is pre-filtered by caps in translateRequest before reaching here
  const supportsImages = true;

  const flushPending = () => {
    if (currentRole === "user") {
      const content = pendingUserContent.join("\n\n").trim() || "Continue";
      const userMsg = {
        userInputMessage: {
          content: toolUseGuidance && history.length === 0
            ? `${toolUseGuidance}\n\n${content}`
            : content,
          modelId: ""
        }
      };

      // Attach images if present (Kiro API supports images field)
      if (pendingImages.length > 0) {
        userMsg.userInputMessage.images = pendingImages;
      }

      if (pendingToolResults.length > 0) {
        userMsg.userInputMessage.userInputMessageContext = {
          toolResults: pendingToolResults
        };
      }
      
      // Add tools to first user message
      if (orderedTools && orderedTools.length > 0 && history.length === 0) {
        if (!userMsg.userInputMessage.userInputMessageContext) {
          userMsg.userInputMessage.userInputMessageContext = {};
        }
        userMsg.userInputMessage.userInputMessageContext.tools = orderedTools.map(t => {
          const name = t.function?.name || t.name;
          let description = clampToolDescription(t.function?.description || t.description || "");
          
          if (!description.trim()) {
            description = `Tool: ${name}`;
          }
          
          const schema = t.function?.parameters || t.parameters || t.input_schema || {};
          // Normalize schema: Kiro requires required[] and proper type/properties
          const normalizedSchema = Object.keys(schema).length === 0
            ? { type: "object", properties: {}, required: [] }
            : sanitizeToolSchemaForKiro({ ...schema, required: schema.required ?? [] });

          return {
            toolSpecification: {
              name,
              description,
              inputSchema: { json: normalizedSchema }
            }
          };
        });
      }
      
      history.push(userMsg);
      currentMessage = userMsg;
      pendingUserContent = [];
      pendingToolResults = [];
      pendingImages = [];
    } else if (currentRole === "assistant") {
      const content = pendingAssistantContent.join("\n\n").trim() || " ";
      const assistantMsg = {
        assistantResponseMessage: {
          content: content
        }
      };
      history.push(assistantMsg);
      pendingAssistantContent = [];
    }
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "system") continue;

    let role = msg.role === "tool" ? "user" : msg.role;
    
    // If role changes, flush pending
    if (role !== currentRole && currentRole !== null) {
      flushPending();
    }
    currentRole = role;
    
    if (role === "user") {
      // Extract content
      let content = "";
      if (typeof msg.content === "string") {
        content = sanitizeTextForKiro(msg.content);
      } else if (Array.isArray(msg.content)) {
        const textParts = [];
        for (const c of msg.content) {
          if (c.type === "text" || c.text) {
            const text = sanitizeTextForKiro(c.text || "");
            if (text) textParts.push(text);
          } else if (supportsImages && c.type === "image_url") {
            // OpenAI format: image_url.url with data URI
            const url = c.image_url?.url || "";
            const base64Match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (base64Match) {
              const mediaType = base64Match[1];
              const format = mediaType.split("/")[1] || mediaType;
              pendingImages.push({ format, source: { bytes: base64Match[2] } });
            } else if (url.startsWith("http://") || url.startsWith("https://")) {
              // Kiro only supports base64; fallback to URL text
              textParts.push(`[Image: ${url}]`);
            }
          } else if (supportsImages && c.type === "image") {
            // Claude format: source.type = "base64", source.media_type, source.data
            if (c.source?.type === "base64" && c.source?.data) {
              const mediaType = c.source.media_type || "image/png";
              const format = mediaType.split("/")[1] || mediaType;
              pendingImages.push({ format, source: { bytes: c.source.data } });
            }
          }
        }
        content = sanitizeTextForKiro(textParts.join("\n"));
        
        // Check for tool_result blocks
        const toolResultBlocks = msg.content.filter(c => c.type === "tool_result");
        if (toolResultBlocks.length > 0) {
          toolResultBlocks.forEach(block => {
            const text = truncateForKiroToolResult(stringifyToolResultContent(block.content));
            
            pendingToolResults.push({
              toolUseId: block.tool_use_id,
              status: block.is_error === true || text.includes("<tool_use_error>") ? "error" : "success",
              content: [{ text: text }]
            });
          });
        }
      }
      
      // Handle tool role (from normalized)
      if (msg.role === "tool") {
        const toolContent = truncateForKiroToolResult(stringifyToolResultContent(msg.content));
        pendingToolResults.push({
          toolUseId: msg.tool_call_id,
          status: msg.is_error === true || toolContent.includes("<tool_use_error>") ? "error" : "success",
          content: [{ text: toolContent }]
        });
      } else if (content) {
        pendingUserContent.push(content);
      }
    } else if (role === "assistant") {
      // Extract text content and tool uses
      let textContent = "";
      let toolUses = [];
      
      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter(c => c.type === "text");
        textContent = sanitizeTextForKiro(textBlocks.map(b => b.text).join("\n")).trim();
        
        const toolUseBlocks = msg.content.filter(c => c.type === "tool_use");
        toolUses = toolUseBlocks;
      } else if (typeof msg.content === "string") {
        textContent = sanitizeTextForKiro(msg.content).trim();
      }
      
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        toolUses = msg.tool_calls;
      }
      
      if (textContent && !isSyntheticKiroErrorText(textContent)) {
        pendingAssistantContent.push(textContent);
      }
      
      // Store tool uses in last assistant message
      if (toolUses.length > 0) {
        if (pendingAssistantContent.length === 0) {
          // pendingAssistantContent.push("Call tools");
        }
        
        // Flush to create assistant message with toolUses
        flushPending();
        
        const lastMsg = history[history.length - 1];
        if (lastMsg?.assistantResponseMessage) {
          lastMsg.assistantResponseMessage.toolUses = toolUses.map(compactToolUseForKiro);
        }
        
        currentRole = null;
      }
    }
  }
  
  // Flush remaining
  if (currentRole !== null) {
    flushPending();
  }
  
  // Pop last userInputMessage as currentMessage (search from end, skip trailing assistant messages)
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].userInputMessage) {
      currentMessage = history.splice(i, 1)[0];
      break;
    }
  }

  // Grab tools from first history item BEFORE cleanup removes them
  const firstHistoryTools = history[0]?.userInputMessage?.userInputMessageContext?.tools;

  // Clean up history for Kiro API compatibility
  history.forEach(item => {
    if (item.userInputMessage?.userInputMessageContext?.tools) {
      delete item.userInputMessage.userInputMessageContext.tools;
    }
    if (item.userInputMessage?.userInputMessageContext &&
        Object.keys(item.userInputMessage.userInputMessageContext).length === 0) {
      delete item.userInputMessage.userInputMessageContext;
    }
    if (item.userInputMessage && !item.userInputMessage.modelId) {
      item.userInputMessage.modelId = model;
    }
  });

  // Merge consecutive user messages (Kiro requires alternating user/assistant)
  const mergedHistory = [];
  for (let i = 0; i < history.length; i++) {
    const current = history[i];
    if (current.userInputMessage &&
        mergedHistory.length > 0 &&
        mergedHistory[mergedHistory.length - 1].userInputMessage) {
      const prev = mergedHistory[mergedHistory.length - 1];
      prev.userInputMessage.content += "\n\n" + current.userInputMessage.content;
    } else {
      mergedHistory.push(current);
    }
  }

  // Inject tools into currentMessage AFTER cleanup
  if (firstHistoryTools && currentMessage?.userInputMessage &&
      !currentMessage.userInputMessage.userInputMessageContext?.tools) {
    if (!currentMessage.userInputMessage.userInputMessageContext) {
      currentMessage.userInputMessage.userInputMessageContext = {};
    }
    currentMessage.userInputMessage.userInputMessageContext.tools = firstHistoryTools;
  }

  return { history: mergedHistory, currentMessage };
}

/**
 * Build Kiro payload from OpenAI format
 */
export function buildKiroPayload(model, body, stream, credentials) {
  const messages = body.messages || [];
  const tools = body.tools || [];
  const activeTools = capToolsForKiro(prioritizeTools(tools));
  const currentTurnToolGuidance = buildToolUseGuidance(activeTools);
  const sessionId = body._sessionId; // From Antigravity translator
  const maxTokens = body.max_tokens || body.max_completion_tokens || 32000;
  const temperature = body.temperature;
  const topP = body.top_p;
  const systemPrompt = extractSystemPrompt(messages);

  // Strip variant suffix that CodeWhisperer doesn't accept (e.g. "[1m]", "[200k]").
  // Claude CLI sometimes appends these to the model id, but the upstream rejects them.
  const normalizedModel = String(model || "").replace(/\[[^\]]+\]\s*$/, "").trim();

  const { history, currentMessage } = convertMessages(messages, tools, normalizedModel);

  const profileArn = credentials?.providerSpecificData?.profileArn || "";
  const conversationId = uuidv4();

  // Use the user's last message as-is. We deliberately avoid inlining
  // [System]/[Context] wrappers here — when the conversation grows long,
  // Kiro starts echoing those wrappers back as part of its own output.
  const rawFinalContent = currentMessage?.userInputMessage?.content || "";
  const finalContent = clampCurrentMessageForKiro(currentTurnToolGuidance
    ? `${currentTurnToolGuidance}\n\n${sanitizeTextForKiro(rawFinalContent)}`
    : sanitizeTextForKiro(rawFinalContent));

  // Inject system prompt as a virtual first user/assistant turn at the start of
  // history. This keeps the user's current turn clean while still steering the
  // model. Tagged with <system-instructions> so Kiro recognizes it as guidance,
  // not as content to be echoed back.
  if (systemPrompt) {
    history.unshift(
      {
        userInputMessage: {
          content: `<system-instructions>\n${systemPrompt}\n</system-instructions>`,
          modelId: normalizedModel,
        },
      },
      {
        assistantResponseMessage: {
          content: "Understood.",
        },
      }
    );
  }
  
  const payload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: conversationId,
      currentMessage: {
        userInputMessage: {
          content: finalContent,
          modelId: normalizedModel,
          origin: "AI_EDITOR",
          ...(currentMessage?.userInputMessage?.userInputMessageContext && {
            userInputMessageContext: currentMessage.userInputMessage.userInputMessageContext
          })
        }
      },
      history: history
    }
  };

  if (profileArn) {
    payload.profileArn = profileArn;
  }

  if (maxTokens || temperature !== undefined || topP !== undefined) {
    payload.inferenceConfig = {};
    if (maxTokens) payload.inferenceConfig.maxTokens = maxTokens;
    if (temperature !== undefined) payload.inferenceConfig.temperature = temperature;
    if (topP !== undefined) payload.inferenceConfig.topP = topP;
  }

  // Trim history aggressively before Kiro reaches the degraded large-payload range.
  let payloadSize = getPayloadSizeBytes(payload);
  const originalHistoryLen = payload.conversationState.history.length;
  const sessionInfo = sessionId ? `session=${sessionId.slice(0, 12)}...` : "no-session";

  console.log(`[KIRO] Payload: ${(payloadSize / 1024).toFixed(1)}KB (content: ${(measureContentSize(payload) / 1024).toFixed(1)}KB) | ${originalHistoryLen} history | conv=${conversationId.slice(0, 8)}... | ${sessionInfo}`);

  const effectiveMaxHistoryEntries = hasWorkflowPressure(payload)
    ? Math.min(KIRO_MAX_HISTORY_ENTRIES, KIRO_MAX_WORKFLOW_HISTORY_ENTRIES)
    : KIRO_MAX_HISTORY_ENTRIES;
  const entryTrimmed = trimHistoryToEntryLimit(payload, effectiveMaxHistoryEntries);
  if (entryTrimmed > 0) {
    payloadSize = getPayloadSizeBytes(payload);
    console.log(`[KIRO] Entry-trimmed ${entryTrimmed}/${originalHistoryLen} history entries -> ${payload.conversationState.history.length} remain (${(payloadSize / 1024).toFixed(1)}KB) | max ${effectiveMaxHistoryEntries}`);
  }

  trimHistoryToSize(payload, KIRO_SOFT_PAYLOAD_BYTES);
  normalizeHistoryShape(payload.conversationState.history, payload.conversationState.currentMessage, normalizedModel);
  const softTrimmed = originalHistoryLen - payload.conversationState.history.length;
  if (softTrimmed > 0) {
    const softPayloadSize = getPayloadSizeBytes(payload);
    const softContentSize = measureContentSize(payload);
    console.log(`[KIRO] Soft-trimmed ${softTrimmed}/${originalHistoryLen} history entries -> ${(softPayloadSize / 1024).toFixed(1)}KB (content: ${(softContentSize / 1024).toFixed(1)}KB) | target ${(KIRO_SOFT_PAYLOAD_BYTES / 1024).toFixed(0)}KB`);
  }

  const toolStats = sanitizeToolContext(payload.conversationState.history, payload.conversationState.currentMessage);
  const historyLenAfterSoftTrim = payload.conversationState.history.length;

  trimHistoryToSize(payload, KIRO_HARD_PAYLOAD_BYTES);
  normalizeHistoryShape(payload.conversationState.history, payload.conversationState.currentMessage, normalizedModel);

  const hardTrimmed = historyLenAfterSoftTrim - payload.conversationState.history.length;
  payloadSize = getPayloadSizeBytes(payload);
  const contentSize = measureContentSize(payload);

  if (hardTrimmed > 0) {
    console.log(`[KIRO] Hard-trimmed ${hardTrimmed}/${originalHistoryLen} history entries -> ${(payloadSize / 1024).toFixed(1)}KB (content: ${(contentSize / 1024).toFixed(1)}KB) | limit ${(KIRO_HARD_PAYLOAD_BYTES / 1024).toFixed(0)}KB`);
  }

  if (payload.conversationState.history.length < originalHistoryLen) {
    const historyLen = payload.conversationState.history.length;
    if (historyLen > 0) {
      const firstRole = payload.conversationState.history[0].userInputMessage ? "user" : "assistant";
      const lastRole = payload.conversationState.history[historyLen - 1].userInputMessage ? "user" : "assistant";
      console.log(`[KIRO] History structure: ${historyLen} entries | first=${firstRole} | last=${lastRole}`);
    }
  } else {
    console.log(`[KIRO] Payload within soft limit (${(payloadSize / 1024).toFixed(1)}KB < ${(KIRO_SOFT_PAYLOAD_BYTES / 1024).toFixed(0)}KB)`);
  }
  if (toolStats.removedToolResults > 0 || toolStats.removedToolUses > 0) {
    console.log(`[KIRO] Sanitized tool context: removed ${toolStats.removedToolResults} toolResults, ${toolStats.removedToolUses} toolUses`);
  }

  return payload;
}

register(FORMATS.OPENAI, FORMATS.KIRO, buildKiroPayload, null);
export { convertMessages };

