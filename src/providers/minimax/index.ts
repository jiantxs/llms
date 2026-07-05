/**
 * MiniMax Provider 模块 —— 自注册到全局 registry。
 * 模型列表通过 handle.listModels() 动态从 /v1/models 拉取。
 */

import { doFetch } from '../base.js';
import { registerProvider, type ProviderModule } from '../../registry.js';
import { LLMError, type ModelInfo } from '../../types.js';
import {
  DEFAULT_MINIMAX_BASE_URL,
  MINIMAX_MODELS_PATH,
  resolveMiniMaxConfig,
  type MiniMaxConfig,
} from './config.js';
import { MINIMAX_CONTEXT_LENGTHS } from './context.js';
import { buildHeaders } from './headers.js';
import { minimaxChat } from './chat.js';
import { minimaxStream } from './stream.js';

const MiniMaxModule: ProviderModule = {
  id: 'minimax',
  name: 'MiniMax',
  description: 'MiniMax M-series language models via Anthropic-compatible endpoint',
  models: [],
  defaultModel: 'MiniMax-M3',
  features: {
    thinking: true,
    tools: true,
    streaming: true,
    multimodal: true,
  },
  dynamicModels: true,
  contextTable: MINIMAX_CONTEXT_LENGTHS,

  async listModels(rawConfig, ctx) {
    const config = resolveMiniMaxConfig(rawConfig as MiniMaxConfig);
    const res = await doFetch(
      `${config.baseUrl}${MINIMAX_MODELS_PATH}`,
      {
        method: 'GET',
        headers: buildHeaders(config),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
      {
        provider: 'MiniMax',
        fetchImpl: config.fetch,
        timeoutMs: config.timeoutMs,
      },
    );

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new LLMError('parse', 'Failed to parse MiniMax /v1/models response', {
        provider: 'MiniMax',
        cause: err,
      });
    }

    if (!json || typeof json !== 'object' || !Array.isArray((json as { data?: unknown }).data)) {
      throw new LLMError('parse', 'MiniMax /v1/models returned unexpected shape', {
        provider: 'MiniMax',
        raw: json,
      });
    }

    const items = (json as { data: Array<{ id?: string; display_name?: string; created_at?: string }> }).data;
    return items
      .filter((m): m is { id: string; display_name?: string; created_at?: string } => typeof m.id === 'string')
      .map<ModelInfo>((m) => ({
        id: m.id,
        ...(m.display_name !== undefined ? { displayName: m.display_name } : {}),
        ...(m.created_at !== undefined ? { createdAt: m.created_at } : {}),
      }));
  },

  factory(rawConfig) {
    const config = resolveMiniMaxConfig(rawConfig as MiniMaxConfig);
    return {
      name: 'MiniMax',
      chat: (req) => minimaxChat(config, req),
      stream: (req) => minimaxStream(config, req),
    };
  },
};

registerProvider(MiniMaxModule);

declare module '../../registry.js' {
  interface ProviderConfigMap {
    minimax: MiniMaxConfig;
  }
}

export { DEFAULT_MINIMAX_BASE_URL };
