/**
 * conversation —— 有状态多轮对话。
 *
 * 用法：
 *   const convo = conversation(handle, {
 *     model: 'MiniMax-M3',
 *     thinking: { type: 'enabled' },
 *     tools: [...],
 *   });
 *   const r = await convo.send('北京今天天气怎么样？', {
 *     events: {
 *       onToolCall: (name, input) => console.log(name, input),
 *       onToolResult: (name, r, isErr, ms) => console.log(r, ms),
 *     },
 *   });
 */

import { runWithTools, type RunWithToolsRequest } from './run-with-tools.js';
import type { ProviderHandle } from './registry.js';
import type {
  ContentBlock,
  Message,
  StreamEvent,
  ThinkingConfig,
  Tool,
  ToolChoice,
  ToolContext,
} from './types.js';

export type ConversationOptions = {
  readonly model?: string;
  readonly system?: string;
  readonly thinking?: ThinkingConfig;
  readonly tools?: readonly Tool[];
  readonly toolChoice?: ToolChoice;
  readonly executeTool?: (
    name: string,
    input: unknown,
    ctx: ToolContext,
  ) => Promise<unknown>;
  readonly maxIterations?: number;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
};

/**
 * send() 期间触发的回调。
 *
 * 触发时机：
 *  - onToolCall       —— 工具即将执行（实时）
 *  - onToolResult     —— 工具执行完毕（实时；isError=true 表示抛错）
 *  - onAssistantBlock —— 模型本次响应结束后，按 trajectory 顺序遍历 assistant 的
 *                        ThinkingBlock / TextBlock 触发（同一轮可能多次）。
 *                        工具调用块不通过此触发（用 onToolCall 更早）。
 */
export type ConversationSendEvents = {
  readonly onToolCall?: (name: string, input: unknown) => void;
  readonly onToolResult?: (
    name: string,
    result: unknown,
    isError: boolean,
    durationMs: number,
  ) => void;
  readonly onAssistantBlock?: (block: ContentBlock) => void;
  /** 仅在 opts.stream = true 时触发，每个 content_block_delta 都收到。 */
  readonly onStreamEvent?: (event: StreamEvent) => void;
};

export type ConversationSendOptions = {
  readonly signal?: AbortSignal;
  readonly events?: ConversationSendEvents;
  readonly stream?: boolean;
};

export interface Conversation {
  readonly id: string;
  readonly handle: ProviderHandle;
  readonly options: Readonly<ConversationOptions>;
  readonly messages: readonly Message[];

  /**
   * 当前正在进行的 send 操作的 AbortSignal；空闲时为 undefined。
   * 调用方可监听此 signal 以在 abort 触发时做 UI 更新等副作用。
   */
  readonly signal: AbortSignal | undefined;

  send(
    input: string | readonly ContentBlock[],
    opts?: ConversationSendOptions,
  ): Promise<Message>;

  /**
   * 主动取消当前正在进行的 send（fetch 流 + 工具调用一并中断）。
   * 空闲时调用为 no-op。下一次 send 会创建新的 signal。
   * 取消行为通过 `LLMError('aborted')` 抛回给 send 的调用方。
   */
  abort(): void;

  reset(): void;
}

let conversationCounter = 0;

export function conversation(
  handle: ProviderHandle,
  options: ConversationOptions = {},
): Conversation {
  const id = `conv_${Date.now().toString(36)}_${(++conversationCounter).toString(36)}`;
  let messages: Message[] = [];
  let currentController: AbortController | undefined;

  function buildRunOpts(signal?: AbortSignal): Omit<RunWithToolsRequest, 'messages' | 'executeTool'> {
    return {
      model: options.model ?? handle.info.defaultModel,
      ...(options.system !== undefined ? { system: options.system } : {}),
      ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
      ...(options.toolChoice !== undefined ? { toolChoice: options.toolChoice } : {}),
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.topP !== undefined ? { topP: options.topP } : {}),
      tools: options.tools ?? [],
      ...(signal ? { signal } : {}),
    };
  }

  function findLastAssistant(msgs: readonly Message[]): Message | undefined {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === 'assistant') return msgs[i];
    }
    return undefined;
  }

  async function dispatchTool(
    name: string,
    input: unknown,
    ctx: ToolContext,
    events: ConversationSendEvents | undefined,
  ): Promise<unknown> {
    events?.onToolCall?.(name, input);
    const t0 = Date.now();
    try {
      let result: unknown;
      if (options.executeTool) {
        result = await options.executeTool(name, input, ctx);
      } else {
        const toolDef = options.tools?.find((t) => t.name === name);
        if (!toolDef?.execute) {
          throw new Error(`Tool "${name}" has no executor`);
        }
        result = await toolDef.execute(name, input, ctx);
      }
      events?.onToolResult?.(name, result, false, Date.now() - t0);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      events?.onToolResult?.(name, message, true, Date.now() - t0);
      throw err;
    }
  }

  return {
    id,
    handle,
    options: Object.freeze({ ...options }),
    get messages() {
      return messages;
    },
    get signal() {
      return currentController?.signal;
    },
    abort() {
      currentController?.abort();
    },

    async send(input, opts) {
      const events = opts?.events;
      const userContent =
        typeof input === 'string'
          ? [{ type: 'text' as const, text: input }]
          : input;

      const initialMessages: Message[] = [
        ...messages,
        { role: 'user', content: userContent },
      ];

      const controller = new AbortController();
      currentController = controller;
      const combinedSignal =
        opts?.signal !== undefined
          ? AbortSignal.any([controller.signal, opts.signal])
          : controller.signal;
      try {
        const result = await runWithTools(handle, {
          ...buildRunOpts(combinedSignal),
          messages: initialMessages,
          executeTool: async (name, input, ctx) => dispatchTool(name, input, ctx, events),
          stream: opts?.stream === true,
          onStreamEvent: events?.onStreamEvent,
        });

        const newMsgs = result.messages.slice(messages.length);
        if (events?.onAssistantBlock) {
          for (const m of newMsgs) {
            if (m.role !== 'assistant') continue;
            for (const b of m.content) {
              if (b.type === 'thinking' || b.type === 'text') {
                events.onAssistantBlock(b);
              }
            }
          }
        }

        messages = [...result.messages];
        const lastAssistant = findLastAssistant(messages);
        if (!lastAssistant) {
          throw new Error(`[conversation:${id}] No assistant message produced`);
        }
        return lastAssistant;
      } finally {
        if (currentController === controller) currentController = undefined;
      }
    },

    reset() {
      messages = [];
    },
  };
}
