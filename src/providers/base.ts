/**
 * Provider 抽象接口 + 共用工具（SSE 解析、Fetch 包装）。
 *
 * 所有 Provider（MiniMax、Anthropic 原生、OpenAI 兼容、...）都实现 LLMProvider。
 * Provider 内部使用 toRequest/fromResponse 做协议翻译，对外只暴露统一 API。
 */

import type { ChatRequest, ChatResponse, LLMError, StreamEvent } from '../types.js';
import { LLMError as LLMErrorClass } from '../types.js';

// ---------------------------------------------------------------------------
// Provider 接口
// ---------------------------------------------------------------------------

export interface LLMProvider {
  /** Provider 名称（用于日志 / 错误信息） */
  readonly name: string;

  /** 非流式对话 */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /** 流式对话 —— 调用方按需消费事件 */
  stream(request: ChatRequest): AsyncIterable<StreamEvent>;
}

// ---------------------------------------------------------------------------
// 共用 Provider 配置（可选 fetch 实现，便于在测试里注入 mock）
// ---------------------------------------------------------------------------

export type ProviderFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export type ProviderConfigBase = {
  /** 自定义 fetch（默认用全局 fetch） */
  fetch?: ProviderFetch;
  /** 自定义超时（毫秒），0 表示不超时 */
  timeoutMs?: number;
};

// ---------------------------------------------------------------------------
// HTTP 辅助：带超时 / 错误归一化的 fetch
// ---------------------------------------------------------------------------

/**
 * 把 fetch 包装为：超时 + 错误归一化。
 * 401/403/429/5xx 都转成 LLMError，便于上层做重试或限流。
 */
export async function doFetch(
  url: string,
  init: RequestInit,
  options: {
    provider: string;
    fetchImpl?: ProviderFetch;
    timeoutMs?: number;
  },
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  // 组合 signal：用户传入的 + 超时
  const signals: AbortSignal[] = [];
  if (init.signal) signals.push(init.signal);
  if (options.timeoutMs && options.timeoutMs > 0) {
    signals.push(AbortSignal.timeout(options.timeoutMs));
  }
  const signal =
    signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals);

  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal });
  } catch (err) {
    // 中断 / 网络 / 超时
    if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new LLMErrorClass(
        'network',
        `Request aborted${err.name === 'TimeoutError' ? ' (timeout)' : ''}`,
        { provider: options.provider, cause: err },
      );
    }
    throw new LLMErrorClass('network', `Network request failed: ${(err as Error).message}`, {
      provider: options.provider,
      cause: err,
    });
  }

  if (!response.ok) {
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      try {
        raw = await response.text();
      } catch {
        raw = null;
      }
    }
    const message = extractErrorMessage(raw) ?? `HTTP ${response.status}`;
    throw new LLMErrorClass(mapStatusToCode(response.status), message, {
      provider: options.provider,
      status: response.status,
      raw,
    });
  }

  return response;
}

function mapStatusToCode(status: number): LLMError['code'] {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status === 400) return 'invalid_request';
  if (status === 413 || status === 414) return 'context_length';
  if (status >= 500) return 'server';
  return 'unknown';
}

function extractErrorMessage(raw: unknown): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r.message === 'string') return r.message;
    if (typeof r.error === 'string') return r.error;
    if (typeof r.error === 'object' && r.error && typeof (r.error as Record<string, unknown>).message === 'string') {
      return (r.error as Record<string, unknown>).message as string;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// SSE 解析（Server-Sent Events）
// ---------------------------------------------------------------------------

/**
 * 原始 SSE 事件：event + data 两个字段。
 * Anthropic / OpenAI / MiniMax 都遵循此格式，差异在 data 字段的 JSON 结构。
 */
export type RawSSEEvent = {
  readonly event: string | null;
  readonly data: string;
};

/**
 * 把 ReadableStream<Uint8Array> 解析成 RawSSEEvent 序列。
 *
 * 处理：
 * - \r\n 与 \n 都视为行分隔
 * - 空行（\n\n）触发事件分发
 * - data: 多行拼接（每行 data: 前缀去掉，用 \n 连接）
 * - event: 单行
 * - : 开头的行视为注释（如 :ping）跳过
 * - 末尾 data: [DONE] 自动以 { data: '[DONE]' } 形式产出
 */
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<RawSSEEvent> {
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();

  let buffer = '';
  let eventName: string | null = null;
  let dataLines: string[] = [];

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 按行切分（容忍 \r\n 与 \n）
      let newlineIdx: number;
      // eslint-disable-next-line no-cond-assign
      while ((newlineIdx = buffer.search(/\r\n|\n/)) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + (buffer[newlineIdx] === '\r' ? 2 : 1));

        if (line === '') {
          // 事件分界
          if (dataLines.length > 0) {
            yield { event: eventName, data: dataLines.join('\n') };
            eventName = null;
            dataLines = [];
          }
          continue;
        }
        if (line.startsWith(':')) {
          // 注释 / 心跳
          continue;
        }
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trimStart();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
        // 其他字段（id:, retry:）忽略 —— 当前用不到
      }
    }

    // flush 末尾
    if (dataLines.length > 0) {
      yield { event: eventName, data: dataLines.join('\n') };
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 已经释放，忽略
    }
  }
}