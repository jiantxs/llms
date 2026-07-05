/**
 * Ollama 模型上下文窗口大小 —— 默认空表。
 *
 * Ollama 的 `ollama show <model>` 端点会返回真实 context_length，但 OpenAI 兼容
 * 的 /v1/models 端点不暴露。如需精确值，可在 createProvider config 中传
 * maxContextLength 手动断言。
 */
import type { ContextLengthTable } from '../context.js';

export const OLLAMA_CONTEXT_LENGTHS: ContextLengthTable = {};