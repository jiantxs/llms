/**
 * MiniMax Provider 配置。
 *
 * 不读环境变量；所有凭证 / 端点显式传入。
 * 模型列表不再写死 —— handle.listModels() 动态拉取。
 */

import type { ProviderConfigBase } from '../base.js';

export type MiniMaxConfig = ProviderConfigBase & {
  apiKey: string;
  baseUrl?: string;
};

export const DEFAULT_MINIMAX_BASE_URL = 'https://api.minimaxi.com/anthropic';

export const MINIMAX_MODELS_PATH = '/v1/models';

export type ResolvedMiniMaxConfig = {
  apiKey: string;
  baseUrl: string;
  fetch?: ProviderConfigBase['fetch'];
  timeoutMs?: number;
};

export function resolveMiniMaxConfig(config: MiniMaxConfig): ResolvedMiniMaxConfig {
  if (!config.apiKey || config.apiKey.trim() === '') {
    throw new Error('[MiniMax] apiKey is required and must be a non-empty string');
  }
  const baseUrl = (config.baseUrl ?? DEFAULT_MINIMAX_BASE_URL).replace(/\/+$/, '');
  return {
    apiKey: config.apiKey,
    baseUrl,
    fetch: config.fetch,
    timeoutMs: config.timeoutMs,
  };
}
