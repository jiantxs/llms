import type { ProviderConfigBase } from '../base.js';

export type MiniMaxConfig = ProviderConfigBase & {
  apiKey?: string;
  baseUrl?: string;
};

export const DEFAULT_MINIMAX_BASE_URL = 'https://api.minimaxi.com/anthropic';

export const MINIMAX_MODELS_PATH = '/v1/models';

export type ResolvedMiniMaxConfig = {
  apiKey?: string;
  baseUrl: string;
  fetch?: ProviderConfigBase['fetch'];
  timeoutMs?: number;
};

export function resolveMiniMaxConfig(config: MiniMaxConfig): ResolvedMiniMaxConfig {
  const baseUrl = (config.baseUrl ?? DEFAULT_MINIMAX_BASE_URL).replace(/\/+$/, '');
  const apiKey = config.apiKey?.trim() || undefined;
  return {
    ...(apiKey ? { apiKey } : {}),
    baseUrl,
    fetch: config.fetch,
    timeoutMs: config.timeoutMs,
  };
}
