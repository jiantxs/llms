/**
 * test.js —— 交互式 LLM 命令行测试
 *
 * 流程：选供应源 → 选模型 → 输 API Key → 创建 handle → 动态拉模型 → 选模型 → 配置 → 多轮对话
 *
 * 命令：
 *   /exit    退出
 *   /reset   清空对话历史
 *   /tools   列出工具
 *   /info    显示会话信息
 *   /stream  切换流式开关
 *   /help    帮助
 */

import readline from 'node:readline';
import {
  listProviders,
  getProvider,
  getProviderDefaultModel,
  createProvider,
  conversation,
  LLMError,
} from './dist/index.js';

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

const R = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const RED = '\x1b[31m';

// ---------------------------------------------------------------------------
// 示范工具
// ---------------------------------------------------------------------------

const demoTools = [
  {
    name: 'get_current_time',
    description: '获取当前时间。可选 timezone，如 "Asia/Shanghai"。',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA 时区，如 "Asia/Shanghai" / "America/New_York"。省略则 UTC。',
        },
      },
    },
    execute: async (_name, input) => {
      const tz = String(input?.timezone ?? 'UTC');
      const now = new Date();
      try {
        const formatted = new Intl.DateTimeFormat('zh-CN', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }).format(now);
        return { timezone: tz, datetime: formatted, iso: now.toISOString() };
      } catch {
        throw new Error(`未知时区: ${tz}`);
      }
    },
  },
  {
    name: 'random_number',
    description: '在指定范围内生成一个随机整数（闭区间）。默认 1-100。',
    inputSchema: {
      type: 'object',
      properties: {
        min: { type: 'integer', description: '下界' },
        max: { type: 'integer', description: '上界' },
      },
    },
    execute: async (_name, input) => {
      const min = Number.isFinite(input?.min) ? input.min : 1;
      const max = Number.isFinite(input?.max) ? input.max : 100;
      if (min > max) throw new Error(`min (${min}) 不能大于 max (${max})`);
      const value = Math.floor(Math.random() * (max - min + 1)) + min;
      return { min, max, value };
    },
  },
  {
    name: 'calculate',
    description: '计算数学表达式。支持 + - * / ^ ( ) 和数字。',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '表达式，如 (2+3)*4^2' },
      },
      required: ['expression'],
    },
    execute: async (_name, input) => {
      const expr = String(input?.expression ?? '');
      if (!/^[\d\s+\-*/().,^]+$/.test(expr)) {
        throw new Error('非法字符：仅允许数字、空格和 + - * / ^ ( ) . ,');
      }
      const result = Function(`"use strict"; return (${expr.replace(/\^/g, '**')})`)();
      return { expression: expr, result };
    },
  },
];

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderThinking(text) {
  const lines = text.split('\n');
  const w = process.stdout.columns || 80;
  const width = Math.min(60, w - 4);
  console.log(`\n${MAGENTA}┌─ 💭 思考 ${'─'.repeat(Math.max(0, width - 11))}┐${R}`);
  for (const line of lines) console.log(`${MAGENTA}│${R} ${line}`);
  console.log(`${MAGENTA}└${'─'.repeat(width + 2)}┘${R}`);
}

function renderToolCall(name, input) {
  console.log(`\n${YELLOW}🔧 ${BOLD}${name}${R}${YELLOW}(${R}${DIM}${JSON.stringify(input)}${R}${YELLOW})${R}`);
}

function renderToolResult(result, isError, ms) {
  const prefix = isError
    ? `${RED}❌ 失败 [${ms}ms]${R}`
    : `${GREEN}📋 返回 [${ms}ms]${R}`;
  console.log(`  ${prefix} ${DIM}${JSON.stringify(result)}${R}`);
}

function divider() {
  const w = Math.min(60, (process.stdout.columns || 80) - 4);
  console.log(`${DIM}${'─'.repeat(w)}${R}`);
}

function createStreamRenderer() {
  const thinkingBuffers = new Map();
  let textStarted = false;
  return {
    onStreamEvent(ev) {
      if (ev.type === 'content_block_delta') {
        if (ev.delta.type === 'thinking_delta') {
          const prev = thinkingBuffers.get(ev.index) ?? '';
          thinkingBuffers.set(ev.index, prev + ev.delta.thinking);
        } else if (ev.delta.type === 'text_delta') {
          if (thinkingBuffers.size > 0) {
            for (const [idx, txt] of thinkingBuffers) {
              if (txt) renderThinking(txt);
              thinkingBuffers.set(idx, '');
            }
          }
          if (!textStarted) {
            process.stdout.write(`\n${CYAN}💬 ${R}`);
            textStarted = true;
          }
          process.stdout.write(ev.delta.text);
        }
      } else if (ev.type === 'content_block_stop') {
        const buf = thinkingBuffers.get(ev.index);
        if (typeof buf === 'string' && buf) {
          renderThinking(buf);
          thinkingBuffers.set(ev.index, '');
        }
      } else if (ev.type === 'message_stop') {
        for (const [, txt] of thinkingBuffers) {
          if (txt) renderThinking(txt);
        }
        thinkingBuffers.clear();
        if (textStarted) {
          process.stdout.write('\n');
          textStarted = false;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// readline
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function prompt(question) {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a)));
}

async function promptChoice(question, min, max) {
  while (true) {
    const ans = (await prompt(question)).trim();
    if (ans === '') {
      console.log(`  ${RED}✗ 不能为空${R}`);
      continue;
    }
    const n = parseInt(ans, 10);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
    console.log(`  ${RED}✗ 无效，请输入 ${min}-${max} 之间的数字${R}`);
  }
}

async function promptInt(question, defaultValue, min, max) {
  while (true) {
    const raw = (await prompt(question)).trim();
    if (raw === '') return defaultValue;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= min && n <= max) return n;
    console.log(`  ${RED}✗ 无效，请输入 ${min}-${max} 之间的数字${R}`);
  }
}

async function promptYesNo(question, defaultYes) {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const raw = (await prompt(question + suffix)).trim().toLowerCase();
  if (raw === '') return defaultYes;
  return raw === 'y' || raw === 'yes';
}

let userWantsToQuit = false;
rl.on('SIGINT', () => {
  if (userWantsToQuit) {
    console.log('\n再见 👋');
    rl.close();
    process.exit(0);
  } else {
    console.log(`\n${YELLOW}提示：再次 Ctrl+C 退出，或输入 /exit${R}`);
    userWantsToQuit = true;
    prompt(`\n你 > `).then(handleUserInput);
  }
});

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  console.log(`${BOLD}┌──────────────────────────────────────────────┐${R}`);
  console.log(`${BOLD}│  llms 交互式测试                                │${R}`);
  console.log(`${BOLD}└──────────────────────────────────────────────┘${R}`);

  const providers = listProviders();
  if (providers.length === 0) {
    console.error(`${RED}未注册任何 Provider${R}`);
    process.exit(1);
  }

  console.log(`\n${BOLD}[1] 选择供应源${R}`);
  providers.forEach((p, i) => {
    console.log(`  ${GREEN}${i + 1}${R}) ${BOLD}${p.id}${R} (${p.name})`);
    console.log(`      ${DIM}${p.description}${R}`);
  });
  const providerIdx = await promptChoice(`\n请输入编号 [1-${providers.length}]: `, 1, providers.length);
  const selectedProvider = providers[providerIdx - 1];

  console.log(`\n${BOLD}[2] API Key${R} (${getProvider(selectedProvider.id)?.name ?? selectedProvider.id})`);
  console.log(`  ${DIM}提示：可设置环境变量 ${selectedProvider.id.toUpperCase()}_API_KEY；留空则不发送 Authorization header${R}`);
  const apiKeyRaw = (await prompt(`API Key (回车跳过): `)).trim();
  let apiKey = apiKeyRaw;
  if (!apiKey) {
    apiKey = process.env[`${selectedProvider.id.toUpperCase()}_API_KEY`] ?? '';
    if (apiKey) {
      console.log(`${GREEN}  ✓ 已从环境变量读取${R}`);
    } else {
      console.log(`${YELLOW}  ! 留空 → 不发送 Authorization header（依赖服务端是否允许匿名）${R}`);
    }
  }

  console.log(`\n${BOLD}[3] 创建 handle + 动态拉取模型列表${R}`);
  process.stdout.write(`  ${DIM}创建中...${R}`);
  const handle = createProvider(selectedProvider.id, { apiKey });
  process.stdout.write(`\r${DIM}创建完成      ${R}\n`);

  if (!handle.info.dynamicModels) {
    console.error(`${RED}该 Provider 不支持动态模型列表${R}`);
    process.exit(1);
  }

  process.stdout.write(`  ${DIM}拉取 ${selectedProvider.id} 可用模型...${R}`);
  let models;
  try {
    models = await handle.listModels();
  } catch (err) {
    process.stdout.write('\n');
    console.error(`${RED}✗ 拉取模型失败${R}: ${err.message}`);
    if (err instanceof LLMError && err.status) {
      console.error(`  ${DIM}status: ${err.status}${R}`);
    }
    process.exit(1);
  }
  process.stdout.write(`\r${DIM}拉取完成      ${R}\n`);

  if (models.length === 0) {
    console.error(`${RED}该 Provider 当前没有可用模型${R}`);
    process.exit(1);
  }

  // 默认：Provider 声明的 defaultModel 优先；否则取动态列表的第一个
  const declaredDefault = getProviderDefaultModel(selectedProvider.id);
  const defaultModelId =
    declaredDefault && models.some((m) => m.id === declaredDefault)
      ? declaredDefault
      : models[0].id;

  console.log(`\n${BOLD}[4] 选择模型${R} ${DIM}(共 ${models.length} 个，来自 handle.listModels())${R}`);
  models.forEach((m, i) => {
    const isDefault = m.id === defaultModelId;
    const note = m.displayName && m.displayName !== m.id ? ` ${DIM}— ${m.displayName}${R}` : '';
    console.log(
      `  ${GREEN}${i + 1}${R}) ${BOLD}${m.id}${R}${isDefault ? ` ${DIM}(默认)${R}` : ''}${note}`,
    );
  });
  const modelIdx = await promptChoice(`\n请输入编号 [1-${models.length}]: `, 1, models.length);
  const selectedModel = models[modelIdx - 1].id;

  console.log(`\n${BOLD}[5] 配置${R}`);
  const maxIterations = await promptInt(`工具调用最大轮次 (1-50) [10]: `, 10, 1, 50);
  let useStream = await promptYesNo(`开启流式输出？`, true);
  if (handle.info.features.streaming === false) {
    console.log(`  ${YELLOW}! 当前 Provider 不支持流式，自动关闭${R}`);
    useStream = false;
  }

  console.log();
  console.log(`${GREEN}✓${R} Provider:  ${BOLD}${getProvider(handle.id)?.name ?? handle.id}${R}`);
  console.log(`${GREEN}✓${R} Model:     ${BOLD}${selectedModel}${R}`);
  console.log(`${GREEN}✓${R} 思考:      ${GREEN}开启${R}`);
  console.log(`${GREEN}✓${R} 工具:      ${demoTools.map((t) => `${BOLD}${t.name}${R}`).join(', ')}`);
  console.log(`${GREEN}✓${R} maxIter:   ${BOLD}${maxIterations}${R}`);
  console.log(`${GREEN}✓${R} 流式输出:  ${useStream ? `${GREEN}开启${R}` : `${DIM}关闭${R}`}`);
  console.log(`${DIM}  ↳ 模型列表通过 handle.listModels() 动态拉取，已缓存 5 分钟${R}`);
  divider();

  const convo = conversation(handle, {
    model: selectedModel,
    thinking: { type: 'enabled' },
    tools: demoTools,
    maxIterations,
    system: `你是一个交互式助手，可以使用以下工具：
- get_current_time: 获取当前时间
- random_number: 生成随机数
- calculate: 计算数学表达式

请用中文回答。需要时主动调用工具。`,
  });

  console.log(`\n${DIM}已就绪。命令: ${BOLD}/exit /reset /tools /info /stream /help${R}`);

  const ask = () => prompt(`\n${BOLD}你 >${R} `);
  await ask().then(handleUserInput);

  async function handleUserInput(rawInput) {
    const input = rawInput.trim();
    if (!input) {
      await ask().then(handleUserInput);
      return;
    }

    if (input === '/exit' || input === '/quit') {
      console.log('\n再见 👋');
      userWantsToQuit = true;
      rl.close();
      return;
    }
    if (input === '/reset') {
      convo.reset();
      console.log(`${YELLOW}✓ 对话已重置 (消息数: ${convo.messages.length})${R}`);
      divider();
      await ask().then(handleUserInput);
      return;
    }
    if (input === '/tools') {
      console.log(`\n${BOLD}工具清单:${R}`);
      for (const t of demoTools) {
        console.log(`  ${CYAN}${t.name}${R} —— ${DIM}${t.description}${R}`);
      }
      divider();
      await ask().then(handleUserInput);
      return;
    }
    if (input === '/info') {
      const turns = convo.messages.filter((m) => m.role === 'user').length;
      console.log(`\n${BOLD}会话信息:${R}`);
      console.log(`  Provider:      ${getProvider(handle.id)?.name ?? handle.id} (${handle.id})`);
      console.log(`  Model:         ${selectedModel}`);
      console.log(`  Conv ID:       ${convo.id}`);
      console.log(`  Turn:          ${turns} 轮用户消息`);
      console.log(`  消息数:        ${convo.messages.length} (含 tool_use / tool_result)`);
      console.log(`  maxIterations: ${maxIterations}`);
      console.log(`  流式输出:      ${useStream ? `${GREEN}开启${R}` : `${DIM}关闭${R}`}`);
      divider();
      await ask().then(handleUserInput);
      return;
    }
    if (input === '/stream') {
      useStream = !useStream;
      console.log(`${YELLOW}✓ 流式输出已${useStream ? '开启' : '关闭'}${R}`);
      divider();
      await ask().then(handleUserInput);
      return;
    }
    if (input === '/help') {
      console.log(`\n${BOLD}命令:${R}
  ${CYAN}/exit${R}    退出
  ${CYAN}/reset${R}   清空对话历史
  ${CYAN}/tools${R}   列出工具
  ${CYAN}/info${R}    显示会话信息
  ${CYAN}/stream${R}  切换流式开关
  ${CYAN}/help${R}    本帮助`);
      divider();
      await ask().then(handleUserInput);
      return;
    }

    process.stdout.write(`\n${DIM}… 模型工作中${R}`);
    try {
      const streamRenderer = createStreamRenderer();
      await convo.send(input, {
        stream: useStream,
        events: {
          onToolCall: (name, inp) => {
            process.stdout.write('\n');
            renderToolCall(name, inp);
          },
          onToolResult: (name, result, isError, ms) => {
            renderToolResult(result, isError, ms);
          },
          onAssistantBlock: (block) => {
            if (useStream) return;
            if (block.type === 'thinking') renderThinking(block.thinking);
            else if (block.type === 'text') console.log(`\n${CYAN}💬 ${block.text}${R}`);
          },
          ...(useStream ? { onStreamEvent: streamRenderer.onStreamEvent } : {}),
        },
      });
      process.stdout.write('\x1b[2K\r');
      divider();
    } catch (err) {
      process.stdout.write('\x1b[2K\r');
      if (err instanceof LLMError) {
        console.error(`${RED}✗ ${err.code}${R}: ${err.message}`);
        if (err.status) console.error(`  ${DIM}status: ${err.status}${R}`);
      } else {
        console.error(`${RED}✗ ${err.message}${R}`);
      }
      divider();
    }

    await ask().then(handleUserInput);
  }
}

main().catch((err) => {
  console.error(`\n${RED}FATAL${R}`, err.stack ?? err.message ?? err);
  rl.close();
  process.exit(1);
});
