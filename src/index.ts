/**
 * llms —— 统一 LLM 抽象层。
 *
 * 入口示例：
 *
 * ```ts
 * import { listProviders, createProvider } from 'llms';
 *
 * // 1. 发现当前支持的所有 Provider
 * const providers = listProviders();
 *
 * // 2. 选一个 id 创建实例
 * const { chat, stream, info, id } = createProvider('minimax', { apiKey: 'YOUR_KEY' });
 *
 * // 3. 对话
 * const r = await chat({
 *   model: info.defaultModel,
 *   messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
 *   thinking: { type: 'enabled' },
 * });
 * ```
 */

import './providers/index.js';

export type {
  ChatRequest,
  ChatResponse,
  Message,
  ContentBlock,
  ContentDelta,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  Tool,
  ToolChoice,
  ThinkingConfig,
  ToolContext,
  ToolExecutor,
  JsonSchema,
  Usage,
  StopReason,
  StreamEvent,
  LLMErrorCode,
  Role,
  ModelInfo,
} from './types.js';

export { LLMError } from './types.js';

export {
  listProviders,
  createProvider,
  hasProvider,
  getProvider,
  getProviderModels,
  getProviderDefaultModel,
  registerProvider,
  type ProviderModule,
  type ProviderInfo,
  type ProviderHandle,
  type ProviderInstance,
  type ProviderFeatures,
  type ProviderConfigMap,
  type ListModelsOptions,
} from './registry.js';

export { runWithTools, streamToResponse, type RunWithToolsRequest, type RunWithToolsResult } from './run-with-tools.js';

export {
  conversation,
  type Conversation,
  type ConversationOptions,
  type ConversationSendOptions,
  type ConversationSendEvents,
} from './conversation.js';

export {
  doFetch,
  parseSSE,
  type RawSSEEvent,
  type ProviderFetch,
  type ProviderConfigBase,
} from './providers/base.js';