import type { ProviderConfigBase } from '../base.js';

export type OllamaConfig = ProviderConfigBase & {
  apiKey?: string;
  baseUrl?: string;
};

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

export const OLLAMA_CHAT_PATH = '/chat/completions';
export const OLLAMA_MODELS_PATH = '/models';

export type ResolvedOllamaConfig = {
  apiKey?: string;
  baseUrl: string;
  fetch?: ProviderConfigBase['fetch'];
  timeoutMs?: number;
};

export function resolveOllamaConfig(config: OllamaConfig): ResolvedOllamaConfig {
  const baseUrl = (config.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
  const apiKey = config.apiKey?.trim() || undefined;
  return {
    ...(apiKey ? { apiKey } : {}),
    baseUrl,
    fetch: config.fetch,
    timeoutMs: config.timeoutMs,
  };
}
