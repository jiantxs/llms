import type { ResolvedMiniMaxConfig } from './config.js';

export function buildHeaders(
  config: ResolvedMiniMaxConfig,
  extras: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...extras,
  };
  if (config.apiKey) {
    headers['x-api-key'] = config.apiKey;
  }
  return headers;
}
