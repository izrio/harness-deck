#!/usr/bin/env node
/**
 * 模型行为 eval 运行器（HD-11）。
 *
 * 默认 dry-run：只打印每个 case 的 prompt，不调用模型。
 * 设置 EVAL_API_KEY / EVAL_MODEL 后才会调用 OpenAI 兼容的 /chat/completions。
 *
 * 用法：
 *   pnpm eval -- --dry-run
 *   EVAL_API_KEY=... EVAL_MODEL=gpt-4o-mini pnpm eval
 *   EVAL_BASE_URL=https://api.example.com/v1 pnpm eval -- --case thread-title --out evals/runs/today
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { builtinAgentProfiles } from '../packages/extension/src/hub/AgentStore.ts';
import { pluginCommands } from '../packages/extension/src/vm/context.ts';
import { grade } from './grade.mjs';

/** 从产品源码直接拼接提示词片段，保证修改真实提示词/描述后会直接体现在 eval 中，不复制文本。 */
function hydratePrompt(template) {
  const agentsList = builtinAgentProfiles('zh')
    .map((agent) => `${agent.id}（${agent.name}：${agent.specialty}）`)
    .join('、');
  const commandsList = pluginCommands()
    .map((cmd) => `/${cmd.name}（${cmd.description}）`)
    .join('、');
  return String(template).replaceAll('{{BUILTIN_AGENTS}}', agentsList).replaceAll('{{PLUGIN_COMMANDS}}', commandsList);
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const dryRun = flag('--dry-run');
const strict = flag('--strict');
const onlyCase = value('--case');
const outDir = value('--out', 'evals/runs/latest');
const model = process.env.EVAL_MODEL ?? 'gpt-4o-mini';
const apiKey = process.env.EVAL_API_KEY;
const baseUrl = (process.env.EVAL_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/u, '');

const casesDir = 'evals/cases';
const files = (await readdir(casesDir)).filter((file) => file.endsWith('.json')).sort();
const cases = [];
for (const file of files) {
  const parsed = JSON.parse(await readFile(join(casesDir, file), 'utf8'));
  if (onlyCase && parsed.id !== onlyCase) continue;
  cases.push({ ...parsed, prompt: hydratePrompt(parsed.prompt) });
}

if (cases.length === 0) {
  console.error(onlyCase ? `找不到 case：${onlyCase}` : 'evals/cases 下没有 case。');
  process.exit(1);
}

if (dryRun || !apiKey) {
  if (!dryRun) console.log('未设置 EVAL_API_KEY，按 dry-run 处理。\n');
  for (const item of cases) {
    console.log(`## ${item.id}（${item.title}）`);
    console.log(item.prompt);
    console.log();
  }
  console.log('dry-run 结束：没有调用模型。');
  process.exit(0);
}

async function callModel(prompt) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: '你是一个严格按格式回答的助手。只输出要求的 JSON 或标题，不要解释。' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? '';
}

const rows = [];
for (const item of cases) {
  process.stdout.write(`${item.id} ... `);
  try {
    const output = await callModel(item.prompt);
    const result = grade(item, output);
    rows.push({ id: item.id, title: item.title, ...result, output });
    console.log(result.pass ? 'PASS' : 'FAIL');
    if (!result.pass) console.log(`  actual: ${JSON.stringify(result.actual)}`);
  } catch (error) {
    rows.push({ id: item.id, title: item.title, pass: false, error: error instanceof Error ? error.message : String(error) });
    console.log('ERROR');
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

await mkdir(outDir, { recursive: true });
await writeFile(
  join(outDir, 'results.json'),
  `${JSON.stringify({ model, baseUrl, ranAt: new Date().toISOString(), rows }, null, 2)}\n`,
  'utf8',
);

const failed = rows.filter((row) => !row.pass);
console.log(`\n${rows.length - failed.length}/${rows.length} 通过；结果写在 ${join(outDir, 'results.json')}`);
if (strict && failed.length > 0) process.exit(1);
