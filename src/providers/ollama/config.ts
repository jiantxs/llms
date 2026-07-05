import { normalizeHostname, type ProviderConfigBase } from '../base.js';

export type OllamaConfig = ProviderConfigBase & {
  apiKey?: string;
  baseUrl?: string;
  /**
   * 简化的访问地址 —— 只传主机名（可含端口），自动补 http:// 与默认 path /v1。
   * 与 baseUrl 同时设置时，baseUrl 优先（更具体的覆盖）。
   */
  hostname?: string;
};

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';
export const DEFAULT_OLLAMA_PROTOCOL = 'http';
export const DEFAULT_OLLAMA_PATH = '/v1';

export const OLLAMA_CHAT_PATH = '/chat/completions';
export const OLLAMA_MODELS_PATH = '/models';

export type ResolvedOllamaConfig = {
  apiKey?: string;
  baseUrl: string;
  fetch?: ProviderConfigBase['fetch'];
  timeoutMs?: number;
};

export function resolveOllamaConfig(config: OllamaConfig): ResolvedOllamaConfig {
  let baseUrl: string;
  if (config.baseUrl !== undefined) {
    baseUrl = config.baseUrl.replace(/\/+$/, '');
  } else if (config.hostname !== undefined) {
    baseUrl = normalizeHostname(DEFAULT_OLLAMA_PROTOCOL, config.hostname, DEFAULT_OLLAMA_PATH);
  } else {
    baseUrl = DEFAULT_OLLAMA_BASE_URL.replace(/\/+$/, '');
  }
  const apiKey = config.apiKey?.trim() || undefined;
  return {
    ...(apiKey ? { apiKey } : {}),
    baseUrl,
    fetch: config.fetch,
    timeoutMs: config.timeoutMs,
  };
}
