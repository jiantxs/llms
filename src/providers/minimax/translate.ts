/**
 * MiniMax ↔ 统一类型 翻译层。
 *
 * MiniMax 使用 Anthropic 兼容 Messages API（/v1/messages）。
 * 翻译策略：字段重命名 + 内容块结构对齐 + JSON Schema 透传。
 */

import type {
  ChatRequest,
  ChatResponse,
  ContentBlock,
  ContentDelta,
  Message,
  StopReason,
  StreamEvent,
  ThinkingConfig,
  ToolChoice,
  ToolResultBlock,
  Usage,
} from '../../types.js';
import { LLMError } from '../../types.js';

// ===========================================================================
// 请求翻译：统一 ChatRequest → MiniMax 请求体
// ===========================================================================

/** MiniMax / Anthropic 兼容请求体（仅声明我们关心的字段） */
export type MiniMaxRequest = {
  model: string;
  max_tokens: number;
  system?: string;
  messages: MiniMaxMessage[];
  tools?: MiniMaxTool[];
  tool_choice?: MiniMaxToolChoice;
  thinking?: { type: 'adaptive' | 'enabled' | 'disabled' };
  temperature?: number;
  top_p?: number;
  metadata?: Record<string, unknown>;
  stream?: boolean;
};

type MiniMaxMessage = {
  role: 'user' | 'assistant';
  content: MiniMaxContentBlock[] | string;
};

type MiniMaxContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | MiniMaxContentBlock[]; is_error?: boolean };

type MiniMaxTool = {
  name: string;
  description: string;
  input_schema: unknown;
};

type MiniMaxToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

/** 默认 max_tokens —— MiniMax / Anthropic 必填 */
const DEFAULT_MAX_TOKENS = 4096;

export function toMiniMaxRequest(req: ChatRequest): Omit<MiniMaxRequest, 'stream'> {
  // 1. 翻译 messages
  const messages: MiniMaxMessage[] = req.messages.map(toMiniMaxMessage);

  // 2. 翻译 tools
  const tools: MiniMaxTool[] | undefined = req.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  // 3. 翻译 tool_choice
  const toolChoice: MiniMaxToolChoice | undefined = req.toolChoice
    ? toMiniMaxToolChoice(req.toolChoice)
    : undefined;

  // 4. 翻译 thinking
  const thinking: MiniMaxRequest['thinking'] | undefined = req.thinking
    ? { type: toMiniMaxThinkingType(req.thinking) }
    : undefined;

  const body: Omit<MiniMaxRequest, 'stream'> = {
    model: req.model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };

  if (req.system !== undefined) body.system = req.system;
  if (tools) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;
  if (thinking) body.thinking = thinking;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.metadata) body.metadata = { ...req.metadata };

  return body;
}

function toMiniMaxMessage(msg: Message): MiniMaxMessage {
  return {
    role: msg.role,
    content: msg.content.map(toMiniMaxContentBlock),
  };
}

function toMiniMaxContentBlock(block: ContentBlock): MiniMaxContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      // 多轮对话必须保留 signature 以维持思维链
      return {
        type: 'thinking',
        thinking: block.thinking,
        ...(block.signature !== undefined ? { signature: block.signature } : {}),
      };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case 'tool_result':
      return toMiniMaxToolResult(block);
  }
}

function toMiniMaxToolResult(block: ToolResultBlock): MiniMaxContentBlock {
  if (typeof block.content === 'string') {
    return {
      type: 'tool_result',
      tool_use_id: block.toolUseId,
      content: block.content,
      ...(block.isError !== undefined ? { is_error: block.isError } : {}),
    };
  }
  // 富内容（递归翻译）
  return {
    type: 'tool_result',
    tool_use_id: block.toolUseId,
    content: block.content.map(toMiniMaxContentBlock),
    ...(block.isError !== undefined ? { is_error: block.isError } : {}),
  };
}

function toMiniMaxToolChoice(choice: ToolChoice): MiniMaxToolChoice {
  switch (choice.type) {
    case 'auto':
      return { type: 'auto' };
    case 'any':
      return { type: 'any' };
    case 'none':
      // Anthropic 没有 "none"；用空 tools 数组表达。当前实现：跳过。
      // 调用方应该直接不传 tools，而不是传 toolChoice: { type: 'none' }
      return { type: 'auto' };
    case 'tool':
      return { type: 'tool', name: choice.name };
  }
}

function toMiniMaxThinkingType(c: ThinkingConfig): 'adaptive' | 'enabled' | 'disabled' {
  // MiniMax 文档：adaptive 等同于开启（用于 MiniMax-M3）
  // 统一 API 把 "enabled" 映射到 "adaptive"，保留 disabled 直传
  return c.type === 'enabled' ? 'adaptive' : 'disabled';
}

// ===========================================================================
// 响应翻译：MiniMax 响应 → 统一 ChatResponse
// ===========================================================================

/** MiniMax / Anthropic 兼容响应（仅声明我们关心的字段） */
export type MiniMaxResponse = {
  id: string;
  type: 'message';
  role: 'assistant';
  content: MiniMaxContentBlock[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

export function fromMiniMaxResponse(raw: MiniMaxResponse): ChatResponse {
  const blocks = raw.content.map(fromMiniMaxContentBlock);
  return {
    id: raw.id,
    message: { role: 'assistant', content: blocks },
    stopReason: mapStopReason(raw.stop_reason),
    usage: mapUsage(raw.usage),
  };
}

function mapStopReason(s: string | null): StopReason {
  switch (s) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      return 'unknown';
  }
}

function mapUsage(u: MiniMaxResponse['usage']): Usage {
  const usage: Usage = {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
  };
  if (u.cache_read_input_tokens !== undefined) {
    return { ...usage, cacheReadTokens: u.cache_read_input_tokens };
  }
  if (u.cache_creation_input_tokens !== undefined) {
    return { ...usage, cacheWriteTokens: u.cache_creation_input_tokens };
  }
  return usage;
}

function fromMiniMaxContentBlock(raw: MiniMaxContentBlock): ContentBlock {
  switch (raw.type) {
    case 'text':
      return { type: 'text', text: raw.text };
    case 'thinking':
      return {
        type: 'thinking',
        thinking: raw.thinking,
        ...(raw.signature !== undefined ? { signature: raw.signature } : {}),
      };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: raw.id,
        name: raw.name,
        input: raw.input,
      };
    case 'tool_result':
      // 响应里一般不会出现 tool_result（那是用户消息），防御性处理
      return {
        type: 'tool_result',
        toolUseId: raw.tool_use_id,
        content:
          typeof raw.content === 'string'
            ? raw.content
            : raw.content.map(fromMiniMaxContentBlock),
        ...(raw.is_error !== undefined ? { isError: raw.is_error } : {}),
      };
  }
}

// ===========================================================================
// 流式事件翻译：MiniMax SSE → 统一 StreamEvent
// ===========================================================================

/** MiniMax SSE content_block_start 的 content_block 字段 */
export type MiniMaxContentBlockStart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export type MiniMaxStreamEvent =
  | { type: 'message_start'; message: { id: string; model: string } }
  | { type: 'content_block_start'; index: number; content_block: MiniMaxContentBlockStart }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: 'signature_delta'; signature: string };
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason: string | null };
      usage?: { output_tokens: number };
    }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } };

/**
 * 把 MiniMax 流式事件翻译为统一 StreamEvent。
 * 关键：tool_use 的 input 是分段 JSON，需要在 content_block_stop 时合并 + 解析。
 */
export function fromMiniMaxStreamEvent(raw: MiniMaxStreamEvent): StreamEvent | null {
  switch (raw.type) {
    case 'message_start':
      return {
        type: 'message_start',
        id: raw.message.id,
        model: raw.message.model,
      };

    case 'content_block_start': {
      const block = fromMiniMaxContentBlockStart(raw.content_block);
      if (!block) return null;
      return { type: 'content_block_start', index: raw.index, block };
    }

    case 'content_block_delta': {
      const delta = fromMiniMaxDelta(raw.delta);
      if (!delta) return null;
      return { type: 'content_block_delta', index: raw.index, delta };
    }

    case 'content_block_stop':
      return { type: 'content_block_stop', index: raw.index };

    case 'message_delta':
      return {
        type: 'message_delta',
        stopReason: mapStopReason(raw.delta.stop_reason),
        ...(raw.usage ? { usage: { inputTokens: 0, outputTokens: raw.usage.output_tokens } } : {}),
      };

    case 'message_stop':
      return { type: 'message_stop' };

    case 'ping':
      // 心跳不暴露
      return null;

    case 'error':
      return {
        type: 'error',
        error: new LLMError('server', raw.error.message ?? 'Unknown stream error', {
          provider: 'MiniMax',
          raw: raw.error,
        }),
      };
  }
}

function fromMiniMaxContentBlockStart(raw: MiniMaxContentBlockStart): ContentBlock | null {
  switch (raw.type) {
    case 'text':
      return { type: 'text', text: '' }; // 启动时 text 通常为空
    case 'thinking':
      return { type: 'thinking', thinking: '' };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: raw.id,
        name: raw.name,
        input: {}, // 流式 input 后续由 input_json_delta 累计
      };
  }
}

function fromMiniMaxDelta(
  raw:
    | { type: 'text_delta'; text: string }
    | { type: 'thinking_delta'; thinking: string }
    | { type: 'input_json_delta'; partial_json: string }
    | { type: 'signature_delta'; signature: string },
): ContentDelta | null {
  switch (raw.type) {
    case 'text_delta':
      return { type: 'text_delta', text: raw.text };
    case 'thinking_delta':
      return { type: 'thinking_delta', thinking: raw.thinking };
    case 'input_json_delta':
      return { type: 'input_json_delta', partialJson: raw.partial_json };
    case 'signature_delta':
      return null;
  }
}