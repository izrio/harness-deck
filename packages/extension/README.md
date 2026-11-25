<p align="center"><img src="https://raw.githubusercontent.com/izrio/dsh-vscode-copilot/HEAD/packages/extension/media/icon.png" width="96" alt="Halo"></p>

# Halo

编程代理（coding agent）的 VS Code 对话面板：侧边栏对话、逐字流式回复、紧凑的工具活动行、审批与提问、用 VS Code Diff 查看每次改动。

面板背后的「底层」可以切换：

- **DeepSeek**（原生，即 dsh）：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。功能最全，会话和 dsh Web UI、DeepSeek Desktop 共用。
- **Claude Code**（原生）：Anthropic [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（以 `claude -p` 双向 `stream-json` 原生对接），与终端 Claude Code 共用登录与 `~/.claude/projects` 历史会话。
- **Codex**（原生）：OpenAI [Codex](https://developers.openai.com/codex)（以 `codex app-server` 双向 JSON-RPC 原生对接），支持模型与推理等级切换、运行中插队、提问卡片与子代理，与终端 Codex 共用登录与历史会话。
- **CodeBuddy**（原生）：腾讯 [CodeBuddy](https://www.codebuddy.ai/cli)（以 `codebuddy -p` 双向 `stream-json` 原生对接），支持多标签并发运行、子代理、订阅额度与 `~/.codebuddy/projects` 本地历史会话。
- **Pi**（原生）：[Pi Coding Agent](https://pi.dev)（以 `pi --mode rpc` 原生对接），支持多家模型提供方、思考档位与运行中 `steer` 插队。
- **ZCode**（原生）：智谱 [ZCode](https://zcode.z.ai/)（`zcode app-server --stdio` 原生对接），支持逐字流式、推理、工具行、审批、提问卡片与消息插队。
- **ACP 代理**：任何支持 [Agent Client Protocol](https://agentclientprotocol.com) 的代理。内置了 [OpenCode](https://opencode.ai)（`opencode acp`）与 Google Antigravity（`agy acp`），也可以自己加（例如 Gemini CLI）。

Agent 能力（读写文件、执行命令、审批、会话、模型）都由底层提供；插件负责启动和连接底层、显示界面，并补上 VS Code 的集成。这个插件以前叫 **DSH Copilot**。

[English](#english) below.

## 准备

**用 DeepSeek（dsh）**

1. 安装 dsh（`0.2.1-rc.5` 及以上，已测试到 `0.2.2-rc.5`），任选一种：
   - 安装 [DeepSeek Desktop](https://www.deepseek.com/en/download/)，在它的菜单「管理 dsh 命令…」中安装 `dsh` 命令；
   - 或执行 `npm install -g @deepseek-ai/dsh`（需要 Node ≥ 24.9）。

   插件在 `PATH` 里查找 `dsh`，也可以在设置 `harnessDeck.dsh.path` 中指定路径。
2. 第一次打开对话时按提示配置 DeepSeek API Key（保存到 dsh 的凭据存储，不会写进工作区）。

**用 Pi**

1. 执行 `npm install -g @earendil-works/pi-coding-agent`（或在设置页一键安装），确认终端里 `pi --version` 能运行，也可在设置 `harnessDeck.pi.path` 中指定路径。
2. 在终端运行 `pi` 输入 `/login` 配置模型提供方，或在插件「设置 → 服务商」里直接为 Pi 绑定服务商。
3. 在对话面板「设置 → 智能体」或「切换智能体」命令里选 **Pi**（插件以 `pi --mode rpc` 原生运行它）。

**用 CodeBuddy**

1. 执行 `npm install -g @tencent-ai/codebuddy-code`（或在设置页一键安装），确认终端里 `codebuddy --version` 能运行，也可在设置 `harnessDeck.codebuddy.path` 中指定路径。
2. 在终端运行一次 `codebuddy` 完成账号登录（与终端共用凭证与 `~/.codebuddy/projects` 会话），或在插件「设置 → 服务商」里直接为 CodeBuddy 绑定 OpenAI Chat 兼容服务商。
3. 在对话面板「设置 → 智能体」或「切换智能体」命令里选 **CodeBuddy**（插件以 `codebuddy -p` 原生流式 JSON 模式按会话独立运行，支持多标签并发）。

**用 Claude Code**

1. 执行 `npm install -g @anthropic-ai/claude-code`（或在设置页一键安装），确认终端里 `claude --version` 能运行，也可在设置 `harnessDeck.claude.path` 中指定路径。
2. 在终端运行 `claude` 输入 `/login` 登录（与终端共用会话与凭证），或在插件「设置 → 服务商」里直接为 Claude Code 绑定服务商。
3. 在对话面板「设置 → 智能体」或「切换智能体」命令里选 **Claude Code**（插件以 `claude -p` 流式 JSON 模式原生运行它）。

**用 Codex**

1. 执行 `npm install -g @openai/codex`（或在设置页一键安装），确认终端里 `codex --version` 能运行，也可在设置 `harnessDeck.codex.path` 中指定路径。
2. 在终端运行 `codex login` 登录 ChatGPT 账号（与终端共用会话与凭证），或在插件「设置 → 服务商」里直接为 Codex 绑定 OpenAI Responses / Chat 兼容服务商。
3. 在对话面板「设置 → 智能体」或「切换智能体」命令里选 **Codex**（插件以 `codex app-server` 原生运行它）。

**用 OpenCode**

1. 执行 `npm install -g opencode-ai`（或在设置页一键安装），确认终端里 `opencode --version` 能运行。
2. 在终端运行 `opencode auth login`（或在 `opencode` 中输入 `/connect`）配置模型提供方与 API Key。
3. 在对话面板的设置页或「切换智能体」命令里选 **OpenCode**。支持 Build / Plan 模式与模型切换。

**用 ZCode**

1. 安装 [ZCode 桌面端](https://zcode.z.ai/)（自动识别内置 `zcode.cjs`），或执行 `npm install -g zcode-app-cli` 安装命令行，也可在设置 `harnessDeck.zcode.path` 中指定路径。
2. 在 ZCode 桌面端或终端运行 `zcode` 登录智谱 BigModel / Z.ai Coding Plan 账号（凭证保存在 `~/.zcode`）。
3. 在对话面板的设置页或「切换智能体」命令里选 **ZCode**。

**其他 ACP 代理**：在设置 `harnessDeck.backends` 里加一项，写上名称和以 ACP 模式启动它的命令。`id` 和内置 ACP 项相同（`opencode`、`antigravity`）时替换内置项，例如写上完整路径或环境变量：

```json
"harnessDeck.backends": [
  { "name": "Gemini CLI", "command": "gemini", "args": ["--experimental-acp"] },
  { "id": "opencode", "name": "OpenCode", "command": "/usr/local/bin/opencode", "args": ["acp"] }
]
```

两种底层都需要**信任工作区**：代理会在工作区里读写文件、执行命令。

## 使用

- **打开对话**：右侧辅助侧边栏（Secondary Side Bar）里的 Halo 视图，或命令「Halo: 打开对话」。Enter 发送，Shift+Enter 换行；回复时继续发送的消息会排队。
- **切换底层**：第一次打开面板时会让你选底层（显示每个底层是否已安装、没装时的安装命令）；之后在首页点底层标签，或「…」→「底层」切换。同一时间运行一个底层，每个底层的会话分开保存。
- **上下文**：输入框上方显示当前编辑器——有选区时附带选中的代码和行号，否则只附带文件路径。点一下标签这条消息就不附带。
- **标签**：顶部标签可以拖动调整顺序；右键标签可关闭当前、左侧、右侧、其他或全部标签。关闭只是收起标签，会话仍保留，可从会话列表重新打开。
- **删除会话**：工作台「会话」按项目分组列出历史会话；悬停条目右侧的删除按钮，或右键选择「删除会话」，确认后从列表移除并关闭对应标签（运行中的会话需要结束后才能删除）。删除只影响面板列表，不会删除底层（`~/.claude`、`~/.codebuddy` 等）的历史文件。
- **会话排序**：项目内的会话按首次创建时间倒序排列；之后无论哪个会话有新活动，列表位置都不再变化。
- **`@` 引用文件、`/` 命令**：`/explain`、`/fix`、`/test`、`/new`，以及底层自己的命令。
- **编辑器右键「Halo」**：解释、修复、写测试、添加到对话。
- **图片**：在输入框里粘贴截图或图片（底层支持时）。
- **改动**：修改文件的那一行显示增删行数，点击在 Diff 编辑器里查看。
- **审批**：底层要执行需要确认的操作时，对话末尾出现审批卡片。
- **模型、模式**：输入框工具条切换模型（上方选择模型、下方滑动调整思考等级）和权限 / 模式。ACP 底层的模型是按会话设置的：新对话沿用你上次选的模型和思考等级，已有会话保持自己的。
- **官方账号与渠道管理**：在「设置 → Agent → 账号」中可为 Claude Code、Codex、CodeBuddy、Antigravity、Pi、OpenCode、DeepSeek 等智能体登录并管理多个官方渠道账号（支持独立凭据隔离、可选独立会话历史与按账号查询订阅额度），并可在设置页、模型选择器顶部或命令面板随时将智能体在「官方账号」与「第三方服务商」之间一键切换。Antigravity 等需要回填授权码的官方登录，会在浏览器授权后于登录弹窗中提示粘贴授权码（或回调页完整网址），提交后才算登录成功。
- **外观、字体和排版**：设置 → 外观中可切换浅色 / 深色 / 跟随系统主题，以及阅读与聊天排版参数。
- **滚动到底部**：往上翻看历史时右下角出现「↓」按钮，有新内容时带提示点，点一下回到底部并继续跟随。

### 不同底层的差别

| 功能 | DeepSeek | Pi | ZCode | Claude | Codex | CodeBuddy | ACP（OpenCode / Antigravity） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 流式回复、推理、工具行、审批、待办、停止 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 文件修改的增删行数和 Diff | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 切换模型、思考等级、模式（计划模式） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅（视代理而定） |
| 会话列表、重新打开历史会话 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 图片 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 同时在几个会话里回复 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 多开标签（后台会话继续回复） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 会话改动栏（本会话改过的文件，点开看累计 Diff） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 每轮改动汇总，以及命令（如 `sed`、脚本）造成的改动 | ✅ | — | — | — | — | — | — |
| 消息插队 | ✅ | ✅ | ✅ | — | ✅ | — | — |
| 子代理卡片 | ✅ | — | — | — | ✅ | ✅ | — |
| 提问卡片 | ✅ | — | ✅ | — | ✅ | — | — |
| `/goal` | ✅ | — | — | — | — | — | — |
| 在浏览器打开底层 Web UI | ✅ | — | — | — | — | — | — |
| 订阅额度 | — | — | — | ✅ | — | ✅ | Antigravity |
| 回合级回滚 | 文件（不回溯对话） | —（暂不支持） | —（暂不支持） | —（暂不支持） | —（暂不支持） | —（暂不支持） | —（暂不支持） |
| 独立 worktree 会话 | ✅（串行单工作区） | ✅（串行单工作区） | ✅（串行单工作区） | ✅（串行单工作区） | ✅（串行单工作区） | ✅（串行单工作区） | ✅（串行单工作区） |

能力由 [`packages/shared/src/capabilities.ts`](../shared/src/capabilities.ts) 的能力描述符统一声明；界面只读描述符，不再按底层 id 判断。新增或调整底层能力时，先改描述符，再同步这张表。

DeepSeek 的「恢复本轮文件」按记录的工具片段把最后一轮改过的文件写回本轮开始前；对话不会回退，操作前会弹窗确认，且不会覆盖有未保存内容的文件。其他底层暂不提供回合级回滚。

CodeBuddy 通过原生 `codebuddy -p` 流式协议接入，按活跃会话独立运行子进程，支持多标签并发回复，并直接扫描 `~/.codebuddy/projects` 回放历史会话。

OpenCode 支持 Build / Plan 模式与模型切换；Antigravity 只能用账号登录（不能绑定第三方服务商），并支持查询订阅额度。

## 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `harnessDeck.backends` | 空 | 额外的 ACP 底层：`name`、`command`、`args`、`env`、`installHint`；`id` 与内置 ACP 项（`opencode`、`antigravity`）相同时替换内置项 |
| `harnessDeck.dsh.path` | 空 | dsh 可执行文件路径；为空时在 `PATH` 中查找 |
| `harnessDeck.dsh.profile` | `web` | 启动 dsh 用的 profile，默认与你自己运行的 `dsh web` 共用设置 |
| `harnessDeck.claude.path` | 空 | Claude Code（`claude`）可执行文件路径；为空时自动查找 |
| `harnessDeck.codex.path` | 空 | OpenAI Codex（`codex`）可执行文件路径；为空时自动查找 |
| `harnessDeck.codebuddy.path` | 空 | CodeBuddy（`codebuddy` / `cbc`）可执行文件路径；为空时自动查找 |
| `harnessDeck.pi.path` | 空 | Pi（`pi`）可执行文件路径；为空时自动查找 |
| `harnessDeck.zcode.path` | 空 | ZCode 可执行文件或 `zcode.cjs` 路径；为空时自动查找 |
| `harnessDeck.context.includeActiveEditor` | `true` | 发送时默认附带当前编辑器 |
| `harnessDeck.ui.language` | `auto` | 界面语言：跟随 VS Code，或固定 `zh` / `en` |
| `harnessDeck.ui.fontSize` | `0` | 对话面板字号（px）；`0` 表示比 VS Code 工作台字号大 1px |
| `harnessDeck.ui.fontFamily` | 空 | 对话面板字体 |
| `harnessDeck.ui.theme` | `dark` | 界面主题：`dark`（深色，默认）、`light`（浅色）、`system`（跟随系统 / VS Code） |
| `harnessDeck.ui.codeFontFamily` | 空 | 代码、文件路径和命令输出的字体 |
| `harnessDeck.ui.showTurnChanges` | `false` | 每轮回复结束时在对话里显示改动文件卡片（dsh） |
| `harnessDeck.quota.enabled` | `true` | 自动探测并展示官方订阅用量/额度；关闭后不调用任何额度接口 |

从 DSH Copilot 升级时，原来的 `dsh.*` 设置会在第一次启动时自动搬到 `harnessDeck.*` 下。DSH Copilot 是另一个扩展 id，升级后可以把它卸载。

## 常见问题

- **右键菜单里还有「DSH」、侧边栏多一个面板**：旧版扩展 DSH Copilot 还装着。Halo 启动时会提示卸载，也可以在扩展视图里搜索 DSH Copilot 卸载。
- **「找不到 dsh / omp / codebuddy / claude-agent-acp」**：确认终端里能运行；VS Code 从图形界面启动时可能读不到 shell 里设置的 `PATH`，这时写完整路径（`harnessDeck.dsh.path`，或在 `harnessDeck.backends` 里用相同 `id` 覆盖内置项，写上 `command` 的完整路径）。
- **启动失败**：「…」→「查看日志」看插件日志；底层自己的输出在输出面板的「Halo: Backend」里（令牌和 Key 已脱敏）。
- **oh-my-pi 回复报错**：多半是模型提供方没配好，在终端里运行 `omp` 先确认能对话。
- **Claude 提示需要登录**：在终端运行 `claude` 并输入 `/login`，或给内置的 `claude` 配置 `ANTHROPIC_API_KEY`（见上面的「用 Claude」）。
- **CodeBuddy 登录**：取消了登录方式选择或进度，下次发消息时会再问。浏览器登录不方便时用 `CODEBUDDY_API_KEY`（见上面的「用 CodeBuddy」）。

## 手机端远程互通（PWA + 局域网 / 快速公网 / Tailscale / 隧道）

- **开启与扫码自动配对**：在「设置 → 远程互通」、顶部标题栏远程快捷入口或命令面板（「Halo: 开启/关闭手机端远程互通」）启用宿主内嵌 HTTP/WS 桥接（默认关闭）；扫码打开后自动完成配对，一次性短效配对码通过 URL `#fragment` 传递并在换取 `HttpOnly` 设备 Cookie 后立即作废。
- **跨网、公网与无缝切换**：支持局域网多网卡选择、一键启动本机 `cloudflared` 临时公网 HTTPS 隧道（`*.trycloudflare.com`，零账号开箱即用）、`tailscale serve` MagicDNS HTTPS 或自带 HTTPS 隧道；手机端在不同入口间切换时通过 90 秒一次性 `#handoff=` 票据自动续签登录态，无需重新扫码。
- **权限、设备管理与安全边界**：支持 `read-only`（只读查看会话与 Diff）和 `operate`（对话、审批、Git 提交/推送/PR）两种作用域，已配对设备支持随时重命名、实时切换权限（立即对活跃 WebSocket 生效）及单独吊销或全部断开；安装底层、修改服务商/MCP/技能/远程管理等高危操作在远程默认屏蔽。
- **离线容错与主流 IM 推送**：内置断网/切后台幂等消息暂存队列（重连后按序自动补发）、响应式布局、PWA 主屏安装、内嵌 Diff 审阅、本地 VAPID Web Push，以及飞书、企业微信、钉钉、Telegram、Slack、Discord、Bark、ntfy 与自定义 Webhook 推送（携带可直达对应会话的完整链接，桌面 IDE 聚焦时默认静默）。
- **独立守护进程**：需要脱离 IDE 常驻时，可运行 `node dist/sidecar.cjs --headless-server <configRoot> <projectPath> [port]`（配合 `--headless-status` / `--headless-stop` 查看或停止）。

## 隐私

插件本身不发网络请求：模型请求都由底层发出。随消息附带的上下文是你在输入框上方看到的那些标签，可以逐条关闭。

---

## English

A VS Code chat panel for coding agents: streaming replies, compact tool rows, approvals, questions, and VS Code diffs for every change. The agent behind the panel is switchable: native **DeepSeek** (`dsh`), **Claude Code** (`claude -p`), **Codex** (`codex app-server`), **CodeBuddy** (`codebuddy -p`), **Pi** (`pi --mode rpc`), and **ZCode** (`zcode app-server --stdio`), plus any [Agent Client Protocol](https://agentclientprotocol.com) (ACP) agent — **OpenCode** (`opencode acp`) and **Antigravity** (`agy acp`) are built in. Formerly **DSH Copilot**.

**Setup**: install at least one backend (via npm or one-click install in Settings → Agents) and sign in with its CLI or bind a model provider in Settings → Providers:

- **DeepSeek (`dsh`)**: DeepSeek Desktop → "Manage dsh command…", or `npm install -g @deepseek-ai/dsh`.
- **Claude Code**: `npm install -g @anthropic-ai/claude-code`, then `claude` → `/login` (or set `harnessDeck.claude.path`).
- **Codex**: `npm install -g @openai/codex`, then `codex login` (or set `harnessDeck.codex.path`).
- **CodeBuddy**: `npm install -g @tencent-ai/codebuddy-code`, then run `codebuddy` to sign in (or set `harnessDeck.codebuddy.path`). Runs natively via `codebuddy -p` with concurrent multi-session tabs and `~/.codebuddy/projects` history replay.
- **Pi**: `npm install -g @earendil-works/pi-coding-agent`, then `pi` → `/login` (or set `harnessDeck.pi.path`).
- **ZCode**: install ZCode Desktop or `npm install -g zcode-app-cli` (or set `harnessDeck.zcode.path`).
- **ACP agents**: **OpenCode** (`npm install -g opencode-ai`) and **Antigravity** (`agy acp`) are built in; add more in `harnessDeck.backends` (`name`, `command`, `args`, `env`). The workspace must be trusted.

**Differences**: all backends support streaming, tool rows, approvals, to-dos, stop, diffs, models/modes, session history, concurrent multi-tab sessions, session changes bar, and serial worktree sessions. Message steering is supported on DeepSeek, Pi, ZCode, and Codex; subagent cards on DeepSeek, Codex, and CodeBuddy; question cards on DeepSeek, ZCode, and Codex; subscription quota on Claude Code, CodeBuddy, and Antigravity; per-turn file rollback, `/goal`, and the browser Web UI link are DeepSeek-only.

**Settings**: `harnessDeck.backends`, `harnessDeck.accounts`, `harnessDeck.backendChannels`, `harnessDeck.providers`, `harnessDeck.dsh.path`, `harnessDeck.dsh.profile`, `harnessDeck.claude.path`, `harnessDeck.codex.path`, `harnessDeck.codebuddy.path`, `harnessDeck.pi.path`, `harnessDeck.zcode.path`, `harnessDeck.context.includeActiveEditor`, `harnessDeck.ui.language`, `harnessDeck.ui.fontSize`, `harnessDeck.ui.fontFamily`, `harnessDeck.ui.codeFontFamily`, `harnessDeck.ui.showTurnChanges`, `harnessDeck.quota.enabled`.

**Official Accounts & Channel Switching**: manage multiple official accounts per agent under Settings → Agent → Accounts (isolated config directories / credential slots / official API keys with optional isolated sessions and per-account subscription quota) and switch any agent between official accounts and third-party providers from Settings, the Model Picker header, or the Command Palette (`Switch Model Channel / Official Account`). For sign-ins that require pasting an authorization code (e.g. Antigravity), the sign-in dialog asks for the code (or the callback page URL) after browser authorization and only reports success once it is submitted.

**Mobile Remote Access (PWA + LAN / Quick Tunnel / Tailscale / BYO Tunnel)**: disabled by default. Enable from Settings → Mobile Remote, the IDE header remote popover, or `Halo: Toggle Mobile Remote Access`; scanning the 5-minute single-use QR link (`#code=` fragment) auto-pairs your phone browser or installed PWA. Supports one-click `cloudflared` Quick Tunnel (`*.trycloudflare.com`), Tailscale `serve`, custom HTTPS tunnels, seamless cross-route session handoff (`#handoff=` single-use ticket), offline idempotent outbox queuing during reconnects, live `read-only` / `operate` scope switching and device renaming, per-device revocation, in-app Diff review, local VAPID Web Push, and IM Webhooks (Feishu, WeCom, DingTalk, Telegram, Slack, Discord, Bark, ntfy, custom) with deep links directly to the active session. Standalone headless mode is also available via `node dist/sidecar.cjs --headless-server <configRoot> <projectPath> [port]`.

**Privacy**: the extension itself makes no network requests; the backend makes all model requests. Only the context chips you see above the input box are attached to a message.
