/**
 * Provider 集合入口。
 *
 * 仅做副作用导入触发各 Provider 自注册。**不要**从这里 re-export 任何具体 Provider 类名。
 * 调用方应该走 listProviders() / createProvider() 统一 API。
 */

import './minimax/index.js';