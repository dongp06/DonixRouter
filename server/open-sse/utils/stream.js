import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { trackPendingRequest, appendRequestLog } from "#lib/usageDb.js";
import { extractUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE } from "./streamHelpers.js";
import { recordStreamCloseEvent } from "../../logs/stream-close-event.js";
import path from "node:path";

export { COLORS, formatSSE };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

export function collectResponsesMetadata(payload, currentResponseId = null, functionCallIds = new Set()) {
  let nextResponseId = currentResponseId;

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { responseId: nextResponseId, functionCallIds };
  }

  if (
    (payload.type === "response.created" ||
      payload.type === "response.in_progress" ||
      payload.type === "response.completed" ||
      payload.type === "response.failed") &&
    payload.response &&
    typeof payload.response === "object" &&
    !Array.isArray(payload.response) &&
    typeof payload.response.id === "string"
  ) {
    nextResponseId = payload.response.id;
  }

  if (
    payload.type === "response.output_item.done" &&
    payload.item &&
    typeof payload.item === "object" &&
    !Array.isArray(payload.item) &&
    payload.item.type === "function_call" &&
    typeof payload.item.call_id === "string" &&
    payload.item.call_id
  ) {
    functionCallIds.add(payload.item.call_id);
  }

  return { responseId: nextResponseId, functionCallIds };
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => typeof part?.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function extractWorkspaceDir(body) {
  const haystack = [];

  if (Array.isArray(body?.messages)) {
    const head = body.messages.slice(0, 8);
    const tail = body.messages.slice(-50);
    for (const msg of [...head, ...tail]) {
      haystack.push(textFromContent(msg.content));
    }
  }

  const text = haystack.join("\n");
  const cwdPatterns = [
    /<cwd>([^<]+)<\/cwd>/i,
    /(?:current working directory|working directory|cwd)\s*[:=]\s*([A-Za-z]:[^\r\n<]+)/i,
    /Contents of ([A-Za-z]:[^\r\n]+?)[\\/]CLAUDE\.md/i,
  ];

  for (const pattern of cwdPatterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    return match[1].trim().replace(/[\\/]+CLAUDE\.md$/i, "");
  }

  const pathMatches = [...text.matchAll(/[A-Za-z]:[^\r\n"'`<>|]+/g)]
    .map(match => match[0].trim().replace(/[).,\]]+$/g, ""))
    .filter(value => /[\\/]/.test(value));

  for (const candidate of pathMatches) {
    const normalized = candidate.replace(/\//g, "\\");
    const srcMatch = normalized.match(/^(.+?)[\\/]src[\\/]/i);
    if (srcMatch?.[1]) return srcMatch[1];
    const pluginMatch = normalized.match(/^(.+?)[\\/](?:plugins|commands|utils|config|tests)[\\/]/i);
    if (pluginMatch?.[1]) return pluginMatch[1];
    if (/[\\/]package\.json$/i.test(normalized)) return path.dirname(normalized);
  }

  return null;
}

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null
  } = options;

  const MAX_SSE_BUFFER = 64 * 1024 * 1024; // 64 MB — large enough for image_generation_call events
  let buffer = "";
  let usage = null;
  let responsesResponseId = null;
  const responsesFunctionCallIds = new Set();

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE
    ? { ...initState(sourceFormat), provider, toolNameMap, model, requestTools: body?.tools, workspaceDir: extractWorkspaceDir(body) }
    : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let isFirstChunk = true;

  const updateResponsesMetadata = (payload) => {
    const next = collectResponsesMetadata(payload, responsesResponseId, responsesFunctionCallIds);
    responsesResponseId = next.responseId;
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (!ttftAt) {
        ttftAt = Date.now();
      }
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      // Non-SSE error body detection: Codex sometimes returns raw JSON error
      // instead of SSE on auth/rate-limit errors. Detect on first chunk and
      // surface as a clean error event so the client doesn't hang.
      if (isFirstChunk) {
        isFirstChunk = false;
        const trimmedFirst = buffer.trimStart();
        if (trimmedFirst.startsWith("{") && !trimmedFirst.includes("data:") && !trimmedFirst.includes("event:")) {
          try {
            const parsed = JSON.parse(trimmedFirst);
            if (parsed.error || parsed.detail) {
              const errMsg = parsed.error?.message || parsed.detail || JSON.stringify(parsed);
              console.error(`[SSE] Non-SSE error body detected: ${errMsg}`);
              const errChunk = `data: ${JSON.stringify({
                id: "chatcmpl-error",
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: model || "unknown",
                choices: [{ index: 0, delta: { content: `[Error] ${errMsg}` }, finish_reason: "stop" }]
              })}\n\ndata: [DONE]\n\n`;
              controller.enqueue(sharedEncoder.encode(errChunk));
              buffer = "";
              return;
            }
          } catch { /* not complete JSON yet — continue normal SSE parsing */ }
        }
      }

      // SSE buffer overflow protection
      if (buffer.length > MAX_SSE_BUFFER) {
        console.error(`[SSE] Buffer exceeded ${MAX_SSE_BUFFER} bytes — aborting stream`);
        controller.error(new Error(`SSE buffer exceeded ${MAX_SSE_BUFFER} bytes`));
        return;
      }

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          // Detect Responses API error events (event: response.failed / error)
          if (trimmed.startsWith("event:")) {
            const eventType = trimmed.slice(6).trim();
            if (eventType === "response.failed" || eventType === "error") {
              recordStreamCloseEvent({
                kind: "upstream-error",
                detail: `Codex SSE ${eventType} event received`,
                provider,
                model,
              });
            }
          }

          let output;
          let injectedUsage = false;

          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() !== "[DONE]") {
            try {
              const parsed = JSON.parse(trimmed.slice(5).trim());
              updateResponsesMetadata(parsed);

              const idFixed = fixInvalidId(parsed);

              // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
              let fieldsInjected = false;
              if (parsed.choices !== undefined) {
                if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
                if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
              }

              // Strip Azure-specific non-standard fields from streaming chunks
              if (parsed.prompt_filter_results !== undefined) {
                delete parsed.prompt_filter_results;
                fieldsInjected = true;
              }
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.content_filter_results !== undefined) {
                    delete choice.content_filter_results;
                    fieldsInjected = true;
                  }
                }
              }

              if (!hasValuableContent(parsed, FORMATS.OPENAI)) {
                continue;
              }

              const delta = parsed.choices?.[0]?.delta;
              const content = delta?.content;
              const reasoning = delta?.reasoning_content;
              if (content && typeof content === "string") {
                totalContentLength += content.length;
                accumulatedContent += content;
              }
              if (reasoning && typeof reasoning === "string") {
                totalContentLength += reasoning.length;
                accumulatedThinking += reasoning;
              }

              const extracted = extractUsage(parsed);
              if (extracted) {
                usage = extracted;
              }

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
                parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                injectedUsage = true;
              } else if (isFinishChunk && usage) {
                const buffered = addBufferToUsage(usage);
                parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch { }
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          reqLogger?.appendConvertedChunk?.(output);
          controller.enqueue(sharedEncoder.encode(output));
          continue;
        }

        // Translate mode
        if (!trimmed) continue;

        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) continue;
        updateResponsesMetadata(parsed);

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate.
        // For other formats: hold the upstream [DONE] until flush so translated finish chunks
        // are emitted before the single final sentinel.
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          continue;
        }

        // Claude format - content
        if (parsed.delta?.text) {
          totalContentLength += parsed.delta.text.length;
          accumulatedContent += parsed.delta.text;
        }
        // Claude format - thinking
        if (parsed.delta?.thinking) {
          totalContentLength += parsed.delta.thinking.length;
          accumulatedThinking += parsed.delta.thinking;
        }
        
        // OpenAI format - content
        if (parsed.choices?.[0]?.delta?.content) {
          totalContentLength += parsed.choices[0].delta.content.length;
          accumulatedContent += parsed.choices[0].delta.content;
        }
        // OpenAI format - reasoning
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          totalContentLength += parsed.choices[0].delta.reasoning_content.length;
          accumulatedThinking += parsed.choices[0].delta.reasoning_content;
        }
        
        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              totalContentLength += part.text.length;
              // Check if this is thinking content
              if (part.thought === true) {
                accumulatedThinking += part.text;
              } else {
                accumulatedContent += part.text;
              }
            }
          }
        }

        // Extract usage
        const extracted = extractUsage(parsed);
        if (extracted) state.usage = extracted; // Keep original usage for logging

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (translated?.length > 0) {
          for (const item of translated) {
            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat)) {
              continue; // Skip this empty chunk
            }

            // Inject estimated usage if finish chunk has no valid usage
            const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
            if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
              const estimated = estimateUsage(body, totalContentLength, sourceFormat);
              item.usage = filterUsageForFormat(estimated, sourceFormat); // Filter + already has buffer
              state.usage = estimated;
            } else if (state.finishReason && isFinishChunk && state.usage) {
              // Add buffer and filter usage for client (but keep original in state.usage for logging)
              const buffered = addBufferToUsage(state.usage);
              item.usage = filterUsageForFormat(buffered, sourceFormat);
            }

            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }
      }
    },

    flush(controller) {
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (buffer) {
            let output = buffer;
            if (buffer.startsWith("data:") && !buffer.startsWith("data: ")) {
              output = "data: " + buffer.slice(5);
            }
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }

          if (!hasValidUsage(usage) && totalContentLength > 0) {
            usage = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
          }

          if (hasValidUsage(usage)) {
            logUsage(provider, usage, model, connectionId, apiKey);
          } else {
            appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
          }
          
          // IMPORTANT: In passthrough mode we still must terminate the SSE stream.
          // Some clients (e.g. OpenClaw) expect the OpenAI-style sentinel:
          //   data: [DONE]\n\n
          // Without it they can hang until timeout and trigger failover.
          const doneOutput = "data: [DONE]\n\n";
          reqLogger?.appendConvertedChunk?.(doneOutput);
          controller.enqueue(sharedEncoder.encode(doneOutput));

          if (onStreamComplete) {
            onStreamComplete({
              content: accumulatedContent,
              thinking: accumulatedThinking
            }, usage, ttftAt, {
              responseId: responsesResponseId,
              functionCallIds: responsesFunctionCallIds.size > 0 ? [...responsesFunctionCallIds] : undefined
            });
          }
          return;
        }

        if (buffer.trim()) {
          const parsed = parseSSELine(buffer.trim());
          if (parsed && !parsed.done) {
            const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

            if (translated?._openaiIntermediate) {
              for (const item of translated._openaiIntermediate) {
                const openaiOutput = formatSSE(item, FORMATS.OPENAI);
                reqLogger?.appendOpenAIChunk?.(openaiOutput);
              }
            }

            if (translated?.length > 0) {
              for (const item of translated) {
                const output = formatSSE(item, sourceFormat);
                reqLogger?.appendConvertedChunk?.(output);
                controller.enqueue(sharedEncoder.encode(output));
              }
            }
          }
        }

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        if (flushed?.length > 0) {
          for (const item of flushed) {
            const output = formatSSE(item, sourceFormat);
            reqLogger?.appendConvertedChunk?.(output);
            controller.enqueue(sharedEncoder.encode(output));
          }
        }

        const doneOutput = "data: [DONE]\n\n";
        reqLogger?.appendConvertedChunk?.(doneOutput);
        controller.enqueue(sharedEncoder.encode(doneOutput));

        if (!hasValidUsage(state?.usage) && totalContentLength > 0) {
          state.usage = estimateUsage(body, totalContentLength, sourceFormat);
        }

        if (hasValidUsage(state?.usage)) {
          logUsage(state.provider || targetFormat, state.usage, model, connectionId, apiKey);
        } else {
          appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
        }
        
        if (onStreamComplete) {
          onStreamComplete({
            content: accumulatedContent,
            thinking: accumulatedThinking
          }, state?.usage, ttftAt, {
            responseId: responsesResponseId || state?.responseId || null,
            functionCallIds: responsesFunctionCallIds.size > 0
              ? [...responsesFunctionCallIds]
              : (state?.funcCallIds ? Object.values(state.funcCallIds).filter(Boolean) : undefined)
          });
        }
      } catch (error) {
        console.log("Error in flush:", error);
      }
    }
  });
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey
  });
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null) {
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider,
    reqLogger,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey
  });
}
