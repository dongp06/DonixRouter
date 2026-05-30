import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { v4 as uuidv4 } from "uuid";
import { refreshKiroToken } from "../services/tokenRefresh.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { HTTP_STATUS, DEFAULT_RETRY_CONFIG, resolveRetryEntry } from "../config/runtimeConfig.js";

const TEXT_DECODER = new TextDecoder();
const CRC32_TABLE = new Uint32Array(256);

for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function extractKiroErrorPayload(bodyText) {
  if (typeof bodyText !== "string") return null;

  const trimmed = bodyText.trim();
  if (!trimmed) return null;

  const candidates = [trimmed];
  if (trimmed.startsWith("data:")) {
    const payload = trimmed.slice(5).trim();
    if (payload && payload !== "[DONE]") candidates.push(payload);
  }
  if (trimmed.includes("\n")) {
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload && payload !== "[DONE]") candidates.push(payload);
    }
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

export function parseKiroErrorBody(bodyText) {
  const payload = extractKiroErrorPayload(bodyText);
  const message = typeof payload?.error?.message === "string"
    ? payload.error.message
    : typeof payload?.message === "string"
      ? payload.message
      : typeof payload?.error === "string"
        ? payload.error
        : (typeof bodyText === "string" ? bodyText.trim() : "");
  const statusText = typeof payload?.error?.status === "string"
    ? payload.error.status
    : typeof payload?.status === "string"
      ? payload.status
      : "";
  const lower = `${statusText} ${message}`.toLowerCase();
  const quotaExhausted = lower.includes("resource_exhausted")
    || lower.includes("resource has been exhausted")
    || lower.includes("check quota")
    || lower.includes("quota exhausted")
    || lower.includes("quota exceeded");
  const suspiciousActivity = lower.includes("suspicious activity")
    || lower.includes("temporary limits")
    || lower.includes("how frequently your account");

  return { payload, message, statusText, quotaExhausted, suspiciousActivity };
}

export function shouldRetryKiro429(bodyText) {
  const parsed = parseKiroErrorBody(bodyText);
  return !parsed.quotaExhausted && !parsed.suspiciousActivity;
}

/**
 * Detect Kiro upstream 400 "Input is too long" errors.
 * Kiro returns this when the conversation history exceeds the model's
 * effective context window, even if our local soft/hard byte budgets passed.
 */
export function isKiroInputTooLong(bodyText) {
  if (typeof bodyText !== "string") return false;
  const lower = bodyText.toLowerCase();
  return lower.includes("input is too long")
    || lower.includes("input too long")
    || lower.includes("context length exceeded")
    || lower.includes("too many tokens");
}

function isKiroMalformedRequest(bodyText) {
  if (typeof bodyText !== "string") return false;
  const lower = bodyText.toLowerCase();
  return lower.includes("improperly formed request")
    || lower.includes("malformed request")
    || lower.includes("invalid request");
}

function isKiroAuthTokenInvalid(status, bodyText) {
  if (status !== HTTP_STATUS.UNAUTHORIZED && status !== HTTP_STATUS.FORBIDDEN) return false;
  const lower = String(bodyText || "").toLowerCase();
  if (!lower) return true;
  return lower.includes("bearer token") && lower.includes("invalid")
    || lower.includes("token") && lower.includes("expired")
    || lower.includes("unauthorized");
}

function normalizeKiroToolArguments(toolName, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;

  const normalized = { ...args };
  if (toolName === "Read") {
    if (normalized.file_path === undefined) {
      normalized.file_path = normalized.filePath ?? normalized.path ?? normalized.filename;
    }
    delete normalized.filePath;
    delete normalized.path;
    delete normalized.filename;
    if (normalized.pages === "") delete normalized.pages;
  }
  return normalized;
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readPositiveIntEnv(name, defaultValue) {
  const raw = process.env?.[name];
  if (!raw) return defaultValue;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultValue;
}

const KIRO_FETCH_HEADER_TIMEOUT_MS = readPositiveIntEnv("KIRO_FETCH_HEADER_TIMEOUT_MS", 90_000);
const KIRO_DEBUG_EVENTS = /^(1|true|yes|on)$/i.test(process.env?.KIRO_DEBUG_EVENTS || "");
const KIRO_EMPTY_STREAM_RETRIES = readPositiveIntEnv("KIRO_EMPTY_STREAM_RETRIES", 2);

const KIRO_RETRY_CORE_TOOL_ORDER = [
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "Bash",
  "PowerShell",
  "Grep",
  "Glob",
  "Agent",
];

const KIRO_RETRY_CORE_TOOL_RANK = new Map(KIRO_RETRY_CORE_TOOL_ORDER.map((name, index) => [name, index]));

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function getKiroToolName(toolEntry) {
  return toolEntry?.toolSpecification?.name || "";
}

function trimKiroCurrentMessageTools(transformedBody, maxTools) {
  const context = transformedBody?.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext;
  const tools = context?.tools;
  if (!Array.isArray(tools) || tools.length <= maxTools) return 0;

  const unique = [];
  const seen = new Set();
  for (const tool of tools) {
    const name = getKiroToolName(tool);
    if (name && seen.has(name)) continue;
    if (name) seen.add(name);
    unique.push(tool);
  }

  unique.sort((a, b) => {
    const aRank = KIRO_RETRY_CORE_TOOL_RANK.has(getKiroToolName(a))
      ? KIRO_RETRY_CORE_TOOL_RANK.get(getKiroToolName(a))
      : Number.MAX_SAFE_INTEGER;
    const bRank = KIRO_RETRY_CORE_TOOL_RANK.has(getKiroToolName(b))
      ? KIRO_RETRY_CORE_TOOL_RANK.get(getKiroToolName(b))
      : Number.MAX_SAFE_INTEGER;
    return aRank - bRank;
  });

  context.tools = unique.slice(0, maxTools);
  return tools.length - context.tools.length;
}

function trimKiroRetryHistory(transformedBody, maxEntries) {
  const history = transformedBody?.conversationState?.history;
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

  while (history.length > 0 && !history[0]?.userInputMessage) history.shift();
  while (history.length > 0 && !history[history.length - 1]?.assistantResponseMessage) history.pop();

  return removeCount;
}

function compactToolUseInputForMalformedRetry(toolUse) {
  if (!toolUse?.input || typeof toolUse.input !== "object" || Array.isArray(toolUse.input)) return;
  const prompt = toolUse.input.prompt;
  if (typeof prompt === "string" && prompt.length > 480) {
    toolUse.input = {
      ...toolUse.input,
      prompt: `${prompt.slice(0, 360)}\n[Kiro retry compacted ${prompt.length - 480} chars from tool prompt]\n${prompt.slice(-120)}`,
    };
  }
}

function compactPayloadForMalformedRetry(transformedBody, attempt) {
  const maxHistory = attempt <= 1 ? 24 : 12;
  const removedHistory = trimKiroRetryHistory(transformedBody, maxHistory);
  const maxTools = attempt <= 1 ? 8 : 5;
  const removedTools = trimKiroCurrentMessageTools(transformedBody, maxTools);

  const history = transformedBody?.conversationState?.history;
  if (Array.isArray(history)) {
    for (const item of history) {
      const toolUses = item?.assistantResponseMessage?.toolUses;
      if (!Array.isArray(toolUses)) continue;
      for (const toolUse of toolUses) compactToolUseInputForMalformedRetry(toolUse);
    }
  }

  const current = transformedBody?.conversationState?.currentMessage?.userInputMessage;
  if (current && typeof current.content === "string" && attempt > 1 && current.content.length > 8000) {
    current.content = `${current.content.slice(0, 4200)}\n\n[Kiro retry compacted current message]\n\n${current.content.slice(-2800)}`;
  }

  return { removedHistory, maxHistory, removedTools, maxTools };
}

function prepareEmptyStreamRetryBody(originalBody, attempt) {
  const retryBody = cloneJson(originalBody);
  const maxTools = attempt <= 1 ? 8 : 5;
  const removedTools = trimKiroCurrentMessageTools(retryBody, maxTools);
  const maxHistory = attempt <= 1 ? 24 : 12;
  const removedHistory = trimKiroRetryHistory(retryBody, maxHistory);

  const userInput = retryBody?.conversationState?.currentMessage?.userInputMessage;
  if (userInput && typeof userInput.content === "string") {
    userInput.content = [
      "<kiro-retry-instructions>",
      "The previous upstream attempt returned an empty stream. Continue the user's request now.",
      "If file tools are available, use them directly. Do not ask the same question again.",
      "</kiro-retry-instructions>",
      "",
      userInput.content,
    ].join("\n");
  }

  return { retryBody, removedTools, maxTools, removedHistory, maxHistory };
}

function setKiroPayloadModelId(transformedBody, modelId) {
  const state = transformedBody?.conversationState;
  if (!state || !modelId) return;

  const visitMessage = (entry) => {
    if (entry?.userInputMessage) entry.userInputMessage.modelId = modelId;
  };

  visitMessage(state.currentMessage);
  if (Array.isArray(state.history)) {
    for (const item of state.history) visitMessage(item);
  }
}

function shouldDowngradeLargeOpusRequest(model, transformedBody) {
  if (!String(model || "").includes("opus")) return false;
  const state = transformedBody?.conversationState;
  if (!state) return false;
  const historyLen = Array.isArray(state.history) ? state.history.length : 0;
  const currentContent = state.currentMessage?.userInputMessage?.content || "";
  const toolCount = state.currentMessage?.userInputMessage?.userInputMessageContext?.tools?.length || 0;
  const payloadBytes = Buffer.byteLength(JSON.stringify(transformedBody), "utf8");
  return toolCount > 24
    || historyLen > 80
    || payloadBytes > 850 * 1024
    || (typeof currentContent === "string" && (
      currentContent.includes("<task-notification>")
      || currentContent.includes("<local-command-stdout>")
      || currentContent.includes("Set model to")
    ));
}

function createTimeoutSignal(parentSignal, timeoutMs, reason) {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId = null;

  const cleanup = () => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = null;
    parentSignal?.removeEventListener?.("abort", onParentAbort);
  };

  const onParentAbort = () => {
    cleanup();
    controller.abort(parentSignal.reason || new DOMException("Request aborted", "AbortError"));
  };

  timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(reason, "TimeoutError"));
  }, timeoutMs);

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener?.("abort", onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup,
    get timedOut() {
      return timedOut;
    },
  };
}

/**
 * Halve a Kiro payload's history in place by dropping the oldest user/assistant
 * pair(s). If the history starts with a virtual <system-instructions> turn
 * (injected by buildKiroPayload), that pair is preserved.
 * Returns the number of entries removed.
 */
function halveKiroHistory(transformedBody) {
  const history = transformedBody?.conversationState?.history;
  if (!Array.isArray(history) || history.length < 2) return 0;

  // Detect virtual system-instructions turn at head; preserve that pair.
  let preserveHead = 0;
  const firstContent = history[0]?.userInputMessage?.content || "";
  if (firstContent.startsWith("<system-instructions>") && history[1]?.assistantResponseMessage) {
    preserveHead = 2;
  }

  const trimmable = history.length - preserveHead;
  if (trimmable < 2) return 0;

  // Drop ~half the trimmable section, always an even count to keep pairs aligned.
  let toDrop = Math.floor(trimmable / 2);
  if (toDrop % 2 === 1) toDrop -= 1;
  if (toDrop < 2) toDrop = 2;

  history.splice(preserveHead, toDrop);
  return toDrop;
}

/**
 * KiroExecutor - Executor for Kiro AI (AWS CodeWhisperer)
 * Uses AWS CodeWhisperer streaming API with AWS EventStream binary format
 */
export class KiroExecutor extends BaseExecutor {
  constructor() {
    super("kiro", PROVIDERS.kiro);
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      ...this.config.headers,
      "Amz-Sdk-Request": "attempt=1; max=3",
      "Amz-Sdk-Invocation-Id": uuidv4(),
      "x-amzn-bedrock-cache-control": "enable",
      "anthropic-beta": "prompt-caching-2024-07-31"
    };

    if (credentials.accessToken) {
      headers["Authorization"] = `Bearer ${credentials.accessToken}`;
    }

    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body;

    // Kiro rejects unknown top-level fields. Preserve only the payload shape
    // emitted by the OpenAI-to-Kiro translator.
    const kiroPayload = {};
    if (body.conversationState !== undefined) kiroPayload.conversationState = body.conversationState;
    if (body.profileArn !== undefined) kiroPayload.profileArn = body.profileArn;
    if (body.inferenceConfig !== undefined) kiroPayload.inferenceConfig = body.inferenceConfig;

    if (!kiroPayload.conversationState) {
      const { model: _model, ...rest } = body;
      return rest;
    }

    return kiroPayload;
  }

  /**
   * Custom execute for Kiro - handles AWS EventStream binary response with retry support
   */
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null, onCredentialsRefreshed = null }) {
    let transformedBody = this.transformRequest(model, body, stream, credentials);
    const effectiveModel = shouldDowngradeLargeOpusRequest(model, transformedBody)
      ? "claude-sonnet-4.6"
      : model;
    if (effectiveModel !== model) {
      setKiroPayloadModelId(transformedBody, effectiveModel);
      const historyLen = transformedBody?.conversationState?.history?.length ?? 0;
      const removedTools = trimKiroCurrentMessageTools(transformedBody, 24);
      const removedHistory = trimKiroRetryHistory(transformedBody, 48);
      model = effectiveModel;
      console.warn(`[Kiro] downgraded large Opus request to ${effectiveModel}; history=${historyLen}; removedTools=${removedTools}; removedHistory=${removedHistory}; finalHistory=${transformedBody?.conversationState?.history?.length ?? 0}`);
    }
    const url = this.buildUrl(model, stream, 0);

    // Merge default retry config with provider-specific config
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    let retryAttempts = 0;
    let authRefreshAttempted = false;
    let inputTooLongAttempts = 0;
    let malformedAttempts = 0;
    const MAX_INPUT_TOO_LONG_RETRIES = 3;
    const MAX_MALFORMED_RETRIES = 2;

    while (true) {
      const headers = this.buildHeaders(credentials, stream);

      const timeout = createTimeoutSignal(
        signal,
        KIRO_FETCH_HEADER_TIMEOUT_MS,
        `Kiro did not return response headers within ${KIRO_FETCH_HEADER_TIMEOUT_MS}ms`
      );
      let response;
      try {
        response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(transformedBody),
          signal: timeout.signal
        }, proxyOptions);
      } catch (error) {
        if (timeout.timedOut) {
          log?.warn?.("KIRO", `Request timed out before response headers after ${KIRO_FETCH_HEADER_TIMEOUT_MS}ms`);
          const timeoutResponse = new Response("Kiro request timed out before response headers", {
            status: HTTP_STATUS.GATEWAY_TIMEOUT || 504,
            statusText: "Gateway Timeout",
            headers: { "Content-Type": "text/plain" }
          });
          return { response: timeoutResponse, url, headers, transformedBody };
        }
        throw error;
      } finally {
        timeout.cleanup();
      }

      // Kiro often returns 403 with a plain-text stale bearer-token message.
      // Refresh here so the generic chat handler does not have to infer it.
      if (!authRefreshAttempted && (response.status === HTTP_STATUS.UNAUTHORIZED || response.status === HTTP_STATUS.FORBIDDEN)) {
        let bodyText = "";
        try {
          bodyText = await response.clone().text();
        } catch {
          bodyText = "";
        }

        if (isKiroAuthTokenInvalid(response.status, bodyText)) {
          authRefreshAttempted = true;
          log?.warn?.("TOKEN", "KIRO | bearer token invalid, refreshing and retrying once");
          const refreshed = await this.refreshCredentials(credentials, log, proxyOptions);
          if (refreshed?.accessToken) {
            Object.assign(credentials, refreshed);
            if (onCredentialsRefreshed) {
              try {
                await onCredentialsRefreshed(refreshed);
              } catch (error) {
                log?.warn?.("TOKEN", `KIRO | persist refreshed credentials failed: ${error.message}`);
              }
            }
            continue;
          }
          log?.warn?.("TOKEN", "KIRO | refresh failed after bearer token invalid");
        }
      }

      // Handle 400 "Input is too long" by halving history and resending.
      if (response.status === 400 && inputTooLongAttempts < MAX_INPUT_TOO_LONG_RETRIES) {
        let bodyText = "";
        try {
          bodyText = await response.clone().text();
        } catch {
          bodyText = "";
        }
        if (isKiroInputTooLong(bodyText)) {
          const dropped = halveKiroHistory(transformedBody);
          if (dropped > 0) {
            inputTooLongAttempts++;
            const remaining = transformedBody?.conversationState?.history?.length ?? 0;
            log?.warn?.("KIRO", `Input too long; dropped ${dropped} oldest history entries (retry ${inputTooLongAttempts}/${MAX_INPUT_TOO_LONG_RETRIES}, ${remaining} remain)`);
            continue;
          }
          log?.warn?.("KIRO", "Input too long but history already minimal; giving up retry");
        }
      }

      // Kiro sometimes returns only "Improperly formed request" for Claude-Code
      // workflow transcripts that contain many Agent tool calls/results. The
      // JSON is valid; the upstream conversation validator is choking on the
      // tool-heavy history. Retry with a smaller, compacted transcript.
      if (response.status === 400 && malformedAttempts < MAX_MALFORMED_RETRIES) {
        let bodyText = "";
        try {
          bodyText = await response.clone().text();
        } catch {
          bodyText = "";
        }
        if (isKiroMalformedRequest(bodyText)) {
          malformedAttempts++;
          const stats = compactPayloadForMalformedRetry(transformedBody, malformedAttempts);
          log?.warn?.("KIRO", `Malformed request; compacted payload and retrying ${malformedAttempts}/${MAX_MALFORMED_RETRIES} (removedHistory=${stats.removedHistory}, maxHistory=${stats.maxHistory}, removedTools=${stats.removedTools}, maxTools=${stats.maxTools})`);
          continue;
        }
      }

      // Check if should retry based on status code
      const { attempts: maxRetries, delayMs } = resolveRetryEntry(retryConfig[response.status]);
      let shouldRetry = !response.ok && maxRetries > 0 && retryAttempts < maxRetries;
      if (shouldRetry && response.status === HTTP_STATUS.RATE_LIMITED) {
        let bodyText = "";
        try {
          bodyText = await response.clone().text();
        } catch {
          bodyText = "";
        }
        if (!shouldRetryKiro429(bodyText)) {
          log?.warn?.("KIRO", "Detected hard quota exhaustion; skipping local 429 retry");
          shouldRetry = false;
        }
      }
      if (shouldRetry) {
        retryAttempts++;
        log?.debug?.("RETRY", `${response.status} retry ${retryAttempts}/${maxRetries} after ${delayMs / 1000}s`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      if (!response.ok) {
        return { response, url, headers, transformedBody };
      }

      // Success - transform and return
      // For Kiro, we need to transform the binary EventStream to SSE
      // Create a TransformStream to convert binary to SSE text
      const retryEmptyStream = async (attempt) => {
        if (attempt > KIRO_EMPTY_STREAM_RETRIES) return null;
        const { retryBody, removedTools, maxTools, removedHistory, maxHistory } = prepareEmptyStreamRetryBody(transformedBody, attempt);
        const retryModel = String(model || "").includes("opus")
          ? "claude-sonnet-4.6"
          : model;
        if (retryModel !== model) {
          setKiroPayloadModelId(retryBody, retryModel);
        }
        const retryUrl = this.buildUrl(retryModel, stream, 0);
        const retryHeaders = this.buildHeaders(credentials, stream);
        const retryTimeout = createTimeoutSignal(
          signal,
          KIRO_FETCH_HEADER_TIMEOUT_MS,
          `Kiro empty-stream retry ${attempt} did not return response headers within ${KIRO_FETCH_HEADER_TIMEOUT_MS}ms`
        );

        try {
          console.warn(`[Kiro] empty stream retry ${attempt}/${KIRO_EMPTY_STREAM_RETRIES}; model=${retryModel}; tools removed=${removedTools}, maxTools=${maxTools}, history removed=${removedHistory}, maxHistory=${maxHistory}, history=${retryBody?.conversationState?.history?.length ?? 0}`);
          const retryResponse = await proxyAwareFetch(retryUrl, {
            method: "POST",
            headers: retryHeaders,
            body: JSON.stringify(retryBody),
            signal: retryTimeout.signal
          }, proxyOptions);

          if (!retryResponse.ok) {
            let bodyText = "";
            try {
              bodyText = await retryResponse.clone().text();
            } catch {
              bodyText = "";
            }
            console.warn(`[Kiro] empty stream retry ${attempt} returned HTTP ${retryResponse.status}: ${bodyText.slice(0, 300)}`);
            return null;
          }

          return retryResponse;
        } catch (error) {
          console.warn(`[Kiro] empty stream retry ${attempt} failed: ${error?.message || error}`);
          return null;
        } finally {
          retryTimeout.cleanup();
        }
      };

      const transformedResponse = this.transformEventStreamToSSE(response, model, { retryEmptyStream });
      return { response: transformedResponse, url, headers, transformedBody };
    }
  }

  parseError(response, bodyText) {
    const parsed = parseKiroErrorBody(bodyText);
    const message = parsed.message || bodyText || `HTTP ${response.status}`;

    if (response.status === HTTP_STATUS.RATE_LIMITED && parsed.quotaExhausted) {
      const normalized = message.toLowerCase().startsWith("kiro quota exhausted")
        ? message
        : `Kiro quota exhausted. ${message}`;
      return { status: response.status, message: normalized };
    }

    if (response.status === HTTP_STATUS.RATE_LIMITED && parsed.suspiciousActivity) {
      return { status: response.status, message };
    }

    return { status: response.status, message };
  }

  /**
   * Transform AWS EventStream binary response to SSE text stream.
   *
   * Uses a ReadableStream + manual reader so we can:
   *  - send `: keepalive\n\n` SSE comments every KEEPALIVE_MS while upstream is silent
   *    (prevents Claude CLI / OpenAI clients from tripping their stall timeout when
   *    Kiro is "thinking" for 30–90s before emitting the first frame),
   *  - run a stall watchdog that closes the stream gracefully if upstream
   *    goes quiet for STALL_MS (otherwise we'd hang forever on a half-open socket),
   *  - catch reader errors mid-stream and still emit a clean finish + [DONE]
   *    so the client never hangs.
   */
  transformEventStreamToSSE(response, model, options = {}) {
    const MAX_FRAME_SIZE = 32 * 1024 * 1024;
    const MAX_BUFFER_SIZE = 64 * 1024 * 1024;
    const KEEPALIVE_MS = 15000;     // SSE comment every 15s
    const STALL_MS = 120000;        // close gracefully if no upstream data for 120s

    const sharedEncoder = new TextEncoder();
    let buffer = new Uint8Array(0);
    let chunkIndex = 0;
    const responseId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const state = {
      finishEmitted: false,
      hasToolCalls: false,
      toolCallIndex: 0,
      seenToolIds: new Map(),
      pendingToolNames: new Map(),
      pendingToolInputs: new Map(),
      skippedIncompleteToolUse: false,
      totalContentLength: 0,
      contextUsagePercentage: 0,
      hasContextUsage: false,
      hasMeteringEvent: false,
      stopEventReceived: false,
      streamAborted: false,
      upstreamStalled: false,
      doneSent: false,
      hasMeaningfulDelta: false,
      bufferedDeltas: [],
      debugEvents: [],
    };

    const resetStateForEmptyRetry = () => {
      buffer = new Uint8Array(0);
      state.finishEmitted = false;
      state.hasToolCalls = false;
      state.toolCallIndex = 0;
      state.seenToolIds = new Map();
      state.pendingToolNames = new Map();
      state.pendingToolInputs = new Map();
      state.skippedIncompleteToolUse = false;
      state.totalContentLength = 0;
      state.contextUsagePercentage = 0;
      state.hasContextUsage = false;
      state.hasMeteringEvent = false;
      state.stopEventReceived = false;
      state.streamAborted = false;
      state.upstreamStalled = false;
      state.hasMeaningfulDelta = false;
      state.usage = undefined;
      state.bufferedDeltas = [];
      state.debugEvents = [];
    };

    const safeEnqueue = (controller, bytes) => {
      try { controller.enqueue(bytes); return true; }
      catch { return false; }
    };
    const writeChunk = (controller, payload) => {
      safeEnqueue(controller, sharedEncoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    };
    const writePing = (controller) => {
      safeEnqueue(controller, sharedEncoder.encode(`: keepalive ${Date.now()}\n\n`));
    };
    const bufferDelta = (kind, content) => {
      if (!content) return;
      state.bufferedDeltas.push({ kind, content });
      if (kind === "content") state.totalContentLength += content.length;
    };
    const flushBufferedDeltas = (controller) => {
      if (state.bufferedDeltas.length === 0) return;
      for (const item of state.bufferedDeltas) {
        const delta = item.kind === "reasoning"
          ? (chunkIndex === 0 ? { role: "assistant", reasoning_content: item.content } : { reasoning_content: item.content })
          : (chunkIndex === 0 ? { role: "assistant", content: item.content } : { content: item.content });
        state.hasMeaningfulDelta = true;
        writeChunk(controller, {
          id: responseId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: null }]
        });
        chunkIndex++;
      }
      state.bufferedDeltas = [];
    };

    const computeFinishUsage = () => {
      if (state.usage) return state.usage;
      const estimatedOutputTokens = state.totalContentLength > 0
        ? Math.max(1, Math.floor(state.totalContentLength / 4))
        : 0;
      const estimatedInputTokens = state.contextUsagePercentage > 0
        ? Math.floor(state.contextUsagePercentage * 200000 / 100)
        : 0;
      return {
        prompt_tokens: estimatedInputTokens,
        completion_tokens: estimatedOutputTokens,
        total_tokens: estimatedInputTokens + estimatedOutputTokens
      };
    };

    const emitFinish = (controller, { force = false } = {}) => {
      if (state.finishEmitted) return;
      const hasMeteringPair = state.hasMeteringEvent && state.hasContextUsage;
      const ready = state.stopEventReceived && hasMeteringPair;
      if (!force && !ready) return;
      const hasIncompleteToolUse = state.skippedIncompleteToolUse
        || state.pendingToolInputs.size > 0
        || (state.pendingToolNames.size > 0 && !state.hasToolCalls);
      const hasOutput = state.hasMeaningfulDelta || state.bufferedDeltas.length > 0;
      if (!force && (hasIncompleteToolUse || !hasOutput)) return;
      flushBufferedDeltas(controller);

      state.finishEmitted = true;

      // finish_reason MUST match what we already streamed. By the time we get
      // here, any tool_call deltas have already been sent downstream and the
      // OpenAI→Claude translator has already opened tool_use content blocks —
      // we cannot retroactively turn those into a plain "stop" without producing
      // a self-contradictory message (tool_use blocks + end_turn), which breaks
      // Claude Code's agentic loop. So: if we saw tool calls, finish as tool_calls.
      const finishReason = state.hasToolCalls ? "tool_calls" : "stop";

      const finishChunk = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      };
      if (state.usage) {
        finishChunk.usage = state.usage;
      } else if (force) {
        finishChunk.usage = computeFinishUsage();
      }
      writeChunk(controller, finishChunk);
    };

    const emitErrorChunk = (controller, message) => {
      const errChunk = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: chunkIndex === 0
            ? { role: "assistant", content: `[Kiro Error] ${message}` }
            : { content: `\n\n[Kiro Error] ${message}` },
          finish_reason: null
        }]
      };
      chunkIndex++;
      writeChunk(controller, errChunk);
    };
    const emitFallbackChunk = (controller, message) => {
      const fallbackChunk = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: chunkIndex === 0
            ? { role: "assistant", content: message }
            : { content: message },
          finish_reason: null
        }]
      };
      chunkIndex++;
      state.hasMeaningfulDelta = true;
      state.totalContentLength += message.length;
      writeChunk(controller, fallbackChunk);
    };

    const emitDone = (controller) => {
      if (state.doneSent) return;
      state.doneSent = true;
      safeEnqueue(controller, sharedEncoder.encode("data: [DONE]\n\n"));
    };

    const drainFrames = (controller) => {
      while (buffer.length >= 12) {
        const view = new DataView(buffer.buffer, buffer.byteOffset);
        const totalLength = view.getUint32(0, false);

        if (totalLength < 16 || totalLength > MAX_FRAME_SIZE) {
          console.error(`[Kiro] Invalid EventStream frame totalLength=${totalLength}; aborting parse`);
          state.streamAborted = true;
          emitErrorChunk(controller, `corrupted frame (size=${totalLength})`);
          state.stopEventReceived = true;
          emitFinish(controller, { force: true });
          buffer = new Uint8Array(0);
          return;
        }

        if (buffer.length < totalLength) break;

        const eventData = buffer.slice(0, totalLength);
        buffer = buffer.slice(totalLength);

        const event = parseEventFrame(eventData);
        if (!event) continue;

        const messageType = event.headers[":message-type"] || "event";
        const eventType = event.headers[":event-type"] || "";
        if (KIRO_DEBUG_EVENTS || !state.hasMeaningfulDelta) {
          state.debugEvents.push(eventType || messageType || "unknown");
          if (state.debugEvents.length > 80) state.debugEvents.shift();
        }

        if (messageType === "exception" || messageType === "error") {
          const errMsg = (event.payload && (event.payload.message || event.payload.Message))
            || event.headers[":exception-type"]
            || event.headers[":error-message"]
            || `${messageType}: ${eventType || "unknown"}`;
          console.warn(`[Kiro] EventStream ${messageType}: ${errMsg}`);
          emitErrorChunk(controller, String(errMsg).slice(0, 500));
          state.stopEventReceived = true;
          emitFinish(controller, { force: true });
          state.streamAborted = true;
          buffer = new Uint8Array(0);
          return;
        }

        if (eventType === "assistantResponseEvent" && event.payload?.content) {
          const content = event.payload.content;
          bufferDelta("content", content);
          continue;
        }

        if (eventType === "codeEvent" && event.payload?.content) {
          bufferDelta("content", event.payload.content);
          continue;
        }

        // Reasoning/thinking deltas. Emitted as OpenAI `reasoning_content` so the
        // downstream openai-to-claude translator turns them into Claude thinking
        // blocks. A turn that is pure reasoning is still valid output.
        if (eventType === "reasoningContentEvent" && event.payload?.content) {
          const reasoning = event.payload.content;
          bufferDelta("reasoning", reasoning);
          continue;
        }

        if (eventType === "toolUseEvent" && event.payload) {
          const toolUse = event.payload;
          const toolUses = Array.isArray(toolUse) ? toolUse : [toolUse];

          for (const singleToolUse of toolUses) {
            const toolCallId = singleToolUse.toolUseId || `call_${Date.now()}`;
            const toolName = singleToolUse.name || state.pendingToolNames.get(toolCallId) || "";
            if (singleToolUse.name) state.pendingToolNames.set(toolCallId, singleToolUse.name);
            const toolInput = singleToolUse.input;

            if (toolInput === undefined || toolInput === null) {
              continue;
            }

            if (!toolName) {
              state.skippedIncompleteToolUse = true;
              console.warn(`[Kiro] Skipping incomplete toolUseEvent for ${toolCallId}: missing tool name`);
              continue;
            }

            let parsedArgs;
            if (typeof toolInput === "string") {
              const inputFragment = toolInput;
              if (!inputFragment.trim()) continue;

              const combinedInput = (state.pendingToolInputs.get(toolCallId) || "") + inputFragment;
              parsedArgs = parseJsonObject(combinedInput.trim());
              if (!parsedArgs) {
                state.pendingToolInputs.set(toolCallId, combinedInput);
                continue;
              }
              state.pendingToolInputs.delete(toolCallId);
            } else if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
              parsedArgs = toolInput;
              state.pendingToolInputs.delete(toolCallId);
            } else {
              state.skippedIncompleteToolUse = true;
              console.warn(`[Kiro] Skipping incomplete toolUseEvent for ${toolName || toolCallId}: input is not a JSON object`);
              continue;
            }

            const argumentsStr = JSON.stringify(normalizeKiroToolArguments(toolName, parsedArgs));

            const isNewTool = !state.seenToolIds.has(toolCallId);
            const toolIndex = isNewTool ? state.toolCallIndex++ : state.seenToolIds.get(toolCallId);
            if (isNewTool) state.seenToolIds.set(toolCallId, toolIndex);
            state.pendingToolNames.delete(toolCallId);

            flushBufferedDeltas(controller);
            state.hasToolCalls = true;
            state.hasMeaningfulDelta = true;
            writeChunk(controller, {
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{
                index: 0,
                delta: {
                  ...(chunkIndex === 0 ? { role: "assistant" } : {}),
                  tool_calls: [{
                    index: toolIndex,
                    ...(isNewTool ? { id: toolCallId, type: "function" } : {}),
                    function: {
                      ...(isNewTool ? { name: toolName } : {}),
                      arguments: argumentsStr
                    }
                  }]
                },
                finish_reason: null
              }]
            });
            chunkIndex++;
          }
          continue;
        }

        if (eventType === "messageStopEvent") {
          state.stopEventReceived = true;
          emitFinish(controller);
          continue;
        }

        if (eventType === "contextUsageEvent") {
          const pct = event.payload?.contextUsagePercentage;
          if (typeof pct === "number") state.contextUsagePercentage = pct;
          state.hasContextUsage = true;
          emitFinish(controller);
          continue;
        }

        if (eventType === "meteringEvent") {
          state.hasMeteringEvent = true;
          const metering = event.payload?.meteringEvent || event.payload;
          if (metering && typeof metering === "object") {
            const inputTokens = metering.inputTokens || metering.promptTokens || 0;
            const outputTokens = metering.outputTokens || metering.completionTokens || 0;
            if (inputTokens > 0 || outputTokens > 0) {
              state.usage = {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens
              };
            }
          }
          emitFinish(controller);
          continue;
        }

        if (eventType === "metricsEvent") {
          const metrics = event.payload?.metricsEvent || event.payload;
          if (metrics && typeof metrics === "object") {
            const inputTokens = metrics.inputTokens || 0;
            const outputTokens = metrics.outputTokens || 0;
            if (inputTokens > 0 || outputTokens > 0) {
              state.usage = {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens
              };
            }
          }
          continue;
        }
      }
    };

    if (!response.body) {
      const emptyBodyError = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: { role: "assistant", content: "[Kiro Error] upstream returned no response body" },
          finish_reason: null
        }]
      };
      const emptyBodyFinish = {
        id: responseId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 }
      };
      return new Response(
        `data: ${JSON.stringify(emptyBodyError)}\n\ndata: ${JSON.stringify(emptyBodyFinish)}\n\ndata: [DONE]\n\n`,
        {
        status: response.status,
        headers: { "Content-Type": "text/event-stream" }
        }
      );
    }

    const out = new ReadableStream({
      async start(controller) {
        // Initial role chunk so the client immediately sees a valid OpenAI delta.
        writeChunk(controller, {
          id: responseId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
        });
        chunkIndex++;

        let reader = response.body.getReader();
        let emptyRetryAttempts = 0;
        let lastDataAt = Date.now();
        let closed = false;

        const pingTimer = setInterval(() => {
          if (closed) return;
          // Only ping if upstream has been silent for at least one keepalive
          // window — avoids interleaving pings between back-to-back frames.
          if (Date.now() - lastDataAt >= KEEPALIVE_MS) writePing(controller);
        }, KEEPALIVE_MS);

        const stallTimer = setInterval(() => {
          if (closed) return;
          if (Date.now() - lastDataAt < STALL_MS) return;
          if (
            !state.hasMeaningfulDelta
            && state.bufferedDeltas.length === 0
            && !state.upstreamStalled
            && typeof options.retryEmptyStream === "function"
            && emptyRetryAttempts < KIRO_EMPTY_STREAM_RETRIES
          ) {
            console.warn(`[Kiro] upstream silent for ${STALL_MS}ms before first delta; retrying internally`);
            state.upstreamStalled = true;
            try { reader.cancel("stall-before-delta"); } catch { /* ignore */ }
            return;
          }
          if (state.upstreamStalled) return;
          console.warn(`[Kiro] upstream silent for ${STALL_MS}ms — closing gracefully`);
          state.streamAborted = true;
          emitErrorChunk(controller, "upstream stalled");
          state.stopEventReceived = true;
          emitFinish(controller, { force: true });
          emitDone(controller);
          try { reader.cancel("stall"); } catch { /* ignore */ }
        }, Math.max(5000, Math.floor(STALL_MS / 8)));

        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(pingTimer);
          clearInterval(stallTimer);
          const hasIncompleteToolUse = state.skippedIncompleteToolUse
            || state.pendingToolInputs.size > 0
            || (state.pendingToolNames.size > 0 && !state.hasToolCalls);
          if (!state.finishEmitted && !state.streamAborted && hasIncompleteToolUse) {
            const pending = state.pendingToolInputs.size || state.pendingToolNames.size;
            console.warn(`[Kiro] upstream ended before complete tool parameters; events=${state.debugEvents.join(",") || "none"}; pending=${pending}`);
            if (!state.hasMeaningfulDelta) {
              emitErrorChunk(controller, "upstream ended before complete tool parameters");
            } else {
              console.warn("[Kiro] suppressing incomplete trailing tool_use because valid assistant output was already streamed");
            }
            state.stopEventReceived = true;
          } else if (
            !state.finishEmitted
            && !state.streamAborted
            && !state.hasMeaningfulDelta
            && state.bufferedDeltas.length === 0
          ) {
            console.warn(`[Kiro] upstream returned empty response; events=${state.debugEvents.join(",") || "none"}`);
            emitFallbackChunk(controller, "Kiro upstream did not return usable content after retry. Continue with a shorter direct instruction, or reduce background-agent/workflow history.");
            state.stopEventReceived = true;
          } else if (KIRO_DEBUG_EVENTS) {
            console.log(`[Kiro] event sequence: ${state.debugEvents.join(",") || "none"}`);
          }
          if (!state.finishEmitted) emitFinish(controller, { force: true });
          emitDone(controller);
          try { controller.close(); } catch { /* already closed */ }
        };

        try {
          while (true) {
            while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (state.streamAborted) break;

            lastDataAt = Date.now();

            const merged = new Uint8Array(buffer.length + value.length);
            merged.set(buffer);
            merged.set(value, buffer.length);
            buffer = merged;

            if (buffer.length > MAX_BUFFER_SIZE) {
              console.error(`[Kiro] EventStream buffer exceeded ${MAX_BUFFER_SIZE} bytes — aborting`);
              state.streamAborted = true;
              emitErrorChunk(controller, "stream buffer overflow");
              state.stopEventReceived = true;
              emitFinish(controller, { force: true });
              buffer = new Uint8Array(0);
              break;
            }

            drainFrames(controller);
          }

            const hasIncompleteBeforeRetry = state.skippedIncompleteToolUse
              || state.pendingToolInputs.size > 0
              || (state.pendingToolNames.size > 0 && !state.hasToolCalls);
            const canRetryEmpty = !state.streamAborted
              && !state.finishEmitted
              && !state.hasMeaningfulDelta
              && (state.bufferedDeltas.length === 0 || hasIncompleteBeforeRetry)
              && typeof options.retryEmptyStream === "function"
              && emptyRetryAttempts < KIRO_EMPTY_STREAM_RETRIES;

            if (!canRetryEmpty) break;

            emptyRetryAttempts++;
            const retryReason = state.upstreamStalled ? "stalled before first delta" : "empty response";
            console.warn(`[Kiro] upstream ${retryReason}; retrying internally (${emptyRetryAttempts}/${KIRO_EMPTY_STREAM_RETRIES}); events=${state.debugEvents.join(",") || "none"}`);
            writePing(controller);
            const retryResponse = await options.retryEmptyStream(emptyRetryAttempts);
            if (!retryResponse?.body) {
              if (emptyRetryAttempts < KIRO_EMPTY_STREAM_RETRIES) continue;
              break;
            }

            resetStateForEmptyRetry();
            reader = retryResponse.body.getReader();
            lastDataAt = Date.now();
          }
        } catch (err) {
          // Upstream socket reset / fetch body error — most common cause of
          // "broken chunk" symptoms in long sessions. Recover gracefully.
          const message = String(err?.message || err || "unknown");
          const hasIncompleteToolUse = state.skippedIncompleteToolUse
            || state.pendingToolInputs.size > 0
            || (state.pendingToolNames.size > 0 && !state.hasToolCalls);
          const benignAfterDelta = state.hasMeaningfulDelta
            && !hasIncompleteToolUse
            && /terminated|aborted|premature close|socket|econnreset/i.test(message);
          console.warn(`[Kiro] upstream body read error: ${message}${benignAfterDelta ? " (finishing with partial upstream data)" : ""}`);
          if (!state.finishEmitted) {
            if (!benignAfterDelta) {
              emitErrorChunk(controller, `upstream interrupted: ${message}`);
            }
            state.stopEventReceived = true;
            emitFinish(controller, { force: true });
          }
        } finally {
          cleanup();
        }
      },

      cancel(reason) {
        // Client (Claude CLI) hung up — nothing more to do, GC will release the reader.
        console.warn(`[Kiro] downstream cancelled: ${reason || "unknown"}`);
      }
    });

    return new Response(out, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      }
    });
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    try {
      // Use centralized refreshKiroToken function (handles both AWS SSO OIDC and Social Auth)
      const result = await refreshKiroToken(
        credentials.refreshToken,
        credentials.providerSpecificData,
        log,
        proxyOptions
      );

      if (!result || result.error) return result;

      if (result._newClientId) {
        return {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresIn: result.expiresIn,
          providerSpecificData: {
            ...(credentials.providerSpecificData || {}),
            clientId: result._newClientId,
            clientSecret: result._newClientSecret,
            clientSecretExpiresAt: result._newClientSecretExpiresAt,
          },
        };
      }

      return result;
    } catch (error) {
      log?.error?.("TOKEN", `Kiro refresh error: ${error.message}`);
      return null;
    }
  }
}

/**
 * Parse AWS EventStream frame
 */
function parseEventFrame(data) {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const totalLength = view.getUint32(0, false);
    const headersLength = view.getUint32(4, false);
    const preludeCRC = view.getUint32(8, false);
    const computedPreludeCRC = crc32(data.slice(0, 8));

    if (totalLength !== data.length || totalLength < 16) {
      console.warn(`[Kiro] Invalid frame length: declared ${totalLength}, actual ${data.length}`);
      return null;
    }

    if (preludeCRC !== computedPreludeCRC) {
      console.warn(`[Kiro] Prelude CRC mismatch: expected ${preludeCRC}, got ${computedPreludeCRC}`);
      return null;
    }

    const messageCRC = view.getUint32(data.length - 4, false);
    const computedMessageCRC = crc32(data.slice(0, data.length - 4));
    if (messageCRC !== computedMessageCRC) {
      console.warn(`[Kiro] Message CRC mismatch: expected ${messageCRC}, got ${computedMessageCRC}`);
      return null;
    }

    // Parse headers
    const headers = {};
    let offset = 12; // After prelude
    const headerEnd = 12 + headersLength;

    while (offset < headerEnd && offset < data.length) {
      const nameLen = data[offset];
      offset++;
      if (offset + nameLen > data.length) break;

      const name = TEXT_DECODER.decode(data.slice(offset, offset + nameLen));
      offset += nameLen;

      const headerType = data[offset];
      offset++;

      // AWS EventStream header types — handle the common ones, skip the rest
      // by advancing `offset` instead of breaking. Breaking here drops every
      // header after an unknown one, including :message-type, which causes the
      // parser to misclassify exception frames as normal events.
      // 0 = bool true (no value), 1 = bool false (no value), 2 = byte (1B),
      // 3 = short (2B), 4 = int (4B), 5 = long (8B), 6 = byte array (2B len),
      // 7 = string (2B len), 8 = timestamp (8B), 9 = uuid (16B).
      if (headerType === 0 || headerType === 1) {
        // bool — no value bytes
      } else if (headerType === 2) {
        offset += 1;
      } else if (headerType === 3) {
        offset += 2;
      } else if (headerType === 4) {
        offset += 4;
      } else if (headerType === 5 || headerType === 8) {
        offset += 8;
      } else if (headerType === 6 || headerType === 7) {
        if (offset + 2 > data.length) break;
        const valueLen = (data[offset] << 8) | data[offset + 1];
        offset += 2;
        if (offset + valueLen > data.length) break;

        if (headerType === 7) {
          headers[name] = TEXT_DECODER.decode(data.slice(offset, offset + valueLen));
        }
        offset += valueLen;
      } else if (headerType === 9) {
        offset += 16;
      } else {
        // Truly unknown type — bail out of header parsing for this frame.
        break;
      }
    }

    // Parse payload
    const payloadStart = 12 + headersLength;
    const payloadEnd = data.length - 4; // Exclude message CRC

    let payload = null;
    if (payloadEnd > payloadStart) {
      const payloadStr = TEXT_DECODER.decode(data.slice(payloadStart, payloadEnd));

      // Skip empty or whitespace-only payloads
      if (!payloadStr || !payloadStr.trim()) {
        return { headers, payload: null };
      }

      try {
        payload = JSON.parse(payloadStr);
      } catch (parseError) {
        // Log parse error for debugging
        console.warn(`[Kiro] Failed to parse payload: ${parseError.message} | payload: ${payloadStr.substring(0, 100)}`);
        payload = { raw: payloadStr };
      }
    }

    return { headers, payload };
  } catch {
    return null;
  }
}

export default KiroExecutor;
