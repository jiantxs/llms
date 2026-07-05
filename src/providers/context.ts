/**
 * 模型上下文长度解析 —— Provider 共享 helper。
 *
 * 优先级：override（用户 config 强制断言） > contextTable（Provider 静态表） > DEFAULT_CONTEXT_LENGTH
 */

export const DEFAULT_CONTEXT_LENGTH = 32000;

export type ContextLengthTable = Readonly<Record<string, number>>;

/**
 * 解析指定模型的最大上下文长度。
 *
 * - override 提供且 > 0 → 一律返回 override（忽略表）
 * - 表中有 modelId → 返回表中值
 * - 其他 → 返回 DEFAULT_CONTEXT_LENGTH
 */
export function resolveContextLength(
  table: ContextLengthTable | undefined,
  modelId: string,
  override: number | undefined,
): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  if (table) {
    const v = table[modelId];
    if (v !== undefined && Number.isFinite(v) && v > 0) return v;
  }
  return DEFAULT_CONTEXT_LENGTH;
}