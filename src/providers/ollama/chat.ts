import { doFetch } from '../base.js';
import type { ChatRequest, ChatResponse } from '../../types.js';
import type { ResolvedOllamaConfig } from './config.js';
import {
  fromOpenAIResponse,
  toOpenAIRequest,
  type OpenAIResponse,
} from './translate.js';

export async function ollamaChat(
  config: ResolvedOllamaConfig,
  request: ChatRequest,
): Promise<ChatResponse> {
  const body = toOpenAIRequest(request);

  const response = await doFetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(body),
    signal: request.signal,
  }, {
    provider: 'Ollama',
    fetchImpl: config.fetch,
    timeoutMs: config.timeoutMs,
  });

  const raw = (await response.json()) as OpenAIResponse;
  return fromOpenAIResponse(raw);
}

export function buildHeaders(config: ResolvedOllamaConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (config.apiKey) {
    headers['authorization'] = `Bearer ${config.apiKey}`;
  }
  return headers;
}
