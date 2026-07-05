/**
 * MiniMax 非流式 chat。
 */

import { doFetch } from '../base.js';
import type { ChatRequest, ChatResponse } from '../../types.js';
import type { ResolvedMiniMaxConfig } from './config.js';
import {
  fromMiniMaxResponse,
  toMiniMaxRequest,
  type MiniMaxResponse,
} from './translate.js';
import { buildHeaders } from './headers.js';

const MESSAGES_PATH = '/v1/messages';

export async function minimaxChat(
  config: ResolvedMiniMaxConfig,
  request: ChatRequest,
): Promise<ChatResponse> {
  const body = toMiniMaxRequest(request);

  const response = await doFetch(`${config.baseUrl}${MESSAGES_PATH}`, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(body),
    signal: request.signal,
  }, {
    provider: 'MiniMax',
    fetchImpl: config.fetch,
    timeoutMs: config.timeoutMs,
  });

  const raw = (await response.json()) as MiniMaxResponse;
  return fromMiniMaxResponse(raw);
}