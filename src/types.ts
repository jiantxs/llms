/**
 * 统一领域类型 —— 所有 Provider 适配器的"内部通用语言"。
 *
 * 设计原则：
 * 1. 不暴露任何 Provider 协议（Anthropic / OpenAI / ...）特有的字段
 * 2. 内容用块数组（ContentBlock）而非字符串，天然支持多模态 / 工具 / 思考
 * 3. 工具的 input 统一为 unknown，由 Schema 校验在各 Provider 处处理
 * 4. 错误、停止原因等枚举统一收敛，避免调用方写 switch(protocol)
 */

// ---------------------------------------------------------------------------
// 内容块（Content Blocks）
// ---------------------------------------------------------------------------

/** 纯文本块 */
export type TextBlock = {
  readonly type: 'text';
  readonly text: string;
};

/**
 * 思考块 —— 模型的内部推理。
 * signature 由 Provider 生成，多轮工具调用时必须原样回传以保持思维链连续性。
 * （MiniMax / Anthropic 协议要求；OpenAI 兼容路径下 signature 可能为空。）
 */
export type ThinkingBlock = {
  readonly type: 'thinking';
  readonly thinking: string;
  readonly signature?: string;
};

/** 工具调用块 —— 模型"决定"调用哪个工具 */
export type ToolUseBlock = {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
};

/** 工具结果块 —— 用户侧执行完工具后回传给模型 */
export type ToolResultBlock = {
  readonly type: 'tool_result';
  readonly toolUseId: string;
  /** 字符串或递归内容块（部分 Provider 支持富内容） */
  readonly content: string | readonly ContentBlock[];
  readonly isError?: boolean;
};

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

// ---------------------------------------------------------------------------
// 消息（Messages）
// ---------------------------------------------------------------------------

export type Role = 'user' | 'assistant';

export type Message = {
  readonly role: Role;
  readonly content: readonly ContentBlock[];
};

// ---------------------------------------------------------------------------
// 模型（Models）
// ---------------------------------------------------------------------------

export type ModelInfo = {
  readonly id: string;
  readonly displayName?: string;
  readonly createdAt?: string;
};

// ---------------------------------------------------------------------------
// 工具（Tools）
// ---------------------------------------------------------------------------

/**
 * JSON Schema 子集 —— 所有 Provider 都接受的工具输入定义。
 * 不引入 Zod 依赖，保持核心包零运行时依赖。
 */
export type JsonSchema = {
  readonly type: 'object';
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly [key: string]: unknown;
};

export type ToolContext = {
  readonly signal?: AbortSignal;
};

/** 抛错会被 runWithTools 捕获并以 isError: true 写回 tool_result。 */
export type ToolExecutor = (
  name: string,
  input: unknown,
  ctx: ToolContext,
) => Promise<unknown>;

export type Tool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly execute?: ToolExecutor;
};

/** 工具选择策略 */
export type ToolChoice =
  | { readonly type: 'auto' }
  | { readonly type: 'any' }
  | { readonly type: 'none' }
  | { readonly type: 'tool'; readonly name: string };

// ---------------------------------------------------------------------------
// 思考（Thinking）
// ---------------------------------------------------------------------------

export type ThinkingConfig =
  | { readonly type: 'enabled' }
  | { readonly type: 'disabled' };

// ---------------------------------------------------------------------------
// 请求 / 响应（Request / Response）
// ---------------------------------------------------------------------------

export type ChatRequest = {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly system?: string;
  readonly tools?: readonly Tool[];
  readonly toolChoice?: ToolChoice;
  readonly thinking?: ThinkingConfig;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  /** 中断信号 —— 用户取消或超时 */
  readonly signal?: AbortSignal;
  /** Provider 透传字段（高级用法） */
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type StopReason =
  | 'end_turn' // 自然结束
  | 'tool_use' // 模型决定调用工具
  | 'max_tokens' // 触达 maxTokens 上限
  | 'stop_sequence' // 命中停止序列
  | 'unknown';

export type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 缓存命中的输入 token 数（Anthropic/MiniMax 支持；OpenAI 兼容路径为 0） */
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
};

export type ChatResponse = {
  /** 完整 assistant 消息（含 thinking / text / tool_use 块） */
  readonly message: Message;
  readonly stopReason: StopReason;
  readonly usage: Usage;
  /** 原始 Provider 响应 ID，便于日志排查 */
  readonly id: string;
};

// ---------------------------------------------------------------------------
// 流式事件（Stream Events）
// ---------------------------------------------------------------------------

/** 内容块增量 —— 文本 / 思考 / 工具输入 JSON */
export type ContentDelta =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'thinking_delta'; readonly thinking: string }
  | { readonly type: 'input_json_delta'; readonly partialJson: string };

/** 内容块边界 —— 启动 / 结束 */
export type ContentBlockStart = {
  readonly type: 'content_block_start';
  readonly index: number;
  readonly block: ContentBlock;
};

export type ContentBlockDeltaEvent = {
  readonly type: 'content_block_delta';
  readonly index: number;
  readonly delta: ContentDelta;
};

export type ContentBlockStop = {
  readonly type: 'content_block_stop';
  readonly index: number;
};

export type StreamEvent =
  | { readonly type: 'message_start'; readonly id: string; readonly model: string }
  | ContentBlockStart
  | ContentBlockDeltaEvent
  | ContentBlockStop
  | {
      readonly type: 'message_delta';
      readonly stopReason: StopReason;
      readonly usage?: Usage;
    }
  | { readonly type: 'message_stop' }
  | { readonly type: 'error'; readonly error: LLMError };

// ---------------------------------------------------------------------------
// 错误（Errors）
// ---------------------------------------------------------------------------

export type LLMErrorCode =
  | 'authentication' // 401 / 403
  | 'rate_limit' // 429
  | 'context_length' // 输入超长
  | 'invalid_request' // 400 / 参数错
  | 'tool_loop_exceeded' // runWithTools 超过 maxIterations
  | 'server' // 5xx
  | 'network' // fetch 失败（非中断类）
  | 'aborted' // 用户主动取消 / signal.abort() / 超时（AbortController 触发）
  | 'parse' // SSE / JSON 解析失败
  | 'unknown';

export class LLMError extends Error {
  readonly code: LLMErrorCode;
  readonly status?: number;
  readonly provider?: string;
  /** Provider 原始错误体（便于排查） */
  readonly raw?: unknown;
  /** 是否由 AbortSignal 触发（用户取消 / 超时）。为 true 时 code === 'aborted'。 */
  readonly aborted?: boolean;
  /** 触发 abort 的原因（timeout / user / ...） */
  readonly abortReason?: 'timeout' | 'user';

  constructor(
    code: LLMErrorCode,
    message: string,
    options: {
      status?: number;
      provider?: string;
      raw?: unknown;
      cause?: unknown;
      aborted?: boolean;
      abortReason?: 'timeout' | 'user';
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'LLMError';
    this.code = code;
    this.status = options.status;
    this.provider = options.provider;
    this.raw = options.raw;
    this.aborted = options.aborted;
    this.abortReason = options.abortReason;
  }
}