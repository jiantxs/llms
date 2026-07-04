/**
 * MiniMax 流式 chat —— 把 Anthropic 兼容 SSE 转成统一 StreamEvent 序列。
 *
 * 关键设计：
 * - SSE 解析在 base.ts 的 parseSSE() 里做；这里只做协议事件 → 统一事件的翻译
 * - ping / 不识别事件静默跳过，不向调用方暴露
 * - tool_use 的 input JSON 由调用方在 content_block_stop 时自行合并 + 解析（与 Anthropic SDK 行为一致）
 */

import { doFetch, parseSSE } from '../base.js';
import { LLMError, type ChatRequest, type StreamEvent } from '../../types.js';
import type { ResolvedMiniMaxConfig } from './config.js';
import { fromMiniMaxStreamEvent, toMiniMaxRequest, type MiniMaxStreamEvent } from './translate.js';

const MESSAGES_PATH = '/v1/messages';

export async function* minimaxStream(
  config: ResolvedMiniMaxConfig,
  request: ChatRequest,
): AsyncIterable<StreamEvent> {
  const body = { ...toMiniMaxRequest(request), stream: true };

  const response = await doFetch(`${config.baseUrl}${MESSAGES_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: request.signal,
  }, {
    provider: 'MiniMax',
    fetchImpl: config.fetch,
    timeoutMs: config.timeoutMs,
  });

  if (!response.body) {
    throw new LLMError('network', 'Response has no body (stream)', { provider: 'MiniMax' });
  }

  for await (const sse of parseSSE(response.body)) {
    // OpenAI 风格流式有时会用 [DONE] 哨兵 —— MiniMax / Anthropic 不发，但兼容处理
    if (sse.data === '[DONE]') continue;

    let parsed: MiniMaxStreamEvent;
    try {
      parsed = JSON.parse(sse.data) as MiniMaxStreamEvent;
    } catch (err) {
      throw new LLMError('parse', `Failed to parse SSE data: ${(err as Error).message}`, {
        provider: 'MiniMax',
        raw: sse.data,
        cause: err,
      });
    }

    const event = fromMiniMaxStreamEvent(parsed);
    if (event !== null) {
      yield event;
    }
  }
}