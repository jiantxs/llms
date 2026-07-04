/**
 * runWithTools —— 一次性自动工具调用循环。
 *
 * 行为：
 *   1. chat(model, messages, tools)  ——  或 stream() + 累积（当 stream=true）
 *   2. 若响应含 tool_use 块 → 并发执行（Promise.all）→ 拼成 tool_result 块加入历史
 *   3. 回到 1，直到模型不再产生 tool_use
 *   4. 单工具执行失败不影响其他工具，结果以 isError: true 的 tool_result 写回
 *   5. 达到 maxIterations 抛 LLMError(tool_loop_exceeded)
 *
 * 执行器优先级：opts.executeTool(name, input) > Tool.execute
 */

import {
  LLMError,
  type ChatResponse,
  type ContentBlock,
  type Message,
  type StopReason,
  type StreamEvent,
  type ThinkingConfig,
  type Tool,
  type ToolChoice,
  type ToolContext,
  type ToolExecutor,
  type ToolResultBlock,
  type ToolUseBlock,
  type Usage,
} from './types.js';
import type { ProviderHandle } from './registry.js';

export type RunWithToolsRequest = {
  readonly model?: string;
  readonly messages: readonly Message[];
  readonly system?: string;
  readonly tools: readonly Tool[];
  readonly toolChoice?: ToolChoice;
  readonly thinking?: ThinkingConfig;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxIterations?: number;
  /** 单工具执行超时（毫秒）；0 = 不超时 */
  readonly toolTimeoutMs?: number;
  /** 全局工具执行器，优先于 Tool.execute */
  readonly executeTool?: (
    name: string,
    input: unknown,
    ctx: ToolContext,
  ) => Promise<unknown>;
  readonly signal?: AbortSignal;

  /**
   * 流式模式：本轮与后续轮都走 handle.stream()，每个事件触发 onStreamEvent。
   * 不设置时用 handle.chat()，行为与之前一致。
   */
  readonly stream?: boolean;
  readonly onStreamEvent?: (event: StreamEvent) => void;
};

export type RunWithToolsResult = {
  readonly finalResponse: ChatResponse;
  readonly messages: readonly Message[];
  readonly iterations: number;
  readonly toolCalls: readonly {
    readonly name: string;
    readonly input: unknown;
    readonly output: unknown;
    readonly isError: boolean;
    readonly durationMs: number;
  }[];
};

const DEFAULT_MAX_ITERATIONS = 10;

/**
 * 把 AsyncIterable<StreamEvent> 累积为一个完整的 ChatResponse，
 * 同时把每个事件转发给 onEvent（可选）。
 *
 * 处理：
 *  - content_block_start → 用初始块建一个可写副本
 *  - text_delta / thinking_delta → 追加对应字段
 *  - input_json_delta → 累加，content_block_stop 时 JSON.parse 写回 tool_use.input
 *  - message_delta → 捕获 stopReason / usage
 *  - message_stop / 错误 / 流程终止条件
 *
 * 用户可消费 onEvent 做"实时刷出"的展示（本 helper 不感知具体渲染方式）。
 */
export async function streamToResponse(
  stream: AsyncIterable<StreamEvent>,
  onEvent?: (event: StreamEvent) => void,
): Promise<ChatResponse> {
  type MutableBlock =
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string; signature?: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | {
        type: 'tool_result';
        toolUseId: string;
        content: string | MutableBlock[];
        isError?: boolean;
      };

  const blocks = new Map<number, MutableBlock>();
  const partialInputs = new Map<number, string>();
  let stopReason: StopReason = 'unknown';
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let id = '';
  let model = '';

  for await (const ev of stream) {
    if (onEvent) onEvent(ev);

    switch (ev.type) {
      case 'message_start':
        id = ev.id;
        model = ev.model;
        break;

      case 'content_block_start': {
        const initial = ev.block;
        if (initial.type === 'text') {
          blocks.set(ev.index, { type: 'text', text: initial.text });
        } else if (initial.type === 'thinking') {
          blocks.set(ev.index, {
            type: 'thinking',
            thinking: initial.thinking,
            ...(initial.signature ? { signature: initial.signature } : {}),
          });
        } else if (initial.type === 'tool_use') {
          blocks.set(ev.index, {
            type: 'tool_use',
            id: initial.id,
            name: initial.name,
            input: initial.input,
          });
          partialInputs.set(ev.index, '');
        }
        break;
      }

      case 'content_block_delta': {
        const block = blocks.get(ev.index);
        if (!block) break;
        if (block.type === 'text' && ev.delta.type === 'text_delta') {
          block.text += ev.delta.text;
        } else if (block.type === 'thinking' && ev.delta.type === 'thinking_delta') {
          block.thinking += ev.delta.thinking;
        } else if (block.type === 'tool_use' && ev.delta.type === 'input_json_delta') {
          partialInputs.set(
            ev.index,
            (partialInputs.get(ev.index) ?? '') + ev.delta.partialJson,
          );
        }
        break;
      }

      case 'content_block_stop': {
        const block = blocks.get(ev.index);
        if (block?.type === 'tool_use' && partialInputs.has(ev.index)) {
          const raw = partialInputs.get(ev.index) ?? '';
          try {
            block.input = raw.trim() === '' ? {} : JSON.parse(raw);
          } catch {
            block.input = { _parseError: true, _raw: raw };
          }
        }
        break;
      }

      case 'message_delta':
        stopReason = ev.stopReason;
        if (ev.usage) usage = { ...usage, ...ev.usage };
        break;

      case 'message_stop':
        break;

      case 'error':
        throw ev.error;
    }
  }

  const sorted: ContentBlock[] = [];
  const maxIdx = blocks.size === 0 ? 0 : Math.max(...blocks.keys());
  for (let i = 0; i <= maxIdx; i++) {
    const b = blocks.get(i);
    if (b) sorted[i] = b as ContentBlock;
  }
  const finalBlocks = sorted.filter((b): b is ContentBlock => b !== undefined);

  return {
    id,
    message: { role: 'assistant', content: finalBlocks },
    stopReason,
    usage,
  };
}

function collectToolUses(message: Message): ToolUseBlock[] {
  const out: ToolUseBlock[] = [];
  for (const b of message.content) {
    if (b.type === 'tool_use') out.push(b);
  }
  return out;
}

async function executeSingleTool(
  tool: ToolUseBlock,
  req: RunWithToolsRequest,
): Promise<{ block: ToolResultBlock; record: RunWithToolsResult['toolCalls'][number] }> {
  const t0 = Date.now();
  const signals: AbortSignal[] = [];
  if (req.signal) signals.push(req.signal);
  if (req.toolTimeoutMs && req.toolTimeoutMs > 0) {
    signals.push(AbortSignal.timeout(req.toolTimeoutMs));
  }
  const ctx: ToolContext = {
    signal:
      signals.length === 0
        ? undefined
        : signals.length === 1
          ? signals[0]
          : AbortSignal.any(signals),
  };

  try {
    const output = await dispatchToolExecution(tool, req, ctx);
    return {
      block: { type: 'tool_result', toolUseId: tool.id, content: stringifyOutput(output) },
      record: {
        name: tool.name,
        input: tool.input,
        output,
        isError: false,
        durationMs: Date.now() - t0,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      block: {
        type: 'tool_result',
        toolUseId: tool.id,
        content: message,
        isError: true,
      },
      record: {
        name: tool.name,
        input: tool.input,
        output: message,
        isError: true,
        durationMs: Date.now() - t0,
      },
    };
  }
}

async function dispatchToolExecution(
  tool: ToolUseBlock,
  req: RunWithToolsRequest,
  ctx: ToolContext,
): Promise<unknown> {
  if (req.executeTool) {
    return req.executeTool(tool.name, tool.input, ctx);
  }
  const toolDef = req.tools.find((t) => t.name === tool.name);
  if (toolDef?.execute) {
    return toolDef.execute(tool.name, tool.input, ctx);
  }
  throw new Error(
    `Tool "${tool.name}" has no executor. Provide runWithTools({ executeTool }) or attach .execute to the Tool definition.`,
  );
}

function stringifyOutput(output: unknown): string {
  if (output === undefined) return '';
  if (output === null) return 'null';
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/**
 * 一轮 model 调用：stream 模式走 streamToResponse 累积，非 stream 模式直接 chat。
 */
async function callOnce(
  handle: ProviderHandle,
  req: RunWithToolsRequest,
  baseArgs: Parameters<ProviderHandle['chat']>[0],
): Promise<ChatResponse> {
  if (req.stream) {
    const stream = handle.stream(baseArgs);
    return streamToResponse(stream, req.onStreamEvent);
  }
  return handle.chat(baseArgs);
}

export async function runWithTools(
  handle: ProviderHandle,
  req: RunWithToolsRequest,
): Promise<RunWithToolsResult> {
  const model = req.model ?? handle.info.defaultModel;
  const maxIter = req.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const trajectory: Message[] = [...req.messages];
  type ToolCallRecord = RunWithToolsResult['toolCalls'][number];
  const toolCalls: ToolCallRecord[] = [];

  let last: ChatResponse | undefined;
  let iter = 0;

  for (iter = 0; iter < maxIter; iter++) {
    last = await callOnce(handle, req, {
      model,
      system: req.system,
      messages: trajectory,
      tools: req.tools,
      toolChoice: req.toolChoice,
      thinking: req.thinking,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      topP: req.topP,
      signal: req.signal,
    });

    const toolUses = collectToolUses(last.message);
    if (toolUses.length === 0) {
      trajectory.push(last.message);
      break;
    }

    trajectory.push(last.message);

    const results = await Promise.all(toolUses.map((tu) => executeSingleTool(tu, req)));
    const toolResultMessage: Message = {
      role: 'user',
      content: results.map((r) => r.block),
    };
    trajectory.push(toolResultMessage);
    for (const r of results) toolCalls.push(r.record);
  }

  if (!last) {
    throw new LLMError('unknown', 'runWithTools: empty loop', { provider: handle.info.name });
  }

  if (collectToolUses(last.message).length > 0) {
    throw new LLMError(
      'tool_loop_exceeded',
      `Tool loop exceeded maxIterations=${maxIter}. Model kept requesting tools.`,
      { provider: handle.info.name, raw: { iterations: iter, toolCalls } },
    );
  }

  return {
    finalResponse: last,
    messages: trajectory,
    iterations: iter + 1,
    toolCalls,
  };
}

export type { ToolExecutor };
