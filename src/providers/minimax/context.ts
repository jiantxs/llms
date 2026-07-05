/**
 * MiniMax 模型上下文窗口大小。
 *
 * 数据源: https://platform.minimaxi.com/docs/guides/text-generation
 * （"支持模型" 表 —— 模型名称 → 上下文窗口）
 */
import type { ContextLengthTable } from '../context.js';

export const MINIMAX_CONTEXT_LENGTHS: ContextLengthTable = {
  'MiniMax-M3': 1_000_000,
  'MiniMax-M2.7': 204_800,
  'MiniMax-M2.7-highspeed': 204_800,
  'MiniMax-M2.5': 204_800,
  'MiniMax-M2.5-highspeed': 204_800,
  'MiniMax-M2.1': 204_800,
  'MiniMax-M2.1-highspeed': 204_800,
  'MiniMax-M2': 204_800,
  'M2-her': 65_536,
};