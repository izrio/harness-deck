# 更新记录 / Changelog

## 0.20.0

### 中文

- **云端开发环境（Google Colab / 远端 Linux）**：左下角「切换项目」弹出层、侧边栏菜单与「设置 → 项目」全面支持本地项目与云端环境原地一键切换；本地宿主内置代理客户端直连远端 `halo-server`（VS Code / JetBrains / Desktop 三端一致生效、零 Webview CSP 限制），支持云端多目录切换、断线自动重连与随时一键切回本地；无头服务新增 `--cloud` 预设（`owner` 权限 + 自动 `cloudflared` 隧道）并附 Google Colab 一键模板 `docs/colab/halo-colab.ipynb`。
- **工作区文件管理升级（本地 + Google Drive / Google Cloud Storage / WebDAV）**：右侧工作区「文件」面板新增本地工作区与远端存储源统一切换，支持面包屑导航、文本高亮预览、上传、下载、新建文件夹与二次确认删除；接入弹窗采用带离线品牌图标的厂商卡片选择与一键跳转浏览器登录授权（支持本地 OAuth 2.0 PKCE 回环回调与本机 `gcloud` ADC 零配置接入，手动 JSON / Token 折叠为高级项），本地文件操作强制 `realpath` 防符号链接逃逸校验。
- **Git 工作台增强（提交历史、贮藏 Stash 与高级操作）**：右侧 Git 面板新增提交日志与单提交文件 Diff 查看、Stash 贮藏列表与保存/应用/弹出/删除、Amend 修订上次提交、分支重命名/合并/变基、Cherry-pick / Revert / Reset 以及冲突态继续/中止闭环。
- **连接与额度稳定性优化**：增强代理感知 WebSocket 建连与 IM 机器人适配稳定性，优化 Antigravity 额度查询路径与标签栏/右键菜单交互。

### English

- **Cloud Development Environments (Google Colab / Remote Linux)**: Unified Local Projects and Cloud Environments inside the bottom-left Project Switcher, sidebar menu, and Settings → Projects; added a host-side WebSocket proxy (`CloudHostClient`) so VS Code, JetBrains, and Halo Desktop connect seamlessly to remote `halo-server` hosts with zero Webview CSP friction, remote subfolder switching, automatic reconnect, and one-click return to local workspaces. Added `--cloud` preset (`owner` scope + auto `cloudflared` quick tunnel) to headless server and a ready-to-use Colab template at `docs/colab/halo-colab.ipynb`.
- **Workspace Files Overhaul (Local + Google Drive / Google Cloud Storage / WebDAV)**: Added unified local and remote storage browsing in the Workspace Files panel with breadcrumbs, inline text preview, upload, download, new folder, and confirmed delete; added provider brand cards with offline logos and one-click browser sign-in (local OAuth 2.0 PKCE loopback + zero-config `gcloud` ADC detection, with manual JSON/Token tucked under Advanced) plus `realpath` symlink-escape protection for local workspace operations.
- **Git Workbench Expansion (Commit Log, Stashes & Advanced Ops)**: Added commit history browsing with per-commit file diffs, Stash management (save/apply/pop/drop), commit amend, branch rename/merge/rebase, cherry-pick/revert/reset, and in-progress conflict continue/abort controls.
- **Connectivity & Quota Refinements**: Hardened proxy-aware WebSocket handling for IM bot adapters, streamlined Antigravity quota probing, and refined tab bar and context-menu guards.

## 0.19.0

### 中文

- **IM 机器人双向聊天（企微 / 飞书 / 钉钉 / Telegram）**：支持零公网 IP 长连接与长轮询接入企业微信智能机器人、飞书 / Lark 自建应用、钉钉 Stream 机器人与 Telegram Bot；内置 6 位一次性 `/pair <码>` 授权配对、免配对白名单、群聊 `@机器人` 防误触发、跨底层流式回复、审批与提问卡片直接回复，以及 `/status`、`/new`、`/stop`、`/sessions`、`/switch` 等远程指令。
- **远程互通模块逻辑与顺序重构**：拆分为「手机网页 / IM 机器人 / 消息推送」三大独立分栏；手机网页按「桥接开关 → 1. 选择入口（4 选 1 卡片）→ 2. 扫码配对（含就近权限选择与外网路由自动同步）→ 3. 已授权设备」线性引导，开启 Tailscale Serve 时自动拉起本地桥接；IM 机器人调整为「先配置通道 → 再授权配对与管理用户」，消息推送按「推送策略 → 推送渠道」分层并支持折叠未启用的 Webhook 表单。
- **多账号管理升级（Account Cockpit）与会话级渠道隔离**：官方账号新增标签、备注、禁用、搜索与按配额/健康度排序、低配额/过期自动切号与定时刷新，以及兼容 cockpit-tools 的导入/导出备份（默认脱敏不含凭据）；新增跨工具与单会话级官方账号/服务商渠道路由及 `ProviderProxy` 模型作用域隔离，多标签并发切换互不串扰。

### English

- **IM Bot Bidirectional Chat (WeCom / Feishu / DingTalk / Telegram)**: Added zero-public-IP long-connection and long-polling adapters for WeCom AI Bot, Feishu / Lark, DingTalk Stream, and Telegram Bot with 6-digit `/pair <code>` authorization, allowlists, group `@mention` guard, cross-backend streaming replies, approval/question responses, and `/status`, `/new`, `/stop`, `/sessions`, `/switch` commands.
- **Remote Access Flow & Architecture Overhaul**: Reorganized Remote Access into three independent tabs (Mobile Web, IM Bots, Push Alerts); streamlined Mobile Web into a linear Bridge → 1. Access Route selector (auto-syncing active tunnels and auto-starting the bridge on Tailscale Serve) → 2. QR Pairing with inline permission scope → 3. Authorized Devices flow, reordered IM Bots to Channels → Pairing & Users, and separated Push Policy from Push Channels.
- **Account Cockpit & Per-Session Channel Isolation**: Added account tags, notes, disable toggles, search/quota sorting, low-quota/expiry auto-switch with scheduled quota refresh, and cockpit-tools-compatible import/export backups; added cross-tool and per-session channel bindings with scoped `ProviderProxy` model mapping so parallel tabs and agents never interfere.

## 0.18.2

### 中文

- **设置页 macOS 风格视觉升级与全局留白对齐**：所有设置分组统一采用无外框柔和浅底圆角卡片 + 卡片内缩极细横线分割与宽松行距；精简服务商页与项目页冗余小字与嵌套胶囊，移除运行时「运行保活中」标签并列齐安装版本号；全局优化对话输入框、模型选择器倍率基线、顶部标签栏、工作台与下拉菜单文字对齐与呼吸感。
- **远程推送 Webhook 渠道深度适配与官方图标**：9 种推送渠道（Bark、ntfy、飞书、企业微信、钉钉、Telegram、Slack、Discord、自定义 JSON）支持官方离线厂商图标、独立配置保存、渠道专属字段表单、实时格式校验与问号 `Popover` 配置说明。
- **首次启动默认智能体与 WSL2 市场连通性修复**：未配置默认运行时时首次启动默认启用 `claude`；修复纯 Node.js（VS Code Remote-WSL）下代理隧道并发连接、自动 `gzip`/`deflate`/`br` 解压、30x 重定向以及 WSL2 NAT 回环代理与 IPv6 黑洞回退，解决 WSL 下技能市场与 MCP 市场连不上的问题。

### English

- **macOS-Style Settings & Global UI Spacing Polish**: Unified all Settings sections with borderless soft-tinted rounded cards, inset hairline dividers, and generous row breathing room; decluttered Providers and Projects views, removed the background keep-alive badge and column-aligned runtime versions, and refined text baseline alignment across the composer, model multipliers, tabs, menus, and workbench.
- **Tailored Remote Push Webhook Channels & Official Logos**: Added official offline brand logos, per-channel persisted configs, tailored input fields, live format validation, and `?` help popovers for all 9 push channels (Bark, ntfy, Feishu, WeCom, DingTalk, Telegram, Slack, Discord, and Custom JSON).
- **Default Startup Backend & WSL2 Marketplace Connectivity**: Set `claude` as the first-launch default backend when unconfigured; hardened pure Node.js (`VS Code Remote-WSL`) proxy tunneling with `agent: false`, automatic `gzip`/`deflate`/`br` decompression, redirect following, and WSL2 NAT loopback-proxy / IPv4 fallbacks so Skill and MCP marketplaces connect reliably in WSL.

## 0.18.1

### 中文

- **Antigravity 订阅额度查询完善**：新增官方 `agy -p /usage --output-format json` 回退查询与 5 分钟并发去重缓存，兼容 OS Keyring 凭据托管、`jetski-standalone-oauth-token`、`access_token` 过期自动续期及 0% 剩余额度省略字段；修复 Keyring 场景下账号巡检误判未登录并冲掉额度的问题。
- **订阅用量开关设置**：设置页（会话 → 会话）新增「获取订阅用量」开关（对应 `harnessDeck.quota.enabled`，默认开启）；关闭后立即隐藏底栏用量标识，彻底跳过用量探测且不调用任何额度接口或 CLI 查询命令。

### English

- **Antigravity Quota Reliability**: Added official `agy -p /usage --output-format json` fallback with 5-minute caching and in-flight deduplication, supporting OS Keyring credentials, `jetski-standalone-oauth-token`, expired access tokens, and omitted `0%` fields; prevented Keyring accounts from being downgraded to unauthenticated.
- **Subscription Usage Toggle**: Added a "Fetch subscription usage" switch in Settings (`harnessDeck.quota.enabled`, enabled by default) that hides the usage badge and skips all quota API and CLI probes when turned off.

## 0.18.0

### 中文

- **内置浏览器 Chrome 风格控制台**：升级对象懒加载展开树、`console.table`、分组与调用栈、正则/负向词/级别筛选、设置与右键菜单，以及支持多行输入、实时补全和 `$0` 联动的 REPL。
- **CodeBuddy 模型倍率与用量校准**：模型选择器新增计费倍率显示（如 `0.29x`），并修复 CodeBuddy 缓存输入重复计入及多阶段 `turnUsage` 上下文占用偏差。
- **Antigravity 订阅额度修复**：修复默认账号未展示额度问题，补齐本地凭据回退、Refresh Token 刷新与备用端点容错，确保状态栏稳定展示额度。

### English

- **Chrome-Style Browser Console**: Added lazy expandable object trees, `console.table`, groups, stack traces, regex/negative/level filters, and a multiline REPL with live completion and `$0`.
- **CodeBuddy Multipliers & Usage**: Displayed model billing multipliers (e.g. `0.29x`) in the model picker, and fixed cached-input double counting and multi-stage context usage.
- **Antigravity Quota Fix**: Fixed missing quota display for default accounts with credential fallback, refresh-token renewal, and fallback endpoint resilience.

## 0.17.0

### 中文

- **内置浏览器高清渲染与 DevTools**：支持最高 2x DPR 高清画面、剪贴板快捷键与右键菜单，新增可停靠 DevTools（Elements、Console、Network）。
- **双模式订阅余量与动画刷新**：新增积分余额模式（如 CodeBuddy 积分胶囊与能量条），每轮对话结束自动刷新并播放数字和进度动画。
- **分支删除与全局 ScrollArea**：底栏与 Git 面板支持删除本地分支（含二次确认与 `-D`），全局滚动区统一升级为 `shadcn-ui` `ScrollArea`。
- **权限与多账号隔离修复**：回复中切换权限改为下一轮生效，修复菜单双高亮背景及多账号切换额度串号问题。

### English

- **Browser HiDPI & DevTools**: Added up to 2x DPR rendering, clipboard shortcuts, context menu, and dockable DevTools (Elements, Console, Network).
- **Dual-Mode Quota & Animations**: Added credits balance mode (e.g. CodeBuddy pill and energy gauge) with per-turn refresh and animated transitions.
- **Branch Deletion & ScrollArea**: Added local branch deletion (with confirmation and `-D`) and rolled out `shadcn-ui` `ScrollArea` across panels.
- **Permissions & Account Isolation**: Deferred mid-turn permission edits to next turn; fixed double menu highlights and multi-account quota leakage.

## 0.16.0

### 中文

- **移动端远程体验强化**：新增断线暂存补发队列、扫码自动配对、通知直达会话、跨入口 `#handoff=` 续签、一键 `cloudflared` 隧道及 9 种 IM Webhook 预设。
- **设置页重构与初始化引导**：设置页采用去线留白层级重构，服务商编辑改为带厂商图标的弹窗；无可用运行时展示独立初始化引导页。
- **在线市场代理与稳定性修复**：技能与 MCP 市场支持代理并接入 `skills.sh` 与 MCP v0.1 注册表；修复 WSL2 浏览器启动崩溃与新建会话 `auto` 权限回退。

### English

- **Mobile Remote Access Overhaul**: Added offline outbox, QR auto-pairing, notification deep-links, `#handoff=` renewal, `cloudflared` tunnel, and 9 IM webhooks.
- **Settings Redesign & Runtime Setup**: Rebuilt Settings with borderless layouts and vendor-logo provider dialogs; added a Runtime Setup onboarding page.
- **Proxy Marketplaces & Fixes**: Routed `skills.sh` and MCP v0.1 marketplaces through host proxy; fixed WSL2 browser crashes and `auto` permission resets.

## 0.15.1

### 中文

- **发版流水线修复**：移除桌面端 `electron` peerDependency 引发的类型冲突，修复干净 CI 环境下 `pnpm typecheck` 失败问题。
- **三平台桌面端安装包上线**：GitHub Release 同步发布 Windows（`.exe`）、macOS（`.dmg`/`.zip`）与 Linux（`.AppImage`）安装包，并包含 0.14.0/0.15.0 全部更新。

### English

- **Release Pipeline Fix**: Removed the desktop `electron` peerDependency type conflict that broke clean-CI `pnpm typecheck` in 0.14.0 and 0.15.0.
- **Desktop Installers**: Added Windows (`.exe`), macOS (`.dmg`/`.zip`), and Linux (`.AppImage`) release builds alongside all 0.14.0 and 0.15.0 features.

## 0.15.0

### 中文

- **品牌升级为 Halo**：全端产品名统一更名为 Halo（保留 JetBrains 旧凭据兼容读取）。
- **右侧栏内置浏览器与 AI MCP 联动**：新增内置浏览器视图，支持 CDP 实时画面交互，并向智能体自动暴露浏览器 MCP 工具。
- **在线 MCP / 技能市场与本地导入**：拆分为「已安装 / 市场」双标签卡片，在线拉取官方注册表并支持离线兜底与本地 `SKILL.md` 一键导入。
- **设置页精简与图标统一**：精简冗余说明、统一行间分割线与运行时图标，修复多处界面对比度与移动端间距细节。

### English

- **Halo Rebrand**: Unified the product name to Halo across VS Code, JetBrains, desktop, Webview, and docs (keeping legacy JetBrains credential fallback).
- **Built-in Browser & MCP**: Added a right-panel CDP browser with live viewport interaction and automatic MCP tools for coding agents.
- **Live MCP / Skills Markets**: Split into Installed/Marketplace views with live registry fetching, offline fallback, and local `SKILL.md` import.
- **Settings Polish & Icons**: Decluttered Settings copy, unified dividers and runtime icons, and fixed contrast and mobile spacing issues.

## 0.14.0

### 中文

- **CodeMirror 6 编辑与增强 Diff**：支持按需分包的代码编辑/搜索/保存；Diff 新增 Split 并排、Shiki 高亮、词级差异、按 Hunk 暂存/撤销与行级批注。
- **Git 细粒度操作与 AI 草稿**：支持单文件暂存/撤销、目录树折叠、分支切换、AI 一键生成 Commit/PR 草稿，以及 PR 状态追踪与一键结单。
- **跨底层检查点与内置终端**：新增基于隐藏 Git ref 的多回合检查点回滚、会话分叉与原地重跑；右侧栏新增跨平台内置终端与全局 `Ctrl/Cmd+K` 命令面板。
- **桌面壳、主题预设与工程升级**：新增 Electron 独立桌面壳、5 套 OKLCH 主题预设与移动端 Bottom Sheet，并从 ESLint 迁移至 `oxlint --type-aware`。

### English

- **CodeMirror 6 & Enhanced Diff**: Added lazy CodeMirror 6 editing/saving plus Split Shiki diffs, word highlights, per-hunk staging, and line comments.
- **Git Actions & AI Drafts**: Added per-file stage/discard, compact trees, branch switching, AI Commit/PR drafts, and PR check tracking with settlement.
- **Checkpoints, Terminal & Palette**: Added hidden-ref Git checkpoints, session fork/edit-resend, right-panel xterm terminal, and `Ctrl/Cmd+K` palette.
- **Desktop Shell, Themes & Oxlint**: Added the Electron desktop shell, 5 OKLCH presets, mobile bottom sheets, and migrated linting to `oxlint --type-aware`.

## 0.13.0

### 中文

- **内置文件 / Diff 查看器与 IDEA 风格 Git**：右侧栏升级为文件/Git 双标签与离线 VS Code 文件图标，内置查看文件与 Diff，重构紧凑 Git 工具栏与提交坞。
- **四列任务看板与 Worktree 隔离**：合并定时任务进四列看板，新建任务支持一键开启 Git Worktree 隔离与定时调度。
- **上下文性能指标**：跨底层采集并展示缓存命中比例、首字耗时（TTFT）与生成速度（`tok/s`）。
- **多账号修复与默认深色主题**：修复 Antigravity/Claude 误报过期与 CodeBuddy 多账号接入，ZCode 支持第三方服务商，默认主题改为深色。

### English

- **Built-in Viewer & IDEA-Style Git**: Added right-panel Files/Git tabs with offline file icons, built-in file/diff viewer, and a compact Git dock.
- **4-Column Kanban & Worktrees**: Merged schedules into a 4-column task board with integrated Git worktree isolation and scheduled runs.
- **Context Performance Metrics**: Surfaced cache hit ratio, TTFT, and output speed (`tok/s`) across backends in the context popover.
- **Account Fixes & Dark Default**: Fixed Antigravity/Claude false-expired status and CodeBuddy multi-account login, added ZCode providers, and defaulted to dark mode.

## 0.12.0

### 中文

- **视觉体系重构**：全新 Quiet Zinc 浅色 / Cool Slate 深色配色、玻璃质感浮层与抽屉滑入动效，统一阴影与排版层级。
- **后端版本管理弹窗**：设置页底层安装与版本切换改为独立弹窗，展示当前版本、可选版本列表及复制安装指引。
- **官方登录授权码回填**：支持在浏览器授权后于登录弹窗直接回填授权码或回调网址（如 Antigravity `agy acp --login`）。

### English

- **Visual System Refresh**: Introduced Quiet Zinc light and Cool Slate dark palettes, glass overlays, drawer motion, and unified typography.
- **Backend Version Dialogs**: Moved backend install and version switching into dedicated dialogs with version pickers and copyable fallback commands.
- **Auth-Code Sign-In Paste**: Added authorization-code/callback-URL input in sign-in dialogs for CLIs requiring paste-back (e.g. `agy acp --login`).

## 0.11.0

### 中文

- **官方多账号管理**：新增「设置 → Agent → 账号」，支持为 Claude、Codex、CodeBuddy、Antigravity、Pi、OpenCode、DeepSeek 等登录和管理多个官方账号。
- **凭据与会话隔离**：按底层能力提供配置目录、凭据槽位或 API Key 隔离，支持独立会话历史与按账号查询订阅额度。
- **渠道一键切换**：支持在设置页、模型选择器顶部或命令面板随时在官方账号与第三方服务商之间切换。

### English

- **Official Multi-Account Management**: Added Settings → Agent → Accounts to sign in and manage multiple official accounts across supported backends.
- **Credential & Session Isolation**: Isolated accounts via config dirs, credential slots, or API keys with optional isolated history and per-account quota.
- **One-Click Channel Switching**: Switch any backend between official accounts and third-party providers from Settings, Model Picker, or Command Palette.

## 0.10.0

### 中文

- **三栏工作台重构**：重构为「左侧项目/会话侧边栏 + 中央对话区 + 右侧文件与 Git 面板」布局，会话模块更名为「项目」并支持状态筛选。
- **ZCode Protocol v1 适配**：全面兼容 ZCode Protocol v1 的会话创建、订阅、流式推理/正文、工具状态、模型推理等级及 V4 审批与提问响应。

### English

- **Three-Pane Workbench Overhaul**: Rebuilt layout into left project/session sidebar, center chat, and right Files & Git panel with status filters.
- **ZCode Protocol v1 Support**: Updated ZCode session creation, streaming deltas, tool statuses, reasoning levels, and V4 approval/question schemas.

## 0.9.2

### 中文

- **WSL 宿主机局域网 IP 识别**：WSL 下自动过滤虚拟网卡并优先使用 Windows 物理局域网 IP 生成配对地址，兼容镜像网络模式。
- **WSL2 NAT 转发检测与引导**：自动检查 Windows `portproxy` 转发状态，并在设置页提供一键复制的 PowerShell 转发与防火墙命令。

### English

- **WSL Host LAN IP Detection**: Automatically detects and prefers the Windows physical LAN IP over unreachable WSL virtual IPs for QR pairing.
- **WSL2 NAT Port-Forwarding Guide**: Checks Windows `netsh portproxy` rules and provides a copyable PowerShell command for forwarding and firewall setup.

## 0.9.1

### 中文

- **修复 VS Code 面板空白回归**：修复 0.9.0 重复调用 `acquireVsCodeApi()` 导致页面抛错空白的问题，确保单页面严格仅获取一次实例。
- **回归测试加固**：在单测与 E2E 的 `acquireVsCodeApi` 模拟中强制校验单次调用约束并补充重挂载回归用例。

### English

- **Fix Blank VS Code Panel**: Fixed a 0.9.0 regression calling `acquireVsCodeApi()` twice and crashing the webview; enforced strict single acquisition.
- **Regression Guards**: Hardened unit and E2E mocks to assert single `acquireVsCodeApi()` invocation with remount regression tests.

## 0.9.0

### 中文

- **局域网远程互通与权限作用域**：新增宿主内嵌 HTTP/WS 远程桥接（默认关闭）、一次性 QR 配对及 `read-only` / `operate` 权限守卫。
- **移动端 PWA 与内嵌 Diff**：移动端适配 Sheet、软键盘安全区、PWA 主屏安装、推送深链直达会话及手机端内嵌 Diff 审阅。
- **跨网隧道、推送通知与无头守护**：支持 `tailscale serve` 与自带 HTTPS 隧道、本地 VAPID Web Push / Webhook 推送及 `--headless-server` 独立常驻模式。

### English

- **LAN Remote Bridge & Scopes**: Added opt-in host HTTP/WS bridge, single-use QR pairing, `ClientHub` multiplexing, and `read-only` / `operate` guards.
- **Mobile PWA & Inline Diff**: Added responsive mobile Sheets, keyboard-safe layout, PWA install, notification deep-links, and inline Diff review.
- **Tunnels, Push & Headless Daemon**: Added `tailscale serve` and BYO HTTPS tunnels, local VAPID Web Push/Webhooks, and `--headless-server` daemon mode.

## 0.8.0

### 中文

- **原生 OpenAI Codex 底层**：基于 `codex app-server` 原生接入，支持模型/推理档位、运行中 `turn/steer` 插队、审批、子代理、第三方服务商与 MCP 注入。
- **原生多会话 CodeBuddy 底层**：从单会话 ACP 升级为原生 `codebuddy -p` 双向流式协议，支持多标签并发、思考档位与本地历史秒开回放。
- **用量与额度标识统一**：重构 `ContextRing` 与 `UsageBadge` 为统一的图标 + 百分比样式，优化首轮明细去重与浮层高度自适应。

### English

- **Native OpenAI Codex Backend**: Integrated `codex app-server` with reasoning levels, live `turn/steer`, approvals, subagents, providers, and MCP.
- **Concurrent CodeBuddy Backend**: Upgraded CodeBuddy to native bidirectional `codebuddy -p` with multi-tab concurrency, effort levels, and history replay.
- **Unified Context & Quota UI**: Unified `ContextRing` and `UsageBadge` visuals with first-turn deduplication and viewport-aware popovers.

## 0.7.0

### 中文

- **统一能力模型与安装归属保护**：新增共享能力描述符驱动界面渲染；npm 安装/升级前校验归属防止覆盖外部安装，支持只读 HTTPS ACP 注册表发现。
- **回合模型、文件回滚与 Worktree**：统一输出回合编号，DeepSeek 支持恢复最后一轮改动文件，新增串行 Worktree 会话与清理入口。
- **工作台「改动」模块**：新增只读 Git 状态与 Diff 预览，受信任工作区支持提交、二次确认推送与基于 `gh` CLI 创建 PR。
- **可靠性与质量门禁**：新增幂等命令回执、JetBrains Sidecar 退避自启、无头后台定时调度，以及 i18n、性能基线与 `evals/` 门禁。

### English

- **Capabilities & Install Guards**: Added shared capability descriptors, npm ownership checks against external installs, and HTTPS ACP registry discovery.
- **Turns, Rollback & Worktrees**: Unified turn numbering, added DeepSeek turn file restore, and introduced serial Worktree sessions with cleanup.
- **Workbench Changes Module**: Added Git status and Diff preview plus trusted-workspace commit, confirmed push, and `gh`-backed PR creation.
- **Reliability & Quality Gates**: Added idempotent command receipts, JetBrains sidecar auto-restart, background scheduling, and i18n/perf/eval CI gates.

## 0.6.1

### 中文

- **重新发布 0.6.0 功能**：代码与 0.6.0 一致，仅提升版本号以重新执行发版流程，包含订阅额度标识、上下文用量明细与会话模型标签。

### English

- **Re-release of 0.6.0**: Identical code to 0.6.0 with a version bump to re-run the release pipeline (subscription quota, context breakdown, model labels).

## 0.6.0

### 中文

- **官方订阅额度标识**：输入框旁新增 `UsageBadge`，支持查看 Claude、Antigravity 与 CodeBuddy 的 5 小时/每周窗口额度与重置时间。
- **上下文用量明细**：悬停或点击上下文圆环可展开查看最近请求与会话累计的输入、缓存读写、输出占比条及费用。
- **会话模型标签**：会话历史列表逐条展示最近使用的模型，并在切换模型后实时同步。

### English

- **Subscription Quota Badge**: Added `UsageBadge` beside the composer showing 5-hour/weekly windows and reset times for Claude, Antigravity, and CodeBuddy.
- **Context Usage Breakdown**: Hovering or clicking `ContextRing` opens a popover with input/cache/output bars, reasoning tokens, totals, and cost.
- **Per-Session Model Labels**: Displayed each session's last-used model in history rows with live updates on model switch.

## 0.5.5

### 中文

- **npm 版本探测与代理修复**：跳过 `socks://` 代理防 npm 挂起，统一在主目录执行并缩短超时，展示详细版本拉取错误，同步 JetBrains 登录 shell 环境。
- **跨平台测试与 CI 修复**：修复 macOS `/var` 软链路径与 Windows 路径分隔符导致的单元测试失败。

### English

- **npm Lookup & Proxy Fixes**: Skipped `socks://` proxies, ran npm in homedir with tighter timeouts, surfaced fetch errors, and synced JetBrains shell env.
- **Cross-Platform CI Fixes**: Fixed unit tests for macOS `/var` symlinked temp dirs, WSL cache overrides, and Windows path delimiters.

## 0.5.4

### 中文

- **跨智能体统一标签栏**：不同底层的会话可并排打开在顶部标签栏并支持持久化恢复，切换底层不再清空已有标签。
- **共享加载动效与图标升级**：抽出 `LoadingState` 网格动效并在运行状态采用 Orbit 动效；底层图标切换为 SVG，设置页直接提供 dsh 网页入口。

### English

- **Unified Cross-Agent Tabs**: Kept sessions from different backends open side by side with persistence and cold-start restore.
- **Shared Loaders & SVG Logos**: Extracted `LoadingState` (using Orbit for run status), migrated backend logos to SVG, and exposed the dsh web link.

## 0.5.3

### 中文

- **Google Antigravity 原生支持**：内置 `antigravity`（`agy acp`）配置、图标与登录引导，适配其工具参数、Diff 格式与模型更新保护。
- **对话流视觉精简**：移除 `ThinkingTrace` 重复加载器，由底部 `RunStatus` 统一呈现运行态与计时。
- **服务商代理与运行时修复**：增强 Claude `--settings` 代理覆盖，修复 `NO_PROXY` 大小写去重、小模型误判及无人值守调度问题。

### English

- **Google Antigravity Support**: Added built-in `antigravity` (`agy acp`) backend, logo, login guide, and ACP tool/diff projection support.
- **Streamlined Thread Status**: Removed duplicate loaders from `ThinkingTrace` and unified running indicators and timers in `RunStatus`.
- **Provider Proxy & Runtime Fixes**: Added Claude `--settings` proxy overrides and fixed `NO_PROXY` deduplication, model routing, and runner stability.

## 0.5.2

### 中文

- **可折叠思考轨迹**：将连续工具操作与推理折叠为 `ThinkingTrace` 行，运行中自动展开计时、完成后自动收起并适配虚拟滚动。
- **首页快捷切换与布局打磨**：首页智能体芯片支持下拉直接切换；优化状态栏窄屏堆叠、侧栏排版与设置页分区样式。

### English

- **Collapsible Thinking Trace**: Grouped consecutive tool calls and reasoning into `ThinkingTrace` rows that auto-expand while running and collapse on finish.
- **Home Switcher & UI Polish**: Added a Home backend dropdown switcher, vertical narrow-width `StatusDock`, and unified Settings section layouts.

## 0.5.1

### 中文

- **对话虚拟滚动与 UI 规范**：长对话引入虚拟滚动提升性能；统一控件 4 档高度体系并全面迁移至离线按需打包 Iconify 图标。
- **WSL 与服务商代理增强**：新增 WSL 运行时发现与浏览器桥接，优化 OpenAI 转 Anthropic 代理稳定性与路径探测。

### English

- **Virtualized Thread & UI Standards**: Added virtualized chat scrolling, unified control height tiers, and migrated to offline bundled Iconify icons.
- **WSL & Provider Proxy**: Added WSL runtime discovery and browser bridging, and improved OpenAI-to-Anthropic converter stability.

## 0.5.0

### 中文

- **JetBrains IDE 插件与独立 Sidecar**：新增 JetBrains 插件（IDEA/WebStorm/PyCharm 等）及共享核心的 Node.js `sidecar.cjs` 进程。
- **原生多底层扩展**：新增 Claude Code、Pi 与 ZCode 原生适配器，支持自动定位可执行文件与默认底层配置。
- **工作台与生态管理**：上线工作台（总览、定时、智能体、看板、会话）、服务商代理与预设、MCP 及 Skill 管理。
- **前端组件体系重构**：全面基于 `shadcn-ui` 与 `beautifului` 重构界面，修复深色对比度与键盘导航并建立前端单测基线。

### English

- **JetBrains Plugin & Sidecar**: Launched the JetBrains IDE plugin (`JBCefBrowser` + `PasswordSafe`) sharing core host logic via `sidecar.cjs`.
- **New Native Backends**: Added native adapters for Claude Code, Pi, and ZCode with executable discovery and default-backend settings.
- **Workbench & Ecosystem**: Introduced the Workbench (Overview, Schedules, Agents, Tasks, Sessions), Provider Proxy, MCP, and Skill management.
- **UI Refactor & Testing**: Rebuilt views on `shadcn-ui` and `beautifului`, improved accessibility/contrast, and added a jsdom + Testing Library suite.

## 0.4.0

### 中文

- **启动与切换稳定性修复**：串行化快速底层切换，面板重新显示时自动启动缺失底层，修复退出残留与 Windows `.cmd` 路径空格问题。
- **ACP 安全对齐与输入防丢**：为 ACP 补齐未保存文件拦截、高权限确认与日志脱敏；发送失败自动保留草稿与队列消息。
- **状态栏整合与无障碍改进**：合并待办/未保存/改动为单行状态栏，新增代码路径点击跳转、回复复制按钮、4.5:1 对比度与读屏优化。

### English

- **Startup & Switching Fixes**: Serialized rapid backend switches, ensured launch on panel reveal, fixed exit leaks, and fixed Windows `.cmd` paths.
- **ACP Safety & Draft Guard**: Added unsaved-file blocking, dangerous-mode confirmation, and log redaction on ACP; preserved input/queues on failed sends.
- **Unified Status Bar & A11y**: Merged status strips into one row, added clickable file paths, reply copy, 4.5:1 contrast, and screen-reader polish.

## 0.3.2

### 中文

- **ACP 多标签与会话改动栏**：Claude、oh-my-pi、CodeBuddy 等 ACP 底层支持多开标签、累计改动 Diff 与沿用上次模型/思考等级。
- **斜杠补全、护眼配色与细节打磨**：修复 dsh `/` 技能补全与模糊匹配，默认启用护眼文字配色，新增回底按钮与 `backendTrace` 排查日志。
- **底层命名与清理**：内置 dsh 界面改称 DeepSeek，并提示一键卸载旧版 DSH Copilot 扩展。

### English

- **ACP Tabs & Changes Bar**: Added multi-tab sessions, cumulative session diffs, and remembered model/thought defaults for ACP backends.
- **Slash Skills, Soft Palette & Polish**: Fixed dsh `/` skill discovery, enabled soft reading colors by default, and added scroll-to-bottom and `backendTrace`.
- **Naming & Cleanup**: Displayed dsh as DeepSeek in the UI and offered one-click uninstall of the legacy DSH Copilot extension.

## 0.3.1

### 中文

- **新增内置 Claude 底层**：通过官方 ACP 适配器接入 Claude Code，共享本地登录与配置并展示官方图标。
- **ACP 登录引导与包名整理**：发消息遇需登录时自动触发登录或给出指引；内部包更名为 `@harness-deck/*` 并重写文档。

### English

- **Built-in Claude Backend**: Added Claude via its official ACP adapter, sharing local sign-in/settings with official branding.
- **ACP Sign-In & Package Rename**: Handled mid-chat auth prompts gracefully, renamed workspace packages to `@harness-deck/*`, and rewrote README.

## 0.3.0

### 中文

- **多底层架构与品牌升级**：更名为 Halo（扩展 ID 与设置迁移为 `harnessDeck.*`），支持切换 dsh、oh-my-pi、CodeBuddy 及任意自定义 ACP 代理。
- **新首页、标志与子代理卡片**：全新品牌标志、首次启动底层选择卡片与首页设计；dsh 子代理支持卡片展示与只读查看对话。
- **ACP 完整协议支持**：覆盖流式推理、工具行、Diff、审批、待办、用量、图片与 CodeBuddy 多种浏览器登录方式。

### English

- **Multi-Backend & Rebrand**: Renamed to Halo (`harnessDeck.*` settings migration) with switchable dsh, oh-my-pi, CodeBuddy, and custom ACP agents.
- **New Home, Logo & Subagents**: Added the new logo, first-run backend chooser, redesigned Home, and expandable read-only subagent cards.
- **Full ACP Support**: Added streaming, tool rows, diffs, approvals, to-dos, usage, images, and CodeBuddy browser/API-key sign-in.

## 0.2.3

### 中文

- **减少动画兼容**：系统开启「减少动画」时仍保留加载转圈与运行脉冲提示，仅停用骨架屏流光与光标闪烁。
- **行内代码配色修复**：行内代码不再沿用主题醒目橙色，改用正文色配柔和中性底色与边框。

### English

- **Reduced-Motion Support**: Kept spinners and running pulses active under OS reduced-motion settings while pausing shimmer and cursor blink.
- **Inline Code Styling**: Replaced harsh orange theme preformat text with neutral-tinted background and body-color inline code chips.

## 0.2.2

### 中文

- **图片粘贴与预览**：支持粘贴或 Shift 拖入图片发送给 dsh，对话中展示已发图片并支持点击放大查看。
- **面板内字体设置与网页登录修复**：支持在面板直接调整字号与字体并即时生效；修复「在浏览器中打开 dsh」因 `?token=` 转义导致的 401 失败。

### English

- **Image Paste & Preview**: Added screenshot/image paste and Shift-drag uploads with removable thumbnails and click-to-zoom preview.
- **In-Panel Fonts & Browser Auth Fix**: Added instant in-panel font/size controls and fixed `?token=` URL encoding causing 401 on Open in Browser.

## 0.2.1

### 中文

- **运行状态计时与工具别名**：对话末尾实时展示当前动作与已用时长；识别 `ops_*` / `mcp__*` 等带前缀工具并归类渲染。
- **交互体验升级**：提问卡片改为逐题向导、模型选择器支持级联思考等级、待办升级为时间线卡片，并动态挑选主题强调色。

### English

- **Run Status Timer & Tool Aliases**: Added live action/elapsed timer at thread bottom and normalized prefixed tools (`ops_*`, `mcp__*`) into standard rows.
- **Interaction Upgrades**: Added step-by-step question cards, cascading model/reasoning picker, timeline to-do cards, and reliable theme accent selection.

## 0.2.0

### 中文

- **多开标签会话与改动栏**：支持多标签并行会话与独立草稿，输入框上方新增会话改动栏展示累计 Diff。
- **更快的 Diff 与字号定制**：优先本地还原 Diff 提速并修复历史轮次对比目标；新增字号/字体设置与输入框高度拖拽调整。

### English

- **Multi-Tab Sessions & Changes Bar**: Added multi-tab chat sessions with per-tab drafts and a collapsible session changes bar for cumulative diffs.
- **Faster Diffs & Font Settings**: Rebuilt turn diffs locally for speed, fixed earlier-turn diff targets, and added font settings and resizable composer.

## 0.1.0

### 中文

- **首个可用版本（dsh 侧边栏对话）**：支持流式回复、代码高亮、推理折叠、会话管理、消息排队/插队、待办与计划模式标记。
- **工具改动与编辑器集成**：支持工具归类、VS Code Diff 审阅、审批与提问卡片、选区附带、`@` 文件引用、`/` 命令及多根工作区。
- **运行时守护与双语界面**：自动发现并守护 dsh 进程、引导配置 API Key、展示上下文环形用量并支持中英文界面。

### English

- **First Usable Release (dsh Chat)**: Added streaming Markdown chat, collapsible reasoning, session management, message queues, to-dos, and plan mode.
- **Tools, Diffs & Editor Integration**: Added grouped tool rows, VS Code diffs, approval/question cards, selection attach, `@` files, `/` commands, and multi-root support.
- **Runtime Supervision & Bilingual UI**: Added automatic dsh supervision, API-key onboarding, context ring usage, and Chinese/English localization.
