import { doFetch, parseSSE } from '../base.js';
import { LLMError, type ChatRequest, type StopReason, type StreamEvent, type Usage } from '../../types.js';
import type { ResolvedOllamaConfig } from './config.js';
import {
  mapOpenAIStopReason,
  toOpenAIRequest,
  type OpenAIStreamChunk,
} from './translate.js';
import { buildHeaders } from './chat.js';

// 思考型模型先吐 reasoning 再吐 content；按出现顺序分配块索引，保证最终 ContentBlock 顺序为 thinking → text → tool_use。
const THINKING_BLOCK_INDEX = 0;
const TEXT_BLOCK_INDEX = 1;
const TOOL_BLOCK_OFFSET = 2;

export async function* ollamaStream(
  config: ResolvedOllamaConfig,
  request: ChatRequest,
): AsyncIterable<StreamEvent> {
  const body = { ...toOpenAIRequest(request), stream: true, stream_options: { include_usage: true } };

  const response = await doFetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(body),
    signal: request.signal,
  }, {
    provider: 'Ollama',
    fetchImpl: config.fetch,
    timeoutMs: config.timeoutMs,
  });

  if (!response.body) {
    throw new LLMError('network', 'Response has no body (stream)', { provider: 'Ollama' });
  }

  let messageStarted = false;
  let messageId = '';
  let messageModel = '';
  let thinkingStarted = false;
  let thinkingStopped = false;
  let textStarted = false;
  let textStopped = false;
  const toolStarted = new Set<number>();
  const toolStopped = new Set<number>();
  let lastUsage: Usage | undefined;
  let pendingStopReason: StopReason | undefined;

  function makeMessageStart(): StreamEvent | null {
    if (messageStarted) return null;
    messageStarted = true;
    return {
      type: 'message_start',
      id: messageId || `ollama_${Date.now()}`,
      model: messageModel,
    };
  }

  for await (const sse of parseSSE(response.body)) {
    if (sse.data === '[DONE]') break;

    let chunk: OpenAIStreamChunk;
    try {
      chunk = JSON.parse(sse.data) as OpenAIStreamChunk;
    } catch (err) {
      throw new LLMError('parse', 'Failed to parse Ollama SSE chunk', {
        provider: 'Ollama',
        raw: sse.data,
        cause: err,
      });
    }

    if (chunk.id) messageId = chunk.id;
    if (chunk.model) messageModel = chunk.model;

    if (chunk.usage) {
      lastUsage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
      };
      if (pendingStopReason) {
        yield {
          type: 'message_delta',
          stopReason: pendingStopReason,
          usage: lastUsage,
        };
        pendingStopReason = undefined;
      }
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;

    if (delta.reasoning) {
      const ms = makeMessageStart();
      if (ms) yield ms;
      if (!thinkingStarted) {
        yield {
          type: 'content_block_start',
          index: THINKING_BLOCK_INDEX,
          block: { type: 'thinking', thinking: '' },
        };
        thinkingStarted = true;
      }
      yield {
        type: 'content_block_delta',
        index: THINKING_BLOCK_INDEX,
        delta: { type: 'thinking_delta', thinking: delta.reasoning },
      };
    }

    if (delta.content) {
      const ms = makeMessageStart();
      if (ms) yield ms;
      if (!textStarted) {
        yield {
          type: 'content_block_start',
          index: TEXT_BLOCK_INDEX,
          block: { type: 'text', text: '' },
        };
        textStarted = true;
      }
      yield {
        type: 'content_block_delta',
        index: TEXT_BLOCK_INDEX,
        delta: { type: 'text_delta', text: delta.content },
      };
    }

    if (delta.tool_calls && delta.tool_calls.length > 0) {
      const ms = makeMessageStart();
      if (ms) yield ms;
      for (const tc of delta.tool_calls) {
        const blockIdx = (tc.index ?? 0) + TOOL_BLOCK_OFFSET;

        if (!toolStarted.has(blockIdx)) {
          yield {
            type: 'content_block_start',
            index: blockIdx,
            block: {
              type: 'tool_use',
              id: tc.id ?? `call_${blockIdx}`,
              name: tc.function?.name ?? '',
              input: {},
            },
          };
          toolStarted.add(blockIdx);
        }
        const args = tc.function?.arguments ?? '';
        if (args) {
          yield {
            type: 'content_block_delta',
            index: blockIdx,
            delta: { type: 'input_json_delta', partialJson: args },
          };
        }
      }
    }

    if (choice.finish_reason) {
      if (thinkingStarted && !thinkingStopped) {
        yield { type: 'content_block_stop', index: THINKING_BLOCK_INDEX };
        thinkingStopped = true;
      }
      if (textStarted && !textStopped) {
        yield { type: 'content_block_stop', index: TEXT_BLOCK_INDEX };
        textStopped = true;
      }
      for (const idx of toolStarted) {
        if (!toolStopped.has(idx)) {
          yield { type: 'content_block_stop', index: idx };
          toolStopped.add(idx);
        }
      }
      const stopReason = mapOpenAIStopReason(choice.finish_reason);
      if (lastUsage) {
        yield { type: 'message_delta', stopReason, usage: lastUsage };
      } else {
        pendingStopReason = stopReason;
      }
    }
  }

  if (pendingStopReason) {
    const md: StreamEvent = { type: 'message_delta', stopReason: pendingStopReason };
    if (lastUsage) (md as { usage?: Usage }).usage = lastUsage;
    yield md;
  }

  if (thinkingStarted && !thinkingStopped) {
    yield { type: 'content_block_stop', index: THINKING_BLOCK_INDEX };
  }
  if (textStarted && !textStopped) {
    yield { type: 'content_block_stop', index: TEXT_BLOCK_INDEX };
  }
  for (const idx of toolStarted) {
    if (!toolStopped.has(idx)) {
      yield { type: 'content_block_stop', index: idx };
    }
  }
  yield { type: 'message_stop' };
}