# Evals（HD-11）

模型可见文本（skill 选择、MCP 工具描述、会话标题提示词）改动后，用这里的 case 对比行为有没有变差。

## 运行

```bash
pnpm eval -- --dry-run          # 只打印 prompt，不调用模型
pnpm eval:check                 # 只测 grader 本身，秒级，适合 CI
EVAL_API_KEY=... EVAL_MODEL=gpt-4o-mini pnpm eval
```

可选参数：

- `--case <id>`：只跑一个 case（`skill-selection` / `mcp-tool` / `thread-title`）。
- `--out <dir>`：结果目录，默认 `evals/runs/latest`（已忽略提交）。
- `--strict`：有失败时返回非零。
- `EVAL_BASE_URL`：OpenAI 兼容接口地址，默认 `https://api.openai.com/v1`。

## Case 形状

`evals/cases/*.json`：

```json
{
  "id": "skill-selection",
  "kind": "choice",
  "title": "Skill 选择",
  "prompt": "……只回答 JSON：{\"choice\":\"<skill id>\"}",
  "expected": "code-review"
}
```

- `kind: "choice"`：模型回答 JSON 里的 `choice`（或整段文本）必须等于 `expected`。
- `kind: "title"`：标题必须包含 `mustInclude` 里的全部关键词，且不超过 `maxLength`。

## 规则

- 一个 case 复现一次真实的坏体验；新增 case 时写清来源。
- 先加 case 再改文本：case 应在旧文本上失败、新文本上通过。
- 模型输出有波动：每个 case 跑多次，按多数结果判断；与同模型的基线比较，不看绝对分。
- 不写入任何用户数据；路径用 `/home/user`、`acme/app` 这类假值。
- 调用付费模型，**不进 CI**；CI 只跑 `pnpm eval:check`。
