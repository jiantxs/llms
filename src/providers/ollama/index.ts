/**
 * Ollama Provider —— 本地 Ollama 服务，通过 OpenAI 兼容端点 (/v1/chat/completions)
 * 默认指向 http://localhost:11434/v1
 *
 * 思考支持：依赖 Ollama 端 `reasoning_effort` 字段 + `message.reasoning` / 流式
 * `delta.reasoning` 字段。适用于 DeepSeek R1 / Qwen3 / GPT-OSS 等思考型模型；
 * 非思考型模型忽略 reasoning_effort，原行为不变。
 */

import { doFetch } from '../base.js';
import { registerProvider, type ProviderModule } from '../../registry.js';
import { LLMError, type ModelInfo } from '../../types.js';
import {
  DEFAULT_OLLAMA_BASE_URL,
  OLLAMA_MODELS_PATH,
  resolveOllamaConfig,
  type OllamaConfig,
} from './config.js';
import { ollamaChat } from './chat.js';
import { ollamaStream } from './stream.js';
import { buildHeaders } from './chat.js';
import { fromOpenAIModelsList } from './translate.js';

const OllamaModule: ProviderModule = {
  id: 'ollama',
  name: 'Ollama',
  description: 'Local Ollama server via OpenAI-compatible endpoint',
  models: [], // 动态从 /v1/models 拉
  defaultModel: '', // 由 listModels 第一个填充
  features: {
    thinking: true,
    tools: true,
    streaming: true,
    multimodal: false,
  },
  dynamicModels: true,

  async listModels(rawConfig, ctx) {
    const config = resolveOllamaConfig(rawConfig as OllamaConfig);
    const res = await doFetch(
      `${config.baseUrl}${OLLAMA_MODELS_PATH}`,
      {
        method: 'GET',
        headers: buildHeaders(config),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
      {
        provider: 'Ollama',
        fetchImpl: config.fetch,
        timeoutMs: config.timeoutMs,
      },
    );

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new LLMError('parse', 'Failed to parse Ollama /v1/models response', {
        provider: 'Ollama',
        cause: err,
      });
    }
    if (!json || typeof json !== 'object' || !Array.isArray((json as { data?: unknown }).data)) {
      throw new LLMError('parse', 'Ollama /v1/models returned unexpected shape', {
        provider: 'Ollama',
        raw: json,
      });
    }
    return fromOpenAIModelsList(json as Parameters<typeof fromOpenAIModelsList>[0]).map<ModelInfo>(
      (m) => ({
        id: m.id,
        ...(m.createdAt !== undefined ? { createdAt: m.createdAt } : {}),
      }),
    );
  },

  factory(rawConfig) {
    const config = resolveOllamaConfig(rawConfig as OllamaConfig);
    return {
      name: 'Ollama',
      chat: (req) => ollamaChat(config, req),
      stream: (req) => ollamaStream(config, req),
    };
  },
};

registerProvider(OllamaModule);

declare module '../../registry.js' {
  interface ProviderConfigMap {
    ollama: OllamaConfig;
  }
}

export { DEFAULT_OLLAMA_BASE_URL };
