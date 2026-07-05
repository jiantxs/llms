# llms

> 统一 LLM 抽象层 —— Provider 无感知的多轮对话、工具调用、流式与思考输出。

零运行时依赖，零环境变量。注册表 + 字符串 id 驱动的 Provider 发现机制。

## Features

- **Provider 注册表 + 发现 API** —— `listProviders()` 看所有支持的供应商，按 id `createProvider()` 即用
- **协议无关的领域模型** —— `Message` / `ContentBlock` / `Tool` 一套类型，内部走各自 Adapter（Anthropic / OpenAI / ...）
- **动态模型列表** —— `handle.listModels()` 真实打服务器拉取（缓存 5 分钟，可强制刷新），本机不写死任何模型名
- **流式输出 + 工具循环同时支持** —— `conversation({ stream: true })` 每轮用 `handle.stream()` 实时刷 token，工具循环完整保留上下文与思维链
- **思考模式 + 多轮签名传递**（Anthropic/MiniMax 思维链续传）
- **并行工具执行** —— 单工具失败不影响其他，错误以 `isError: true` tool_result 写回由模型自行决定
- **声明式 config 类型** —— 各 Provider 用 declaration merging 注册自己的 config 类型，`createProvider('minimax', { apiKey })` 自动校验
- **可注入 fetch** —— 测试和代理场景友好
- **打断模型输出** —— 全链路支持 `AbortSignal`：HTTP 请求、流式 SSE、工具调用都能中断；`conversation.abort()` 一键取消，错误归一化为 `LLMError('aborted')`

## Install

作为 npm 包：

```bash
npm install llms
```

从源码：

```bash
git clone <repo>
cd llms
npm install
npm run build
```

唯一编译期依赖：`typescript`（仅 devDep）。

## Quick Start

```ts
import { listProviders, createProvider, conversation } from 'llms';

// 1. 发现当前支持的所有 Provider
const providers = listProviders();
// → [{ id: 'minimax', name: 'MiniMax', defaultModel: 'MiniMax-M3', features: {...} }, ...]

// 2. 按 id 创建 handle（API Key 显式传入）
const handle = createProvider('minimax', { apiKey: 'YOUR_KEY' });

// 3. 动态拉取该 Provider 当前可用模型
const models = await handle.listModels();
// → [{ id: 'MiniMax-M3', displayName: 'M3', createdAt: '...' }, ...]

// 4. 多轮对话 + 思考 + 工具（流式 token-by-token）
const convo = conversation(handle, {
  model: models[0].id,
  thinking: { type: 'enabled' },
  tools: [{
    name: 'get_time',
    description: '查询当前时间',
    inputSchema: { type: 'object', properties: { tz: { type: 'string' } } },
    execute: async (_n, input) => ({ iso: new Date().toISOString() }),
  }],
});

const r = await convo.send('现在上海几点？', {
  stream: true,
  events: {
    onToolCall: (name, inp) => console.log(`\n🔧 ${name}(${JSON.stringify(inp)})`),
    onToolResult: (_n, r, isErr, ms) => console.log(`  📋 ${JSON.stringify(r)} [${ms}ms]`),
    onStreamEvent: (ev) => {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        process.stdout.write(ev.delta.text);
      }
    },
  },
});
```

## Core Concepts

### Provider
一个 LLM 服务方。声明 `id`、`name`、`defaultModel`、`features`、`factory`（实例构造），可选 `listModels`（动态拉取）。

### Handle
`createProvider(id, config)` 的返回值。包装了 `chat` / `stream` / `listModels` 三种异步操作，统一签名 + 缓存。

### Message / ContentBlock
消息由**角色 + 内容块数组**组成，块类型：

```ts
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id; name; input }
  | { type: 'tool_result'; toolUseId; content; isError? };
```

### Tool
声明 + 可选执行器。`name, input, ctx` 三参数统一签名，错误会被 `runWithTools` 捕获并以 `tool_result.isError = true` 回写给模型。

```ts
type Tool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute?: (name: string, input: unknown, ctx: ToolContext) => Promise<unknown>;
};
```

## Core API

| 函数 | 作用 |
|---|---|
| `listProviders()` | 列出全部已注册 Provider |
| `createProvider(id, config)` | 按 id 创建 handle（config 类型按 id 自动收窄） |
| `hasProvider(id)` / `getProvider(id)` / `getProviderModels(id)` / `getProviderDefaultModel(id)` | 注册表同步访问器 |
| `handle.listModels({ refresh?, signal? })` | 动态拉取模型列表（缓存 5 分钟） |
| `handle.chat(request)` / `handle.stream(request)` | 直接调模型（不走工具循环） |
| `streamToResponse(stream, onEvent?)` | 把 SSE 流累积为 `ChatResponse` |
| `runWithTools(handle, request)` | 一次性自动工具循环（并行 / 错误回写 / maxIterations / 流式） |
| `conversation(handle, options).send(input, sendOpts)` | 有状态多轮，内部用 `runWithTools` 自动续上下文 |
| `conversation.abort()` / `conversation.signal` | 主动打断当前 send / 监听 abort 信号 |
| `doFetch` / `parseSSE` | 高级：自定义 Provider 时可复用 |

完整类型见 `src/types.ts` 与 `src/registry.ts`。

## Built-in Providers

### MiniMax（Anthropic 兼容协议）

```ts
import { createProvider } from 'llms';

const handle = createProvider('minimax', {
  apiKey: 'sk-cp-...',
  // 可选：私有化部署或代理
  baseUrl: 'https://api.minimaxi.com/anthropic',
});
```

支持的模型通过 `handle.listModels()` 动态获取（M3 / M2.7 / M2.5 / M2.1 / M2 全系列），端点 `GET /anthropic/v1/models`。

### Ollama（OpenAI 兼容协议 · 本地）

```ts
const handle = createProvider('ollama', {
  // 默认 http://localhost:11434/v1，无 apiKey 也可
  // apiKey: 'your-ollama-key', // 如果启用了鉴权
  // baseUrl: 'http://192.168.1.10:11434/v1', // 远程 Ollama
});
```

**思考支持**：`features.thinking = true`。依赖 Ollama OpenAI 兼容端点新增的 `reasoning_effort` 字段（控制强度，映射为 `enabled → medium` / `disabled → none`），响应中通过 `message.reasoning` 与流式 `delta.reasoning` 拉取思维链。适用于 DeepSeek R1 / Qwen3 / GPT-OSS 等思考型模型；非思考型模型忽略该字段，原行为不变。模型列表通过 `GET /v1/models` 动态获取（返回本地已 `ollama pull` 的模型，例如 `deepseek-r1:latest`、`qwen3:latest`、`llama3:latest`）。

使用示例：

```bash
# 先启动 Ollama
ollama serve                       # 默认 :11434
ollama pull deepseek-r1            # 拉一个思考型模型
```

```ts
const handle = createProvider('ollama');
const models = await handle.listModels();
// → [{ id: 'deepseek-r1:latest' }, ...]

const convo = conversation(handle, {
  model: models[0].id,             // 'deepseek-r1:latest'
  thinking: { type: 'enabled' },   // 开启思维链
  tools: [/* ... */],
});
```

## Abort / Cancel

整个调用链都支持标准的 `AbortSignal`，可由 `AbortController` 控制。打断后会抛出 `LLMError`，`code === 'aborted'`，可通过 `err.aborted === true` 或 `err.abortReason`（`'user'` / `'timeout'`）进一步判断。

```ts
// 方式一：传 signal —— 每次 send 都用同一个 controller
const ctrl = new AbortController();
const p = convo.send('写一篇长文', { signal: ctrl.signal });
setTimeout(() => ctrl.abort(), 1000); // 1s 后打断
try {
  await p;
} catch (err) {
  if (err instanceof LLMError && err.code === 'aborted') {
    console.log('用户取消了', err.abortReason);
  }
}

// 方式二：直接调 conversation.abort() —— 无需自己持有 controller
const p2 = convo.send('再写一篇');
setTimeout(() => convo.abort(), 1000);
try {
  await p2;
} catch (err) {
  // err.code === 'aborted'
}

// chat / stream / listModels 也同样接受 signal
await handle.chat({ ..., signal: ctrl.signal });
await handle.stream({ ..., signal: ctrl.signal }).next(); // 流式也能打断
await handle.listModels({ signal: ctrl.signal });

// 工具调用也会被 signal 触发 abort —— ctx.signal 传入 ToolExecutor
const tool = {
  name: 'slow_op',
  execute: async (_n, _i, ctx) => {
    ctx.signal?.addEventListener('abort', () => cleanup());
    await longRunning();
  },
};
```

abort 适用场景：用户在 UI 上按 Esc / Ctrl-C 打断、AI 出错立即停止长生成、超时控制、批量任务中取消某个仍在排队的请求。

## Adding a Provider

每个 Provider 是一个独立模块，导入时自注册。

```ts
// src/providers/myprov/index.ts
import { registerProvider } from 'llms';

registerProvider({
  id: 'myprov',
  name: 'My Provider',
  description: '...',
  models: [],                          // 静态 fallback（可空）
  defaultModel: 'myprov-best',
  features: { thinking: true, tools: true, streaming: true, multimodal: false },
  dynamicModels: false,

  factory: (config) => ({
    name: 'My Provider',
    chat: async (req) => { /* POST to upstream, return ChatResponse */ },
    stream: async function* (req) { /* yield StreamEvent one by one */ },
  }),

  // 可选：动态拉模型
  listModels: async (config, ctx) => [{ id: 'myprov-best' }],
});

// ProviderConfigMap 用 declaration merging 暴露 config 类型
declare module 'llms' {
  interface ProviderConfigMap {
    myprov: { apiKey: string; baseUrl?: string };
  }
}
```

实现 `LLMProvider` 协议时请遵守：

- `chat()` 返回的 `message.content` 块数组含 `thinking` / `text` / `tool_use`（按返回原序）
- `stream()` 产出标准 `StreamEvent` 序列（`message_start` / `content_block_start` / `*_delta` / `*_stop` / `message_stop`）
- `listModels` 抛 `LLMError` 时给准确的 `code`（`authentication` / `rate_limit` / `network` / `parse`）

## Project Structure

```
src/
├── types.ts                       # 领域类型（Message / ContentBlock / Tool / ModelInfo / LLMError）
├── registry.ts                    # listProviders / createProvider / getProvider* / handle.listModels
├── run-with-tools.ts              # runWithTools + streamToResponse（流式 + 工具循环）
├── conversation.ts                # 有状态多轮 + events 回调
├── index.ts                       # 公共 API 入口
└── providers/
    ├── base.ts                    # doFetch + parseSSE（共享 HTTP / SSE 工具）
    ├── index.ts                   # 副作用触发各 Provider 自注册
    ├── minimax/                   # MiniMax 实现（Anthropic 兼容协议）
    │   ├── config.ts              # 配置 + baseUrl 默认值
    │   ├── chat.ts                # POST /v1/messages
    │   ├── stream.ts              # POST /v1/messages (stream) + SSE 解析
    │   ├── translate.ts           # 协议翻译（请求 / 响应 / 流式事件）
    │   └── index.ts               # Module 自注册 + listModels() 实现
    └── ollama/                    # Ollama 实现（OpenAI 兼容协议 · 本地）
        ├── config.ts              # 配置（默认 http://localhost:11434/v1）
        ├── chat.ts                # POST /v1/chat/completions
        ├── stream.ts              # POST /v1/chat/completions (stream) + OpenAI SSE
        ├── translate.ts           # OpenAI Chat Completions 翻译
        └── index.ts               # Module 自注册 + listModels() 实现
```

## Scripts

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
npm run clean       # rm -rf dist/
```

## Try It

`test.js` 是一个交互式 CLI demo —— 跑起来直接对话：

```bash
npx tsc                    # 先构建
node test.js               # 选供应源 → 输 API Key → 动态拉模型 → 选模型 → 开聊
```

支持命令：`/exit` `/reset` `/tools` `/info` `/stream` `/abort` `/help`。send 中按 Ctrl-C 即可打断模型输出。

## License

[MIT](./LICENSE)
