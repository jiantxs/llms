/**
 * Provider 注册表 —— 整个 lib 的"发现层"。
 *
 *   listProviders()              → 发现当前支持的所有 Provider
 *   createProvider(id, config)  → 按 id 拿到"对话所需一切"的对象
 *   handle.listModels()          → 动态拉取该 Provider 当前可用的模型列表
 */

import {
  LLMError,
  type ChatRequest,
  type ChatResponse,
  type ModelInfo,
  type StreamEvent,
} from './types.js';

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

export type ProviderFeatures = {
  readonly thinking: boolean;
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly multimodal: boolean;
};

export type ProviderInfo = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** 静态模型列表 fallback —— 支持动态获取的 Provider 可设为 []。 */
  readonly models: readonly string[];
  /** Provider 推荐的默认模型（可与 models 列表中第一个不同）。 */
  readonly defaultModel: string;
  readonly features: ProviderFeatures;
  /** 该 Provider 是否实现了动态模型列表（listModels）。 */
  readonly dynamicModels: boolean;
};

export type ProviderInstance = {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<StreamEvent>;
};

export type ListModelsOptions = {
  /** 跳过缓存重新拉取 */
  readonly refresh?: boolean;
  readonly signal?: AbortSignal;
};

/**
 * 调用方拿到的"对话所需一切"。
 */
export type ProviderHandle = {
  readonly id: string;
  readonly info: ProviderInfo;
  readonly chat: (request: ChatRequest) => Promise<ChatResponse>;
  readonly stream: (request: ChatRequest) => AsyncIterable<StreamEvent>;
  /** 动态拉取模型列表。Provider 未实现时抛 LLMError(invalid_request)。 */
  readonly listModels: (opts?: ListModelsOptions) => Promise<readonly ModelInfo[]>;
};

/**
 * Provider 自描述 + 工厂。
 */
export type ProviderModule = ProviderInfo & {
  readonly factory: (config: unknown) => ProviderInstance;
  /** 可选：动态拉取模型列表（不实现则 dynamicModels = false）。 */
  readonly listModels?: (
    config: unknown,
    ctx: { readonly signal?: AbortSignal },
  ) => Promise<readonly ModelInfo[]>;
};

/**
 * Provider id → Config 类型映射。各 Provider 通过 declaration merging 扩展。
 */
export interface ProviderConfigMap {
  // 由各 Provider 在自己的 index.ts 里 extend
}

// ---------------------------------------------------------------------------
// 注册表实现
// ---------------------------------------------------------------------------

const REGISTRY = new Map<string, ProviderModule>();

/** 模型列表缓存 TTL（5 分钟） */
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

export function registerProvider(mod: ProviderModule): void {
  if (REGISTRY.has(mod.id)) {
    throw new Error(`[llms] Provider "${mod.id}" is already registered`);
  }
  REGISTRY.set(mod.id, mod);
}

export function listProviders(): ProviderInfo[] {
  return Array.from(REGISTRY.values()).map(stripFactory);
}

export function createProvider<TId extends keyof ProviderConfigMap>(
  id: TId,
  config: ProviderConfigMap[TId],
): ProviderHandle;
export function createProvider(id: string, config: unknown): ProviderHandle;
export function createProvider(id: string, config: unknown): ProviderHandle {
  const mod = REGISTRY.get(id);
  if (!mod) {
    const known = Array.from(REGISTRY.keys()).join(', ');
    throw new Error(
      `[llms] Unknown provider "${id}". Registered: ${known.length > 0 ? known : '(none)'}`,
    );
  }
  const instance = mod.factory(config);

  // 模型列表缓存（每个 handle 一份，独立 TTL）
  let cache: { models: readonly ModelInfo[]; ts: number } | null = null;

  return {
    id,
    info: stripFactory(mod),
    chat: (req) => instance.chat(req),
    stream: (req) => instance.stream(req),
    async listModels(opts) {
      if (!mod.listModels) {
        throw new LLMError(
          'invalid_request',
          `Provider "${id}" does not support dynamic model listing`,
          { provider: id },
        );
      }
      const now = Date.now();
      if (!opts?.refresh && cache && now - cache.ts < MODEL_CACHE_TTL_MS) {
        return cache.models;
      }
      const models = await mod.listModels(config, {
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      cache = { models, ts: now };
      return models;
    },
  };
}

export function hasProvider(id: string): boolean {
  return REGISTRY.has(id);
}

export function getProvider(id: string): ProviderInfo | undefined {
  const mod = REGISTRY.get(id);
  return mod ? stripFactory(mod) : undefined;
}

export function getProviderModels(id: string): readonly string[] {
  return REGISTRY.get(id)?.models ?? [];
}

export function getProviderDefaultModel(id: string): string | undefined {
  return REGISTRY.get(id)?.defaultModel;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function stripFactory(mod: ProviderModule): ProviderInfo {
  // 仅保留 ProviderInfo 字段；剥离 factory 与 listModels
  const { factory: _f, listModels: _l, ...info } = mod;
  void _f;
  void _l;
  return info;
}

export function __resetRegistryForTests(): void {
  REGISTRY.clear();
}
