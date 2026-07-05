import type {
  ChatRequest,
  ChatResponse,
  ContentBlock,
  Message,
  StopReason,
  TextBlock,
  ThinkingConfig,
  Usage,
} from '../../types.js';

export type OpenAIRequest = {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  /**
   * Ollama OpenAI 兼容端点的思考控制。'none' 关闭思考型模型的思维链；
   * 非思考模型忽略此字段。选 'reasoning_effort' 而非 `reasoning` 嵌套 / `think`
   * 布尔，是因为它是 Ollama 官方 OpenAI 兼容矩阵中点名支持的形态。
   */
  reasoning_effort?: 'high' | 'medium' | 'low' | 'max' | 'none';
};

export type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export type OpenAIToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type OpenAITool = {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
};

export type OpenAIToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export type OpenAIResponse = {
  id: string;
  object: 'chat.completion';
  created?: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      reasoning?: string;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type OpenAIStreamChunk = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type OpenAIModelsList = {
  object?: string;
  data: Array<{
    id: string;
    object?: string;
    created?: number;
    owned_by?: string;
  }>;
};

// ===========================================================================
// 请求翻译
// ===========================================================================

export function toOpenAIRequest(req: ChatRequest): OpenAIRequest {
  const messages: OpenAIMessage[] = [];
  if (req.system) {
    messages.push({ role: 'system', content: req.system });
  }
  for (const msg of req.messages) {
    messages.push(...flattenMessage(msg));
  }

  const tools: OpenAITool[] | undefined = req.tools?.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  let tool_choice: OpenAIToolChoice | undefined;
  if (req.toolChoice) {
    if (req.toolChoice.type === 'auto') tool_choice = 'auto';
    else if (req.toolChoice.type === 'none') tool_choice = 'none';
    else if (req.toolChoice.type === 'any') tool_choice = 'required';
    else if (req.toolChoice.type === 'tool') {
      tool_choice = { type: 'function', function: { name: req.toolChoice.name } };
    }
  }

  const body: OpenAIRequest = {
    model: req.model,
    messages,
    stream: false,
  };
  if (tools && tools.length > 0) body.tools = tools;
  if (tool_choice !== undefined) body.tool_choice = tool_choice;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.thinking) body.reasoning_effort = toOpenAIReasoningEffort(req.thinking);

  return body;
}

function toOpenAIReasoningEffort(c: ThinkingConfig): NonNullable<OpenAIRequest['reasoning_effort']> {
  // 思考型模型（DeepSeek R1 / Qwen3）默认开启思维链，必须显式 'none' 才能关。
  return c.type === 'enabled' ? 'medium' : 'none';
}

function flattenMessage(msg: Message): OpenAIMessage[] {
  if (msg.role === 'user') {
    const out: OpenAIMessage[] = [];
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: block.toolUseId,
          content: stringifyContent(block.content),
        });
      }
    }
    const texts = msg.content.filter((b): b is TextBlock => b.type === 'text');
    if (texts.length > 0) {
      out.push({ role: 'user', content: texts.map((t) => t.text).join('\n') });
    }
    return out;
  }

  const texts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  for (const block of msg.content) {
    if (block.type === 'text') {
      texts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    }
  }

  const assistant: OpenAIMessage = {
    role: 'assistant',
    content:
      texts.length > 0
        ? texts.join('\n')
        : toolCalls.length > 0
          ? null
          : '',
  };
  if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
  return [assistant];
}

function stringifyContent(content: string | readonly ContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const b of content) {
    if (b.type === 'text') parts.push(b.text);
  }
  return parts.join('\n');
}

// ===========================================================================
// 响应翻译（非流式）
// ===========================================================================

export function fromOpenAIResponse(raw: OpenAIResponse): ChatResponse {
  const choice = raw.choices[0];
  if (!choice) {
    throw new Error('Ollama response had no choices');
  }

  const blocks: ContentBlock[] = [];
  if (choice.message.reasoning) {
    blocks.push({ type: 'thinking', thinking: choice.message.reasoning });
  }
  if (choice.message.content) {
    blocks.push({ type: 'text', text: choice.message.content });
  }
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: unknown;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = { _parseError: true, _raw: tc.function.arguments };
      }
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  const usage: Usage = raw.usage
    ? { inputTokens: raw.usage.prompt_tokens, outputTokens: raw.usage.completion_tokens }
    : { inputTokens: 0, outputTokens: 0 };

  return {
    id: raw.id,
    message: { role: 'assistant', content: blocks },
    stopReason: mapOpenAIStopReason(choice.finish_reason),
    usage,
  };
}

export function mapOpenAIStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'stop_sequence';
    case 'function_call':
      return 'tool_use';
    default:
      return 'unknown';
  }
}

// ===========================================================================
// 模型列表响应翻译
// ===========================================================================

export function fromOpenAIModelsList(raw: OpenAIModelsList): Array<{
  id: string;
  createdAt?: string;
}> {
  return raw.data
    .filter((m): m is { id: string; created?: number; owned_by?: string } =>
      typeof m.id === 'string',
    )
    .map((m) => {
      const out: { id: string; createdAt?: string } = { id: m.id };
      if (typeof m.created === 'number') {
        out.createdAt = new Date(m.created * 1000).toISOString();
      }
      return out;
    });
}
