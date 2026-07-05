import { normalizeHostname, type ProviderConfigBase } from '../base.js';

export type MiniMaxConfig = ProviderConfigBase & {
  apiKey?: string;
  baseUrl?: string;
  /**
   * 简化的访问地址 —— 只传主机名（可含端口），自动补 https:// 与默认 path /anthropic。
   * 与 baseUrl 同时设置时，baseUrl 优先（更具体的覆盖）。
   */
  hostname?: string;
};

export const DEFAULT_MINIMAX_BASE_URL = 'https://api.minimaxi.com/anthropic';
export const DEFAULT_MINIMAX_PROTOCOL = 'https';
export const DEFAULT_MINIMAX_PATH = '/anthropic';

export const MINIMAX_MODELS_PATH = '/v1/models';

export type ResolvedMiniMaxConfig = {
  apiKey?: string;
  baseUrl: string;
  fetch?: ProviderConfigBase['fetch'];
  timeoutMs?: number;
};

export function resolveMiniMaxConfig(config: MiniMaxConfig): ResolvedMiniMaxConfig {
  let baseUrl: string;
  if (config.baseUrl !== undefined) {
    baseUrl = config.baseUrl.replace(/\/+$/, '');
  } else if (config.hostname !== undefined) {
    baseUrl = normalizeHostname(DEFAULT_MINIMAX_PROTOCOL, config.hostname, DEFAULT_MINIMAX_PATH);
  } else {
    baseUrl = DEFAULT_MINIMAX_BASE_URL.replace(/\/+$/, '');
  }
  const apiKey = config.apiKey?.trim() || undefined;
  return {
    ...(apiKey ? { apiKey } : {}),
    baseUrl,
    fetch: config.fetch,
    timeoutMs: config.timeoutMs,
  };
}
