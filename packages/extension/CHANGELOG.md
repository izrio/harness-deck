# 更新记录 / Changelog

## 0.14.0

**内置 CodeMirror 6 代码编辑与增强 Diff 审阅、右侧栏内置终端、跨底层 Git 检查点回滚与会话分叉、多 Worktree 并行标签、全局命令面板（`Ctrl/Cmd+K`）、OKLCH 配色预设、Electron 独立桌面外壳与 Oxlint 工程升级**：全面对齐并补齐独立 AI 编程客户端核心闭环——文件查看器升级为懒加载 CodeMirror 6（支持编辑保存/搜索/折叠），Diff 支持 Split 并排对比、Shiki 词法着色、词级差异、按 Hunk 暂存/撤销与行级批注回传智能体；右侧栏新增「终端」标签页（位于 Git 右侧，零原生编译跨平台 PTY + xterm.js）；Git 面板补齐单文件暂存/撤销、分支切换/新建、Pull/Fetch、AI 一键生成 Commit/PR 草稿与 PR 状态追踪/一键结单；宿主层新增跨所有底层的 Git 隐藏 ref 多回合检查点回滚、会话分叉与原地编辑重跑；并完成全项目 `shadcn-ui` Select 与尺寸统一、Antigravity 多账号隔离/5h 用量修复、Electron 桌面壳（`packages/desktop`）以及 ESLint → Oxlint（`--type-aware`）迁移。

**Built-in CodeMirror 6 editor & enhanced Diff review, integrated right-panel Terminal, cross-backend Git checkpoints & session fork, parallel worktree tabs, global Command Palette (`Ctrl/Cmd+K`), OKLCH theme presets, Electron desktop shell & Oxlint migration**: Completes the end-to-end coding-agent review loop with lazy-loaded CodeMirror 6 editing/search/folding, Split/Unified Shiki-highlighted diffs with word-level highlights, per-hunk stage/discard and line-level review comments sent straight to the composer; adds a zero-native-build cross-platform Terminal tab to the right of Git in the right panel (PTY + xterm.js); expands Git with per-file stage/unstage/discard, branch switcher/creator, Pull/Fetch, AI/heuristic Commit & PR draft generation, and PR check tracking with one-click settlement; adds cross-backend multi-turn Git hidden-ref checkpoints, session fork and inline edit & re-run; unifies all selects/control sizes to `shadcn-ui`, fixes Antigravity multi-account slot isolation & 5h quota badge, adds the `packages/desktop` Electron shell, and migrates linting from ESLint to `oxlint --type-aware`.

- **CodeMirror 6 懒加载编辑与增强版 Diff 审阅（P0-1）**：文件预览升级为按需分包的 CodeMirror 6 编辑器，支持 `Ctrl/Cmd+F` 搜索、代码折叠、主题同步与 `Ctrl/Cmd+S` 保存（带工作区信任与符号链接越界保护）；Diff 查看器新增 Unified / Split 并排切换、CSP 安全的 Shiki 语法高亮、行内词级差异、按 Hunk 暂存/撤销（自动刷新 Diff）以及点击任意 Diff 行写批注直达输入框。
  **Lazy CodeMirror 6 editor & enhanced Diff review (P0-1)**: Upgraded file viewing to code-split CodeMirror 6 with `Ctrl/Cmd+F` search, folding, theme sync and `Ctrl/Cmd+S` save (guarded by workspace trust and symlink escape checks); upgraded the Diff viewer with Unified/Split toggle, CSP-safe Shiki syntax tokens, word-level diff highlights, per-hunk stage/discard with auto-refresh, and line-level review comments routed directly to the composer.
- **Git 细粒度操作、AI 草稿生成与 PR 追踪结单（P0-2 / P1-7）**：支持单文件暂存（`+`）、取消暂存（`-`）、撤销更改（`↩` 二次确认）、真实层级目录树（含 IDEA 风格单子目录折叠）、分支切换/新建与 Fetch/Pull；新增 AI 一键生成 Commit Message 与 PR 描述（优先直连已配置服务商，离线自动回退规则生成）；集成 `gh pr view` 展示 PR 状态与 CI 检查汇总，合并后支持一键结单（归档关联看板任务并可选清理 Worktree）。
  **Granular Git actions, AI drafts & PR tracking/settlement (P0-2 / P1-7)**: Added per-file stage/unstage/discard (with confirmation), hierarchical Git directory tree with compact folders, branch switcher/creator and Pull/Fetch; added one-click AI Commit Message & PR draft generation (direct provider first with offline heuristic fallback); integrated `gh pr view` status/CI checks and one-click settlement for merged PRs.
- **跨底层多回合 Git 检查点回滚、会话分叉与原地编辑重跑（P0-3）**：新增 `CheckpointManager`，通过临时 `GIT_INDEX_FILE` 将每回合快照写入隐藏 ref（不触碰用户暂存区，回滚前自动保留备份 ref），让所有底层统一支持多回合回滚；每轮底部支持「回滚到此轮」与「从此处分叉」，用户消息支持原地编辑并分叉重跑（可选同步回滚工作区文件）。
  **Cross-backend multi-turn Git checkpoints, session fork & edit-resend (P0-3)**: Added `CheckpointManager` using isolated temporary indexes and hidden Git refs (never touching user staging, with automatic pre-rollback backups) across all backends; added per-turn rollback and fork actions plus inline edit & fork re-run on user bubbles.
- **右侧栏内置终端、多 Worktree 并行与 `Ctrl/Cmd+K` 命令面板（P1-4 / P1-5 / P1-6）**：右侧面板扩展为「文件 | Git | 终端」三标签（`Ctrl/Cmd+J` 快捷切换），后端采用零原生编译的跨平台 PTY/Shell 引擎（内置 128KB 环形回滚缓冲），前端懒加载 `xterm.js`；新建 Worktree 会话独立开标签并展示分支徽章，切换标签不中断后台运行；新增基于官方 `shadcn` `CommandDialog` 的应用内全局命令面板（`Ctrl/Cmd+K`）。
  **Right-panel Terminal, parallel worktrees & `Ctrl/Cmd+K` Command Palette (P1-4 / P1-5 / P1-6)**: Expanded the right panel to Files | Git | Terminal (`Ctrl/Cmd+J`) powered by a zero-native-compile PTY/shell manager with 128KB scrollback and lazy `xterm.js`; worktree sessions now open independent branch-badged tabs without interrupting background tabs; added an in-app `Cmd/Ctrl+K` Command Palette built on official `shadcn` `CommandDialog`.
- **UI / 交互打磨、多账号修复、Electron 桌面壳与 Oxlint 迁移（P2 / P3）**：移动端 Dialog 自动转为贴底 Bottom Sheet；新增无闪烁主题切换（`.no-transitions`）、5 套精选 OKLCH 配色预设（Default / Grove / Ocean / Ember / Iris）、高对比度模式与离屏动画暂停（`IntersectionObserver`）；全项目原生 `<NativeSelect>` 统一迁移为 `shadcn` `Select`，修复输入框打字导致滚动条跳动、小屏 TabBar 过大、Antigravity 凭据槽位串号/隐藏 `3p` 额度池/自动拉取 Google 邮箱/支持编辑本机默认账号名及工具栏仅展示 5h 用量；新增 `packages/desktop` Electron 独立桌面外壳；修复 macOS CI `npmManager` 软链路径断言，并将项目 lint 工具链整体切换为 `oxlint --type-aware`（净减 81 个依赖包、提速 4–5 倍）。
  **UI polish, account fixes, Electron desktop shell & Oxlint migration (P2 / P3)**: Converted mobile dialogs into safe-area bottom sheets; added zero-flash theme switching, 5 curated OKLCH presets, high-contrast mode and offscreen animation pause; migrated all selects to `shadcn` `Select` and fixed composer scroll jumps, mobile TabBar sizing, Antigravity multi-account slot isolation, Google email auto-detection, system-default account rename and 5h-only usage badge; added the `packages/desktop` Electron shell; fixed macOS symlink resolution in `npmManager` and migrated ESLint to `oxlint --type-aware` (-81 packages, 4–5× faster).

## 0.13.0

**内置文件/Diff 查看器与 IDEA 风格 Git 面板、任务 Worktree 隔离、上下文性能指标（缓存比例 / 速度 / 首字耗时）与多账号/默认深色主题优化**：右侧面板改为「文件 / Git」标签页切换，集成离线 VS Code 文件图标并内置查看文件与 Diff（不强依赖 VS Code 编辑器，为独立客户端奠基）；Git 区域重构为 IntelliJ IDEA 风格的紧凑图标工具栏、分组变更列表与底部提交坞；任务看板升级为四列扁平视图并整合定时执行与 Git Worktree 隔离；上下文弹窗新增缓存命中率、输出速度与首字耗时；修复 Antigravity / Claude 账号误报过期与 CodeBuddy 多账号接入问题，并将默认主题切换为深色。

**Built-in file/diff viewer & IDEA-style Git panel, task worktree isolation, context performance metrics (cache ratio / speed / TTFT), account fixes & dark default theme**: The right panel now switches between Files and Git tabs with offline VS Code file icons and opens files and diffs in a built-in workspace viewer (decoupled from VS Code editors as a foundation for a standalone client). The Git panel is rebuilt in an IntelliJ IDEA style with a compact icon toolbar, collapsible changelists and a pinned bottom commit dock. The task board is flattened to four columns with integrated scheduling and Git worktree isolation; the context popover now shows cache hit ratio, output speed and TTFT; Antigravity/Claude false-expired status and CodeBuddy multi-account login are fixed, and the default theme is now dark.

- **内置文件与 Diff 查看器、VS Code 文件图标与 IDEA 风格 Git**：右侧面板改为下划线 `Tabs` 切换「文件」与「Git」，文件树默认全部收起并引入离线 `@iconify-icons/vscode-icons` 按文件后缀/文件名展示对应图标；点击文件与 Git 改动统一在主工作区内置查看（支持 Markdown 源码/预览切换），不再跳转打开 VS Code 编辑器标签页；Git 面板重构为紧凑图标工具栏（分支、改动统计、刷新、按目录分组、仅看本会话、创建 PR）、可折叠变更列表（已暂存 / 更改 / 未跟踪，文件名按状态着色）及底部固定提交坞（支持 `Ctrl/Cmd+Enter`、提交与推送图标按钮）。
  **Built-in file/diff viewer, VS Code file icons & IDEA-style Git**: Converted the right panel to underline `Tabs` for Files and Git, collapsed all folders by default, and bundled offline `@iconify-icons/vscode-icons` extension/filename icons; clicking files or Git changes opens a built-in viewer inside the main workspace (with Markdown Preview/Source toggle) instead of VS Code editors; rebuilt the Git panel with a compact icon toolbar (branch, diff stats, refresh, directory grouping, session-only filter, create PR), collapsible changelists (Staged / Changes / Untracked with status-colored filenames) and a pinned bottom commit dock (`Ctrl/Cmd+Enter`, commit and push icon actions).
- **四列任务看板、Worktree 隔离与内置定时执行**：移除独立「定时」模块并合并入任务，任务看板收拢为四列单层卡片布局；新建任务弹窗采用更宽敞的对话式输入区，支持按底层实时拉取模型、权限预设、简洁开关启用 **Git Worktree 隔离**（自动创建并进入独立分支工作区、任务卡片展示分支并支持一键清理 Worktree）及**定时执行**。
  **4-column task board, worktree isolation & integrated scheduling**: Merged the standalone Schedules view into Tasks and flattened the board to a 4-column single-card layout; rebuilt the New Task dialog with a taller chat-style composer, backend-aware model/permission pickers, and streamlined toggles for **Git Worktree isolation** (auto-creating a dedicated branch worktree with branch badge and one-click cleanup) and **scheduled execution**.
- **上下文用量性能指标（缓存比例 / 速度 / 首字耗时）**：新增跨底层 `TurnTimingTracker` 与 `RequestPerformance`（`ttftMs` / `tokensPerSec` / `durationMs`），接入 ACP、Pi、ZCode、Claude、CodeBuddy、Codex 投影层；上下文浮层新增最近一次请求与会话累计的缓存命中比例、首字耗时（TTFT）与生成速度（`tok/s`）。
  **Context usage performance metrics (cache ratio / speed / TTFT)**: Added cross-backend `TurnTimingTracker` and `RequestPerformance` (`ttftMs`, `tokensPerSec`, `durationMs`) across ACP, Pi, ZCode, Claude, CodeBuddy and Codex projections; the context popover now surfaces cache hit ratio (last request & session total), TTFT and output speed (`tok/s`).
- **多账号修复、样式精简与 ZCode 第三方服务商支持**：修复 Antigravity 与 Claude 账号在持有有效 `refresh_token` 时仍显示「已过期」的问题，活跃 Antigravity 槽位自动同步磁盘刷新后的最新凭据；账号列表去除「当前使用」文字标签，改用前置绿点/灰点标识选中态；修复 CodeBuddy 多账号添加与环境映射（`cn`/`ai`/`internal`）、支持可选官方 `CODEBUDDY_API_KEY` 与 OAuth 槽位切换；为原生 ZCode 新增隔离 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 第三方服务商支持并完善账号变更时的额度缓存清理。
  **Account fixes, cleaner status indicator & ZCode third-party providers**: Fixed Antigravity and Claude accounts showing "Expired" when a valid `refresh_token` is present and synced refreshed on-disk Antigravity tokens back to the active slot; replaced the "Active" text badge in account rows with a leading green/gray dot; fixed CodeBuddy multi-account sign-in (`CODEBUDDY_INTERNET_ENVIRONMENT` mapping, optional official `CODEBUDDY_API_KEY` and OAuth slot switching); added isolated `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` support for third-party providers in native ZCode and cleared stale quota cache on account changes.
- **默认深色主题、侧栏与对话渲染细节打磨**：首次打开默认启用深色主题（`dark`）；左侧导航重排为「总览 / 任务 / 智能体 / 项目」并支持持久化折叠项目列表（默认收起）；Markdown 表格改用 `shadcn-ui` `Table` 组件，优化虚拟列表滚动稳定性、弹窗布局与思考/执行/审批图标语义。
  **Default dark theme, sidebar & chat rendering polish**: Switched the default theme to `dark`; reordered the sidebar to Overview / Tasks / Agents / Projects with a persisted collapsible Projects group (collapsed by default); upgraded Markdown tables to `shadcn-ui` `Table`, improved virtualized thread scroll stability, refined dialog layouts and clarified thinking/executing/approval icons.

## 0.12.0

**界面视觉体系重构与官方登录授权码回填**：全面重做面板视觉语言，引入 t3code-ui-style 的 Quiet Zinc 浅色 / Cool Slate 深色配色、玻璃质感浮层与抽屉式滑入动效，统一品牌色、阴影与排版层级；「设置 → Agent」中的后端安装 / 切换版本改为弹窗式管理；官方账号登录支持在浏览器授权后回填授权码（如 Antigravity 的 `agy acp --login`）。

**Visual system refresh & authorization-code paste for official sign-in**: The panel adopts a rebuilt visual language based on t3code-ui-style — Quiet Zinc light / Cool Slate dark palettes, glass-surface overlays and drawer-style slide-in motion, with a unified brand color, shadows and typographic hierarchy. Backend install / version switching in Settings → Agent now runs through dialogs, and official sign-in can accept a pasted authorization code after browser authorization (e.g. Antigravity `agy acp --login`).

- **设计令牌与玻璃质感**：浅色主题改为 Quiet Zinc 中性灰阶、深色主题改为 Cool Slate 冷色调并收紧描边；新增玻璃模糊 / 饱和度 / 滚动条与浮层阴影令牌，统一 shadcn 语义变量到主色，重做状态坞、模型选择器与各类下拉浮层的玻璃外观，并细化代码块的层级样式。
  **Design tokens & glass surfaces**: The light theme moves to a Quiet Zinc neutral scale and the dark theme to a Cool Slate palette with tighter hairlines; added glass blur/saturation, scrollbar and overlay-shadow tokens, bridged shadcn semantic variables to the brand color, restyled the status dock, model picker and dropdown overlays with glass surfaces, and refined code-block layering.
- **抽屉滑入动效与细节交互**：新增 `usePanelPresence` 让浮层在进出动画结束后再卸载；统一更多操作菜单、后端卡片与设置页的交互细节，并修复登录进度残留时无法关闭弹窗的问题。
  **Drawer motion & interaction polish**: Added `usePanelPresence` so overlays unmount only after enter/exit animations finish; unified more-actions menus, backend cards and settings-page interactions, and fixed login dialogs that could not be dismissed when stale progress remained.
- **后端版本管理弹窗**：「设置 → Agent → 底层」的安装与切换版本操作改为独立弹窗，展示当前版本并支持选择版本安装；非 npm 托管与未安装底层分别给出复制安装命令 / 安装提示，中英文案同步更新。
  **Backend version dialogs**: Install and version-switch actions under Settings → Agent → Backends now open dedicated dialogs showing the current version and a version picker; non-npm-managed and missing backends show copyable install commands or hints, with Chinese/English strings updated in sync.
- **授权码回填登录**：官方 CLI 在浏览器授权后要求粘贴授权码 / 回调网址时（如 `agy acp --login`），登录弹窗会提示输入并把内容写入登录子进程；新增 `submitAccountLoginCode` 与 `cancelAccountLogin.dismiss` 契约、`needsAuthCode` 进度字段及取消 / 提交分支的单测覆盖，浏览器授权流程与仅在成功后同步账号状态的行为保持不变。
  **Authorization-code paste**: When an official CLI asks for a pasted authorization code / callback URL after browser authorization (e.g. `agy acp --login`), the sign-in dialog now prompts for it and forwards it to the login subprocess; added the `submitAccountLoginCode` and `cancelAccountLogin.dismiss` contract messages, a `needsAuthCode` progress field and unit tests for the cancel/submit branches. Browser authorization flows and syncing account state only on success are unchanged.

## 0.11.0

**官方账号与渠道管理**：在「设置 → Agent → 账号」中可为 Claude Code、Codex、CodeBuddy、Antigravity、Pi、OpenCode、DeepSeek 等智能体登录并管理多个官方账号，支持配置目录隔离、凭据槽位快照与官方 API Key，可选独立会话历史与按账号查询订阅额度；并可在设置页、模型选择器顶部或命令面板随时将智能体在「官方渠道（指定账号）」与「第三方服务商」之间一键切换，无需重启或手动改配置。

**Official accounts & channel switching**: Added Settings → Agent → Accounts to sign in and manage multiple official accounts for Claude Code, Codex, CodeBuddy, Antigravity, Pi, OpenCode, DeepSeek and other agents, with config-directory isolation, credential-slot snapshots and official API keys, optional isolated session history and per-account subscription quota. Any agent can now be switched between an official channel (a chosen account) and third-party providers from Settings, the Model Picker header or the Command Palette, without restarting or editing config manually.

- **多账号存储与登录流程**：新增 `AccountStore`、`AccountAuthFlow`、`AccountInspector` 与 `AccountIsolation` 宿主模块，持久化账号列表与渠道选择（`harnessDeck.accounts` / `harnessDeck.backendChannels`），按底层提供终端登录、OAuth CLI、API Key 与 ACP 授权等多种登录方式，凭据以机级作用域存储并支持安全编辑与复制。
  **Multi-account storage & auth flows**: Added host modules `AccountStore`, `AccountAuthFlow`, `AccountInspector` and `AccountIsolation` to persist the account list and channel selection (`harnessDeck.accounts` / `harnessDeck.backendChannels`), with terminal sign-in, OAuth CLI, API Key and ACP authorization per backend; credentials are stored at machine scope and support safe editing and copying.
- **凭据与会话隔离**：按底层能力选择配置目录、凭据槽位或 API Key 隔离方式，支持为账号单独开启独立会话历史，并在有额度能力的底层上按账号查询订阅额度；能力通过 `capabilities.ts` 的 `account` 描述符声明，界面不按 `kind` 判断功能。
  **Credential & session isolation**: Isolate accounts via config directories, credential slots or API keys according to backend capability, optionally keep a dedicated session history per account, and query subscription quota per account on quota-capable backends; capabilities are declared through the `account` descriptor in `capabilities.ts` so the UI never branches on `kind`.
- **渠道切换入口与账号设置页**：新增「设置 → Agent → 账号」页面与模型选择器顶部渠道切换条，补充 `Switch Model Channel / Official Account`、`Login Official Account` 命令面板入口；中英文案与设置契约同步更新，并补充账号模块的单测覆盖。
  **Channel-switch entry & Accounts settings page**: Added the Settings → Agent → Accounts page and a channel switcher at the top of the Model Picker, plus `Switch Model Channel / Official Account` and `Login Official Account` command-palette entries; Chinese/English strings and the settings contract were updated in sync, with unit tests covering the new account modules.

## 0.10.0

**工作台界面重构与 ZCode Protocol v1 适配**：工作台从「顶栏六大模块导航 + 独立会话列表」重构为「左侧项目/会话侧边栏 + 右侧工作区文件与 Git 面板 + 精简顶栏工具条」的三栏布局；会话模块更名为「项目」，历史会话整合进左侧栏并支持按运行中 / 等待处理 / 未读筛选；「改动」入口改为直接展开右侧 Git 面板。底层同步适配 ZCode Protocol v1 的会话创建、订阅、流式事件与交互响应 schema，确保 ZCode 后端的推理流、工具状态、模型切换与审批/提问卡片在新协议下正常渲染。

**Workbench UI overhaul & ZCode Protocol v1 compatibility**: The workbench has been restructured from a "top-bar six-module navigation with a separate session list" into a three-pane layout — a left project/session sidebar, a right workspace Files & Git panel, and a slim top toolbar. The Sessions module is renamed to "Projects", history is consolidated into the left sidebar with running / needs-attention / unread filters, and the "Changes" entry now opens the right Git panel directly. On the backend, ZCode is updated to the Protocol v1 session-create, subscribe, streaming-event and interaction-response schemas so reasoning streams, tool statuses, model switching, and approval/question cards render correctly under the new protocol.

- **三栏工作台与左侧项目侧边栏**：新增 `WorkbenchSidebar`（按项目分组的会话列表、状态徽标、运行中 / 等待处理 / 未读筛选、worktree 会话入口）与 `WorkbenchRightPanel`（工作区文件树浏览与搜索、Git 改动审阅 / 提交 / 推送 / PR），顶栏精简为「侧边栏开关 + 当前页标题 + 快捷操作」；侧栏、右侧面板的展开状态与会话模块持久化到本地，移动端以抽屉形式呈现侧栏。
  **Three-pane workbench & left project sidebar**: Added `WorkbenchSidebar` (project-grouped session list, status badges, running / needs-attention / unread filters, worktree session entry) and `WorkbenchRightPanel` (workspace file-tree browsing and search, Git change review / commit / push / PR); the top bar is reduced to a "sidebar toggle + current page title + quick actions" toolbar. Sidebar and right-panel expansion plus the active module persist locally, with the sidebar shown as a drawer on mobile.
- **历史会话整合与「会话 → 项目」更名**：移除独立的 `SessionHistoryPage`，历史会话并入左侧栏；中英文案同步更新，新增右侧面板、会话筛选与状态相关的 i18n key。
  **History consolidation & "Sessions → Projects" rename**: Removed the standalone `SessionHistoryPage` and merged history into the left sidebar; Chinese/English strings updated in sync, with new i18n keys for the right panel, session filters and statuses.
- **ZCode Protocol v1 协议适配**：`session/create` 兼容嵌套快照结构提取会话 ID，`session/subscribe` 携带 `deliveryKind`，附件图片改用 `attachments` 字段，模型选择改用 `model.options.reasoningLevel`；投影层支持字符串 delta 流式帧（`reasoning_delta` / `text_delta`）、`tool.updated` 的 `kind` 状态与嵌套状态/用量/模式快照；审批与提问响应严格遵循 V4 schema（`permissionUpdates`、`action: 'accept'`），运行时偏好返回合法 `preflight-v1` 策略。
  **ZCode Protocol v1 compatibility**: `session/create` now extracts IDs from nested snapshot structures, `session/subscribe` carries `deliveryKind`, image attachments use the `attachments` field, and model selection uses `model.options.reasoningLevel`; the projection layer supports string-delta streaming frames (`reasoning_delta` / `text_delta`), `tool.updated` `kind` statuses, and nested status/usage/mode snapshots; approval and question responses follow the V4 schema (`permissionUpdates`, `action: 'accept'`) and runtime preferences return a valid `preflight-v1` strategy.

## 0.9.2

**WSL 环境下自动识别 Windows 宿主机局域网地址与 WSL2 NAT 端口转发引导**：在 WSL 中运行 VS Code 时，远程互通不再默认暴露手机无法直连的 WSL 内部虚拟 NAT IP（`172.x.x.x`），而是自动探测并优先使用 Windows 宿主机的物理局域网网卡 IP，放行对应 `Host / Origin` 校验，并在 WSL2 NAT 模式下自动检测 Windows `netsh portproxy` 规则及提供一键复制的 PowerShell 转发命令。

**Windows host LAN IP auto-detection & WSL2 NAT port-forwarding guidance in WSL**: When running VS Code inside WSL, Mobile Remote Access now probes and prefers the Windows host's physical LAN IP instead of WSL's unreachable virtual NAT IP (`172.x.x.x`), allows that IP in `Host / Origin` checks, checks Windows `netsh portproxy` rules in WSL2 NAT mode, and provides a one-click copyable Administrator PowerShell forwarding command.

- **Windows 宿主机物理网卡优先识别**：WSL 环境下通过只读调用 `ipconfig.exe`（兼容 UTF-8 / GB18030 及多语言输出）过滤 `vEthernet (WSL)`、Docker、VPN 等虚拟网卡，优先选择带默认网关的 Windows 物理局域网 IP 作为配对地址，并自动兼容 WSL2 镜像网络（`networkingMode=mirrored`）。
  **Windows host physical NIC priority**: Probes `ipconfig.exe` read-only from WSL (supporting UTF-8 / GB18030 and localized Windows outputs), filters out `vEthernet (WSL)`, Docker, and VPN virtual adapters, prefers gateway-backed Windows LAN IPs for pairing URLs, and handles WSL2 mirrored networking (`networkingMode=mirrored`) seamlessly.
- **WSL2 NAT 转发状态检测与一键命令**：在设置页「网络入口与默认权限」新增「刷新网卡」入口；处于 WSL2 NAT 模式时只读检查 `netsh interface portproxy show v4tov4` 并展示转发状态与可直接复制的 PowerShell 端口转发及防火墙放行命令。
  **WSL2 NAT forwarding status & setup command**: Added a Refresh button in Settings -> Remote Access; in WSL2 NAT mode, checks `netsh interface portproxy show v4tov4` read-only and displays forwarding readiness along with a copyable PowerShell command for portproxy and Windows Firewall setup.

## 0.9.1

**修复 VS Code 插件面板空白（重复调用 `acquireVsCodeApi()`）**：修复 0.9.0 在启动 Webview 宿主通信桥接时清空 `acquireVsCodeApi()` 缓存导致同一页面二次获取 VS Code API 抛错、进而引发界面空白的严重回归，并同步加固单测与 E2E 的 `acquireVsCodeApi` 单次调用约束。

**Fix blank VS Code webview panel (duplicate `acquireVsCodeApi()` call)**: Fixed a 0.9.0 regression where starting the webview host bridge cleared the cached `acquireVsCodeApi()` instance and called it a second time, throwing an uncaught error and rendering a blank panel; hardened unit tests and E2E harnesses to enforce VS Code's single-acquisition invariant.

- **Webview 宿主桥接修复**：移除 `startHostBridge()` 中重置 `cachedVsCodeApi` 的逻辑，改为按 `globalThis.acquireVsCodeApi` 函数引用缓存实例，确保同一 Webview 页面严格仅调用一次 `acquireVsCodeApi()`，并在 IDE 模式下初始化时跳过 `localStorage` 读取。
  **Webview host bridge fix**: Removed the `cachedVsCodeApi` reset inside `startHostBridge()` and keyed the cache by `globalThis.acquireVsCodeApi` function identity so `acquireVsCodeApi()` is strictly called at most once per webview session, while avoiding unnecessary `localStorage` access in IDE mode.
- **单测与 E2E 回归防护**：在 `packages/webview-ui/test/setup.ts`、`ui-e2e.ts` 与 `acp-e2e.ts` 的 `acquireVsCodeApi` 模拟实现中强制执行单次调用校验，并补充首屏前调用 `loadState()` 与重复挂载 `<App />` 的回归用例。
  **Unit test & E2E regression guard**: Enforced single-acquisition checks in the `acquireVsCodeApi` mocks across `packages/webview-ui/test/setup.ts`, `ui-e2e.ts`, and `acp-e2e.ts`, and added a regression test covering pre-mount `loadState()` calls and `<App />` remounts.

## 0.9.0

**手机端远程互通（M5 全量落地）、多客户端会话总线、QR 配对与权限作用域、PWA 响应式界面与内嵌 Diff、Tailscale / 自带隧道、Web Push 与 Webhook 推送、脱离 IDE 的独立守护进程**：新增宿主内嵌 HTTP/WS 远程桥接（默认关闭），用一次性二维码在局域网手机浏览器或 PWA 上接入同一会话；引入 `ClientHub` 统一本地 Webview 与远程客户端，按 `read-only` / `operate` 作用域鉴权并屏蔽高危操作；移动端补齐响应式面板、软键盘安全区、PWA 安装、内嵌 Diff 审阅与推送跳转深链；支持 `tailscale serve` 自动反代与自带 HTTPS 隧道，并提供本地 VAPID Web Push、Bark / ntfy / 自定义 Webhook 兜底推送；新增 `--headless-server` 常驻守护模式与配套启停命令。

**Mobile remote access (full M5), multi-client session bus, QR pairing with scoped permissions, PWA responsive UI with inline Diff review, Tailscale / BYO tunnels, Web Push & Webhook notifications, and a standalone headless daemon**: Added a host-embedded HTTP/WS remote bridge (disabled by default) so a phone browser or installed PWA can join the same sessions via a single-use QR code; introduced `ClientHub` to multiplex the local Webview and remote clients with `read-only` / `operate` scope enforcement and high-risk action blocking; mobile UI now has responsive panels, keyboard-safe layout, PWA installation, inline Diff review, and push deep links; added `tailscale serve` auto-proxying and custom HTTPS tunnels, plus local VAPID Web Push with Bark / ntfy / custom Webhook fallback; added a persistent `--headless-server` daemon with start/status/stop commands.

- **多客户端会话总线与 Webview 传输抽象（HD-22）**：新增 `ClientHub` 区分单播响应（文件候选、Markdown 预览、Diff 内容、额度、模型列表等）与广播快照，本地 IDE 与远程客户端各自维护可见性与作用域；Webview 侧新增 `transport.ts` 统一抽象 IDE `postMessage` 与远程 HTTP/WS 通道，断线自动重连并同步 `ready` 握手。
  **Multi-client session bus & transport abstraction (HD-22)**: Added `ClientHub` splitting unicast responses (file candidates, Markdown preview, Diff content, quota, model lists) from broadcast snapshots, with per-client visibility and scope for the local IDE and remote clients; the Webview now has `transport.ts` abstracting IDE `postMessage` and remote HTTP/WS channels with automatic reconnect and a synchronized `ready` handshake.
- **宿主 HTTP/WS 桥接与局域网 QR 配对（HD-23）**：远程桥接默认关闭，可在设置页或命令面板（开启/关闭、生成配对码、查看设备）启用；配对码 5 分钟有效、经 URL `#fragment` 传递、换取 `HttpOnly; SameSite=Strict` 设备 Cookie 后立即作废；严格校验 `Host` / `Origin` 防 DNS Rebinding，`ScopeGuard` 按 `read-only` / `operate` 拦截安装底层、改服务商/MCP/技能等高风险操作；支持选择局域网网卡、单设备吊销与全部断开。
  **Host HTTP/WS bridge & LAN QR pairing (HD-23)**: The bridge is off by default and can be toggled from Settings or the command palette (toggle, generate pairing, show devices); pairing codes live 5 minutes, travel in the URL `#fragment`, and are burned after exchanging for an `HttpOnly; SameSite=Strict` device cookie; strict `Host` / `Origin` validation blocks DNS rebinding while `ScopeGuard` enforces `read-only` / `operate` scopes and blocks backend installs, provider/MCP/skill edits, and other high-risk actions; added LAN interface selection, per-device revocation, and disconnect-all.
- **移动端响应式界面与 PWA 适配（HD-24）**：移动端将弹窗 / 侧栏降级为 Sheet，适配 `visualViewport` 软键盘与安全区高度，补齐 PWA 清单、图标与 Service Worker、主屏安装，并支持从推送通知经 `/?session=<id>` 深链直达对应会话（跨项目、跨底层）。
  **Responsive mobile UI & PWA (HD-24)**: Mobile layouts degrade dialogs/sidebars into Sheets, adapt to `visualViewport` keyboard and safe-area insets, and ship a PWA manifest, icons, Service Worker, and home-screen install; push notifications deep-link to the target session via `/?session=<id>` across projects and backends.
- **移动端内嵌 Diff 审阅与无 IDE 动作降级（HD-25）**：新增 `DiffViewerModal` 与宿主侧 `mobileDiff` 生成器，手机端可直接审阅改动；只读设备隐藏发送、审批、Git 提交 / 推送 / PR 等写操作，并在设置页展示被屏蔽的操作提示。
  **Inline Diff review & IDE-free action degradation (HD-25)**: Added `DiffViewerModal` with a host-side `mobileDiff` generator for reviewing changes on the phone; read-only devices hide send, approval, and Git commit/push/PR actions and surface the blocked-action hint in Settings.
- **跨网访问（HD-26）**：只读探测本机 `tailscale status --json` 并可选自动配置 `tailscale serve` 获取 MagicDNS HTTPS 入口，或填写自带 HTTPS 隧道（`cloudflared` / `frp` / 反向代理），统一校验隧道 URL 并支持回声探测。
  **Cross-network access (HD-26)**: Read-only `tailscale status --json` probing with optional `tailscale serve` auto-configuration for a MagicDNS HTTPS entry, or a BYO HTTPS tunnel (`cloudflared` / `frp` / reverse proxy) with normalized URL validation and reachability probing.
- **移动端推送通知（HD-27）**：本地生成并持久化 VAPID P-256 密钥（免自建云中继），实现 RFC 8291 `aes128gcm` 负载加密与 RFC 8292 VAPID ES256 JWT 鉴权；提供 Bark / ntfy / 自定义 JSON Webhook 兜底，桌面 IDE 聚焦时静默抑制，并在设置页支持测试推送与订阅管理。
  **Mobile push notifications (HD-27)**: Locally generated and persisted VAPID P-256 keys (no self-hosted relay) with RFC 8291 `aes128gcm` payload encryption and RFC 8292 VAPID ES256 JWT auth; Bark / ntfy / custom JSON Webhook fallbacks, silent suppression while the desktop IDE is focused, and test-push plus subscription management in Settings.
- **脱离 IDE 的独立守护进程（HD-28）**：新增 `node dist/sidecar.cjs --headless-server <configRoot> <projectPath> [port]`，以单实例锁与 `headless-server.json` 状态文件常驻运行远程桥接，配套 `--headless-status` / `--headless-stop` 启停与状态查询。
  **Standalone headless daemon (HD-28)**: Added `node dist/sidecar.cjs --headless-server <configRoot> <projectPath> [port]` to run the remote bridge persistently with a single-instance lock and `headless-server.json` status file, plus `--headless-status` / `--headless-stop` controls.

## 0.8.0

**原生接入 OpenAI Codex 与腾讯 CodeBuddy（多会话并发）、上下文用量标识与浮层视觉统一**：新增原生 OpenAI Codex（`codex app-server`）底层，支持模型与多档推理、运行中 `turn/steer` 插队、审批与提问卡片、子代理及无人值守定时任务；将 CodeBuddy 从单会话 ACP 升级为原生 `codebuddy -p` 双向流式底层，彻底解除单会话限制并支持多标签并发、思考档位与 `~/.codebuddy/projects` 本地历史秒开回放；重构上下文用量标识（`ContextRing`）与订阅额度浮层（`UsageBadge`），统一图标 + 百分比视觉语言并优化首轮明细去重与视口高度自适应。

**Native OpenAI Codex & concurrent Tencent CodeBuddy backends, plus unified context & quota popovers**: Added native OpenAI Codex (`codex app-server`) with model/reasoning selection, live `turn/steer` steering, approval & question cards, subagents, and unattended schedules; upgraded CodeBuddy from single-session ACP to native bidirectional `codebuddy -p` stream-json with concurrent multi-tab sessions, thinking effort levels, and local `~/.codebuddy/projects` history replay; refreshed `ContextRing` and `UsageBadge` to share a unified icon + percentage design with first-turn deduplication and viewport-aware popover sizing.

- **OpenAI Codex 原生底层（`codex app-server`）**：通过 `codex app-server --listen stdio://` NDJSON JSON-RPC 原生接入，支持模型与多档推理切换、逐字流式推理/正文、只读命令归类（`explore`）与 Shell 输出、unified diff 改动统计、命令/文件/权限提升审批（含未保存脏文件拦截）、提问卡片、子代理卡片、运行中 `turn/steer` 插队、OpenAI Responses/Chat 第三方服务商 `-c` 覆盖、MCP 服务器参数注入及定时无人值守运行；新增 `harnessDeck.codex.path` 设置与设置页一键安装（`@openai/codex`）。
  **Native OpenAI Codex backend (`codex app-server`)**: Integrated `codex app-server --listen stdio://` over NDJSON JSON-RPC with model & reasoning effort switching, streaming reasoning/text, read-only `explore` grouping and shell output, unified diff stats, command/file/permission approvals (with unsaved-file guard), question & subagent cards, live `turn/steer`, third-party OpenAI Responses/Chat provider overrides via `-c`, MCP `-c` injection, and unattended schedule runs; added `harnessDeck.codex.path` and one-click `@openai/codex` installation.
- **腾讯 CodeBuddy 原生多会话底层（`codebuddy -p`）**：从旧版单会话 ACP 迁移至 `codebuddy -p --input-format stream-json --output-format stream-json` 原生协议，按活跃会话独立运行子进程，支持多标签并发回复、在线模型与斜杠命令发现、`--effort` 思考档位、子代理卡片、未保存文件拦截与 Diff 预览、OpenAI Chat 服务商代理环境变量、`--mcp-config` / `--add-dir` 挂载、定时无人值守执行，以及直接扫描 `~/.codebuddy/projects` 回放历史会话并兼容旧版 ACP 状态键；新增 `harnessDeck.codebuddy.path` 设置。
  **Native concurrent CodeBuddy backend (`codebuddy -p`)**: Migrated CodeBuddy from single-session ACP to native `codebuddy -p` bidirectional `stream-json` with isolated per-session child processes for true multi-tab concurrency, dynamic model/command discovery, `--effort` levels, subagent cards, unsaved-file guard and diff previews, OpenAI Chat provider proxy env, `--mcp-config` / `--add-dir` staging, unattended schedule runs, and direct `~/.codebuddy/projects` history replay with legacy ACP state compatibility; added `harnessDeck.codebuddy.path`.
- **上下文用量与订阅额度标识统一**：`ContextRing` 改用 `ChartPieIcon` + 百分比样式与 `UsageBadge` 保持一致，浮层补充顶部进度条、首轮请求与会话累计自动去重、紧凑两列累计网格及 `--radix-popover-content-available-height` 自适应最大高度；同步清理未使用的 i18n key 并更新能力矩阵与文档。
  **Unified context & subscription usage indicators**: Redesigned `ContextRing` with `ChartPieIcon` + percentage to match `UsageBadge`, adding a header progress bar, automatic first-turn deduplication, a compact two-column session summary grid, and viewport-aware popover max height (`--radix-popover-content-available-height`); cleaned up unused i18n keys and updated the capability matrix and docs.

## 0.7.0

**底层能力模型、回合工作流与文件回滚、串行 Worktree 会话、工作台源码控制闭环与质量门禁**：统一底层能力描述符与 npm 安装归属检查；新增回合模型、DeepSeek 回合级文件恢复、串行 Worktree 会话与清理入口；工作台新增「改动」模块，支持只读状态、Diff 查看与受信任工作区内的提交 / 推送 / 创建 PR；补充 ACP 注册表导入、幂等命令回执、JetBrains Sidecar 退避自动重启、无头后台定时调度及多套质量门禁。

**Backend capability model, turn workflow & file rollback, serial worktree sessions, Workbench source control, and quality gates**: Unified backend capability descriptors and npm install ownership checks; added the first-class turn model, DeepSeek turn-level file restore, and serial worktree session creation/cleanup; introduced the Workbench Changes module with read-only Git status, Diff preview, and explicit trusted-workspace commit / push / PR actions; added HTTPS ACP registry discovery, idempotent command receipts, JetBrains sidecar backoff auto-restart, background headless scheduling, and quality/eval gates.

- **底层能力模型、归属保护与多实例配置**：新增共享能力描述符（`packages/shared/src/capabilities.ts`），界面统一按能力渲染；安装 / 升级 / 卸载前校验当前可执行文件的真实安装归属（兼容 Windows `.cmd`/`.ps1` shim），对 Homebrew / mise / Volta 等外部安装拒绝覆盖并提供复制命令；底层配置支持 `driver` / `instanceId` 拆分并保持历史会话兼容；设置页新增只读 HTTPS ACP 注册表发现（`harnessDeck.acpRegistryUrl`）。
  **Backend capabilities, ownership guard & multi-instance profiles**: Added shared capability descriptors (`packages/shared/src/capabilities.ts`) so the UI adapts without branching on backend kind; added npm ownership verification (including Windows `.cmd`/`.ps1` shims) that refuses to overwrite external Homebrew / mise / Volta installs and offers a copy-command fallback; split `driver` and `instanceId` while preserving session compatibility; added read-only HTTPS ACP registry discovery (`harnessDeck.acpRegistryUrl`) in Settings.
- **回合模型、文件回滚与串行 Worktree 会话**：五个控制器在快照与增量推送中统一输出 `session.turns`，对话流展示回合编号；DeepSeek（dsh）最后一轮实际改过文件时支持「恢复本轮文件」（确认写盘、自动删除本轮新建文件、失败时尽力回滚、不回退对话）；会话侧栏支持新建串行 Worktree 会话，设置页配套提供安全的 `git worktree remove` 清理入口。
  **Turn model, file rollback & serial worktree sessions**: All five controllers now emit `session.turns` in snapshots and incremental updates with turn numbers shown in the thread; DeepSeek (dsh) adds turn-level file restore for the latest turn with edits (confirmation dialog, deletes newly created files, best-effort rollback on mid-write failure, conversation unchanged); added serial worktree session creation in the sessions sidebar with safe `git worktree remove` cleanup in Project Settings.
- **工作台「改动」模块与源码控制闭环**：工作台扩展至六大模块，新增「改动」视图展示分支、远程、暂存/未暂存文件（支持 `-c core.quotepath=false` 与 `-z` 中文/重命名解析）、按本会话 `authoredPaths` 过滤与点击打开 Diff；受信任工作区内支持显式提交（可选仅提交已暂存或全部改动）、二次确认推送（禁止 force）与基于 `gh` CLI 的 PR 创建（展示 `gh` 登录状态，失败保留草稿，不保存 token）。
  **Workbench Changes module & source control workflow**: Expanded the Workbench to six modules with a new Changes view showing branch, remote, staged/unstaged files (with `-c core.quotepath=false` and `-z` Unicode/rename parsing), filtering by session `authoredPaths`, and clicking to open Diffs; added explicit commit (staged-only or all), confirmation-gated push (never force), and `gh`-backed PR creation in trusted workspaces (with `gh` status indicator, draft preservation on failure, and zero token storage).
- **稳定性、JetBrains Sidecar 与后台调度**：Webview 对发送、审批、提问与手动定时触发附带 `commandId`（审批与提问采用确定性 ID），宿主 `CommandReceipts` 5 分钟内幂等去重；JetBrains Sidecar 异常退出后按指数退避自动重启，重新采集编辑器状态并同步恢复所有已打开 JCEF 面板；Sidecar 支持以单实例原子锁拉起无头后台定时调度，并与 IDE 端通过磁盘监听双向同步规则和运行结果；修复 ZCode `session/create` 的 `workspacePath` / `workspaceKey` 载荷字段。
  **Reliability, JetBrains Sidecar & background scheduler**: Attached `commandId` to send/approval/question/manual-schedule messages (deterministic IDs for approvals and questions) with 5-minute host deduplication via `CommandReceipts`; added JetBrains sidecar exponential-backoff auto-restart with fresh editor state and automatic JCEF panel re-sync; added atomic-locked headless background schedule runner with two-way disk sync between IDE and daemon; fixed ZCode `session/create` payload fields (`workspacePath` / `workspaceKey`).
- **订阅额度展示与 Antigravity 分组增强**：Antigravity 额度查询透传本机 CLI 版本构造合规 `User-Agent` 并返回完整模型分组列表，未消耗额度时不展示占位倒计时；`UsageBadge` 改为展示剩余百分比并呈现分组模型清单。
  **Subscription quota & Antigravity pool improvements**: Antigravity quota requests now pass the detected CLI version in `User-Agent` and surface full model pool lists while omitting placeholder reset countdowns when unused; `UsageBadge` displays remaining percentages along with per-group model lists.
- **质量门禁、评测与文档体系**：新增测试纪律 ESLint 插件、`pnpm check:i18n` 校验门禁（清理 37 个死 key）、`pnpm check:changed` 增量检查、`pnpm perf:check` 性能基线与直接导入真实提示词的 `evals/` 评测框架，并接入 CI；完善 `ROADMAP.md`、`docs/README.md`、`AGENTS.md` 术语表与改动自检清单、以及 5 组底层 / 17 项能力对比矩阵与测试。
  **Quality gates, evals & docs**: Added custom test-discipline ESLint rules, `pnpm check:i18n` gate (removing 37 dead keys), `pnpm check:changed` incremental runner, `pnpm perf:check` baseline, and prompt-backed `evals/` wired into CI; updated `ROADMAP.md`, `docs/README.md`, `AGENTS.md` glossary & surface checklist, and the 5-group / 17-capability backend matrix with automated matrix tests.

## 0.6.1

**重新发布 0.6.0 功能**：本版与 0.6.0 代码一致，仅提升版本号以重新走发布流程——订阅额度标识、上下文用量明细与会话模型标签。

**Re-release of 0.6.0 features**: This release ships the same code as 0.6.0 with only a version bump to re-run the release pipeline—subscription quota badge, context usage details, and per-session model labels.

- **订阅用量标识**：输入框旁的 `UsageBadge` 支持 Claude、Antigravity 与 CodeBuddy 官方订阅额度，展示 5 小时 / 每周 / 每周按模型窗口的已用、剩余与重置时间；查不到额度或绑定第三方服务商时自动隐藏，成功结果缓存 5 分钟并经宿主代理请求，凭据只读不刷新。
  **Subscription quota badge**: `UsageBadge` next to the composer shows official Claude, Antigravity, and CodeBuddy subscription windows (5-hour / weekly / per-model weekly) with used, remaining, and reset time; it hides itself when no quota is available or a third-party provider is bound, caches successful results for 5 minutes through the host proxy, and never refreshes or logs credentials.
- **上下文用量明细**：上下文圆环悬停 / 点击展开浮层，展示最近一次请求与会话累计的输入、缓存读写、输出占比条，以及推理部分、合计与费用；Claude、Pi、ACP 均已接入统一用量采集。
  **Context usage details**: The context ring opens a Popover on hover or click with input / cache read / cache write / output bars for the last request and the session total, plus reasoning, totals, and cost; Claude, Pi, and ACP all feed the shared usage tracker.
- **会话模型标签**：会话历史列表逐条展示该会话最近使用的模型，模型切换后立即同步。
  **Per-session model labels**: Session history rows show each session's last-used model and update as soon as the model changes.

## 0.6.0

**订阅额度标识、上下文用量明细与会话模型标签**：输入框旁新增官方订阅用量标识，可展开查看 5 小时 / 每周 / 每周按模型窗口的已用、剩余与重置时间，支持 Claude、Antigravity 与 CodeBuddy；上下文圆环悬停展开用量明细（最近一次请求、会话累计、缓存读写、推理与费用）；会话列表逐条展示该会话最近使用的模型。

**Subscription quota badge, context usage details, and per-session model labels**: Added an official subscription usage badge next to the composer showing 5-hour / weekly / per-model weekly windows with used, remaining, and reset time for Claude, Antigravity, and CodeBuddy; hovering the context ring now expands a usage breakdown (last request, session total, cache read/write, reasoning, and cost); session history rows show the last model used by each session.

- **订阅用量标识**：新增 `UsageBadge` 与 `fetchQuota` / `quotaFetched` 协议，宿主按激活后端分发到 `quota/` 提供方——Claude 读取本机 OAuth 凭据调用 `/api/oauth/usage`，Antigravity 读取 CLI / IDE 落盘凭据调用 `retrieveUserQuotaSummary`，CodeBuddy 使用 `CODEBUDDY_COOKIE` 或 `~/.codebuddy/usage-cookie` 调用计费接口；成功结果按 token 缓存 5 分钟并走宿主代理，凭据只读不刷新、不进日志与视图模型；绑定第三方服务商或查不到额度时隐藏标识。
  **Subscription quota badge**: Added `UsageBadge` plus `fetchQuota` / `quotaFetched` messages that dispatch to `quota/` providers by active backend—Claude reads local OAuth credentials and calls `/api/oauth/usage`, Antigravity reads CLI/IDE credential files and calls `retrieveUserQuotaSummary`, and CodeBuddy uses `CODEBUDDY_COOKIE` or `~/.codebuddy/usage-cookie` against its billing API; successful results are cached for 5 minutes per token through the host proxy, credentials are read-only, never refreshed, logged, or sent to the webview; the badge hides itself when a third-party provider is bound or no quota is available.
- **上下文用量明细**：`ContextRing` 悬停 / 点击弹出 Popover，展示最近一次请求与本会话累计的四段占比条（输入、缓存读取、缓存写入、输出）、推理部分、合计与费用；新增 `TokenBreakdown` / `ContextDetail` 视图模型与共享 `UsageTracker`，Claude 按消息 id 合并流式重复上报的用量并按 `total_cost_usd` 增量累计费用，Pi 与 ACP 分别从助手消息和 `session/prompt` 结果 / `usage_update.cost` 采集。
  **Context usage details**: The `ContextRing` now opens a Popover on hover or click with four-segment bars (input, cache read, cache write, output) for the last request and the session total, plus reasoning, totals, and cost; added the `TokenBreakdown` / `ContextDetail` view models and a shared `UsageTracker`, with Claude merging streamed duplicate reports by message id and accumulating cost from `total_cost_usd` deltas, Pi reading assistant messages, and ACP reading `session/prompt` results and `usage_update.cost`.
- **会话模型标签**：`WorkbenchHub` 注册表记录每个会话最近使用的模型显示名并随模型切换同步推送，会话历史列表在智能体图标旁逐条展示，当前会话在注册表同步前先用实时模型兜底。
  **Per-session model labels**: The `WorkbenchHub` registry now stores each session's last-used model name and pushes updates when the model changes, session history rows display it next to the backend icon, and the current session falls back to the live model until the registry syncs.

## 0.5.5

**npm 版本探测与代理环境修复、JetBrains Sidecar 环境同步及 macOS CI 修复**：修复 npm 版本列表拉取超时或错误不透明的问题，同步 JetBrains IDE 登录 shell 环境，并修复 macOS 下的 WSL 单元测试。

**npm version lookup & proxy fixes, JetBrains Sidecar environment sync, and macOS CI fixes**: Improved npm version fetching reliability and error reporting, synced login shell environment for JetBrains sidecar, and fixed WSL unit tests on macOS.

- **npm 与代理环境修复**：`processEnvWithProxy` 跳过 `socks://` 代理避免 npm 挂起至超时；`npmManager` 统一在用户主目录执行 npm 命令以免受工作区 `.npmrc` 干扰，`fetchNpmVersions` 增加 `--fetch-retries=0 --fetch-timeout=8000` 并返回更可读的错误详情；设置页智能体卡片直接展示 `versionsError` 具体原因，JetBrains `SidecarProcessManager` 通过 `EnvironmentUtil.getEnvironmentMap()` 注入完整 shell 环境。
  **npm & proxy fixes**: Skipped `socks://` proxies in `processEnvWithProxy` to prevent npm hangs; ran npm commands in `homedir()` to avoid project `.npmrc` interference; added `--fetch-retries=0 --fetch-timeout=8000` and clearer error messages in `fetchNpmVersions`; displayed `versionsError` details in `BackendCard`; synced shell environment in JetBrains `SidecarProcessManager` via `EnvironmentUtil.getEnvironmentMap()`.
- **跨平台测试与 CI 修复**：`RuntimeManager` 支持可选 `platform` 配置以在非 Linux 主机测试 WSL 缓存逻辑；`wslLocate` 与 `runtimeManager` 测试通过 `realpath` 规范化 macOS `/var` 软链接临时目录；`browserBridge` 测试改用 `path.delimiter` 适配 Windows 分隔符。
  **Cross-platform test & CI fixes**: Added optional `platform` override on `RuntimeManager` for WSL cache tests; canonicalized macOS `/var` symlinked temp dirs with `realpath` in `wslLocate` and `runtimeManager` tests; used `path.delimiter` in `browserBridge` tests.

## 0.5.4

**跨智能体统一标签栏、共享加载态组件与智能体图标更新**：顶部标签栏不再按底层隔离，DeepSeek、Claude、Pi、ZCode、ACP 的会话可以并排打开并各自显示智能体图标；新增 Beautiful UI `LoadingState`（Drive / Dots / Orbit），运行状态改用 Orbit 轨道动效；底层图标改用 SVG，设置页直接展示 dsh 网页地址。

**Unified cross-agent tab bar, shared loading state, and backend icon refresh**: The tab bar is no longer isolated per backend—DeepSeek, Claude, Pi, ZCode, and ACP sessions can stay open side by side with their own agent icons; added the Beautiful UI `LoadingState` (Drive / Dots / Orbit) with Orbit used for the run status; backend logos moved to SVG and the settings card now shows the dsh web address.

- **跨智能体统一标签栏**：新增 `UnifiedTabs` 模型，标签归属到具体智能体并支持持久化与冷启动恢复，切换或新建会话切换智能体不再清空已有标签；冷启动恢复时按需启动非激活智能体，旧会话临时 key 换成真实 id 后标签同步更新且不丢失；标签栏与会话历史列表展示智能体图标，并补充 `unifiedTabs`、`tabBar` 与运行时集成测试。
  **Unified cross-agent tabs**: Added the `UnifiedTabs` model so each tab belongs to a backend with persistence and cold-start restore; switching backends or creating sessions no longer clears existing tabs; inactive backends start on demand when restoring, pending session keys are rekeyed to real ids without losing tabs, and tabs plus session history show backend icons, covered by `unifiedTabs`, `tabBar`, and runtime integration tests.
- **加载态与思考轨迹**：抽出共享 `LoadingState` 组件（Drive / Dots / Orbit 三种 3×3 网格动效），`RunStatus` 改用 Orbit 轨道动效并单独处理等待审批状态；思考轨迹在当前轮次运行期间保持展开，整轮操作结束后统一收起。
  **Loading state & thinking trace**: Extracted a shared `LoadingState` component (Drive / Dots / Orbit 3×3 grid animations); `RunStatus` now uses the Orbit animation with a separate waiting-for-approval state, and thinking traces stay expanded while the current turn runs, collapsing only after the whole turn finishes.
- **图标与 dsh 入口**：CodeBuddy、oh-my-pi 图标改用 SVG，Antigravity 图标补充底板并更新 OpenCode 图标；`BackendView.webUrl` 让设置页直接展示 dsh 网页地址作为打开入口。
  **Icons & dsh entry**: Switched CodeBuddy and oh-my-pi logos to SVG, added a tile background to the Antigravity logo, refreshed the OpenCode icon, and exposed `BackendView.webUrl` so the settings card shows the dsh web address as a direct entry point.

## 0.5.3

**Google Antigravity 原生支持、思考轨迹与状态栏精简、Claude 服务商运行时与代理增强**：新增 Google Antigravity（`agy acp`）内置智能体及协议适配；精简 `ThinkingTrace`、`RunStatus` 与活动行视觉状态，消除重复加载动效；增强 Claude 服务商 `--settings` 环境变量注入、`NO_PROXY` 处理与服务商代理稳定性。

**Google Antigravity support, ThinkingTrace & RunStatus polish, and Claude provider runtime & proxy enhancements**: Added built-in Google Antigravity (`agy acp`) backend support and ACP projection compatibility; streamlined `ThinkingTrace`, `RunStatus`, and activity row visuals by removing duplicate loaders; enhanced Claude provider `--settings` overrides, `NO_PROXY` handling, and provider proxy stability.

- **Google Antigravity 底层接入**：内置 `antigravity`（`agy acp`）配置、图标与安装/登录引导，标记为账号认证模式；兼容 Antigravity 工具参数与 Diff 字段（`Path` / `Content` / `CommandLine` / `Target` / `Replacement`）及 `current_model_update` 保护，并补充 `acpAntigravity` 单测。
  **Google Antigravity backend**: Added built-in `antigravity` (`agy acp`) profile, icon, install/sign-in hints, and account-only provider capability; added ACP projection support for Antigravity tool inputs/diffs (`Path` / `Content` / `CommandLine` / `Target` / `Replacement`) and `current_model_update` guard, backed by `acpAntigravity` tests.
- **对话流视觉精简**：`ThinkingTrace` 改用静态星芒图标，移除重复加载指示器与独立计时，由底部 `RunStatus` 统一承担运行态与计时；精简 `RunStatus` 外层胶囊样式，运行中活动行统一使用 `text-accent-ink` 高亮。
  **Thread visual polish**: Switched `ThinkingTrace` to a static sparkle icon and removed its duplicate loader/timer so `RunStatus` serves as the single running indicator; removed `RunStatus` pill/card chrome and highlighted running activity rows with `text-accent-ink`.
- **服务商代理与运行时修复**：为原生 `claude -p` 补充 `--settings` 最高优先级环境变量覆盖以防止宿主配置回退覆盖本地代理；修复 `NO_PROXY` 大小写重复键与已知模型误判小模型的问题；完善运行时可执行文件定位、MCP 导入及无人值守调度逻辑。
  **Provider proxy & runtime fixes**: Added `--settings` overrides for native `claude -p` to prevent host settings from overriding the local proxy; fixed case-insensitive `NO_PROXY` deduplication and known-model routing in `OpenaiToAnthropicConverter`; improved runtime discovery, MCP importer/service, and unattended runner handling.

## 0.5.2

**思考轨迹折叠、首页智能体快捷切换、设置页视觉与布局打磨**：将连续工具操作与推理折叠为「思考轨迹」行，支持首页下拉直接切换已安装智能体，统一设置页分区标题样式与控件尺寸，优化状态栏与侧边栏会话列表布局。

**Collapsible thinking trace, quick home agent switcher, and settings UI polish**: Grouped consecutive tool activities and reasoning into collapsible thinking trace rows, added a Home dropdown switcher for installed agents, unified settings section headings and control sizing, and refined StatusDock and session list layouts.

- **对话流思考轨迹（`ThinkingTrace` / `threadRows`）**：将连续的工具调用、只读探索与推理合并为可折叠的思考轨迹行，运行中自动展开并显示流光与计时、完成后自动收起，同时适配虚拟滚动高度估算、缓存失效与会话切换重置。
  **Thinking trace in threads (`ThinkingTrace` / `threadRows`)**: Grouped consecutive tool calls, explore summaries, and reasoning into collapsible trace rows that auto-expand with shimmer and timer while running and auto-collapse when done, integrated with virtual scroll layout estimation, stale height invalidation, and session-switch resets.
- **首页与工作台交互优化**：首页智能体芯片改为下拉菜单直接切换已安装的智能体；精简侧边栏项目会话分组与单条会话排版；状态栏（`StatusDock`）改为纵向堆叠行以改善窄面板可读性。
  **Home & workbench UX refinements**: Replaced the Home backend chip click with a dropdown switcher for installed agents, simplified project session groups and session row chrome, and stacked `StatusDock` segments vertically for better narrow-panel readability.
- **设置页重构与细节修复**：抽离统一的 `SettingsSection` 分区布局，统一设置页控件尺寸（含 `NumberStepper` 与模型表格列宽对齐），简化智能体默认标记；更新 E2E 脚手架与单元测试并清理已完成规划文档。
  **Settings polish & fixes**: Extracted a shared `SettingsSection` layout, aligned settings control sizing (including `NumberStepper` and provider model table columns), streamlined default agent badges, updated E2E scripts and unit tests, and removed completed plan docs.

## 0.5.1

**对话虚拟列表、统一控件尺寸与离线图标规范、WSL 与服务商代理增强**：优化长对话渲染性能，统一表单控件高度体系与离线图标打包，增强 WSL 环境运行时发现、浏览器桥接及 OpenAI 转 Anthropic 代理兼容性。

**Virtualized thread, unified control sizes & offline icons, WSL and provider proxy enhancements**: Improved long-thread rendering performance, unified control sizing and offline Iconify icon bundling, and enhanced WSL runtime discovery, browser bridge, and OpenAI-to-Anthropic proxy compatibility.

- **对话性能与界面规范**：引入对话消息虚拟滚动（`useVirtualThread`）；统一 `Input`、`NativeSelect`、`SelectTrigger`、`NumberStepper` 等控件的 `size` 高度体系；全面迁移至 `@iconify/react/offline` 静态按需打包图标，并补充控件尺寸、离线图标与虚拟列表测试。
  **Thread performance & UI standards**: Added virtualized thread rendering (`useVirtualThread`); unified the `size` height system across `Input`, `NativeSelect`, `SelectTrigger`, and `NumberStepper`; migrated UI icons to statically bundled `@iconify/react/offline` with new tests for control sizes, offline icons, and virtual scrolling.
- **运行时与服务商代理**：新增 WSL 环境定位与浏览器桥接支持，优化环境缓存与各底层（ACP / Claude / Pi / ZCode）路径发现；增强 `OpenaiToAnthropicConverter`、`ProviderProxy` 与 `proxyFetch` 的协议转换与稳定性。
  **Runtime & provider proxy**: Added WSL runtime discovery and browser bridge support, improved environment caching and backend path detection (ACP / Claude / Pi / ZCode), and enhanced `OpenaiToAnthropicConverter`, `ProviderProxy`, and `proxyFetch` compatibility and stability.

## 0.5.0

**JetBrains IDE 插件与独立 Sidecar、原生多底层扩展、工作台与界面重构**：新增 JetBrains IDE 插件（IntelliJ IDEA、WebStorm、PyCharm、GoLand、Rider 等）与独立 Node.js Sidecar；新增 Claude Code、Pi、ZCode 原生底层；上线工作台（总览、定时任务、智能体、看板任务、跨项目会话）、服务商代理与绑定、MCP / Skill 管理；前端组件体系重构为 `shadcn-ui` + `beautifului` 并补齐组件级测试与无障碍改进。

**JetBrains IDE plugin & standalone Sidecar, native backends, Workbench, and UI overhaul**: Added the JetBrains IDE plugin (IntelliJ IDEA, WebStorm, PyCharm, GoLand, Rider, etc.) powered by a standalone Node.js sidecar; added native Claude Code, Pi, and ZCode backends; introduced the Workbench (Overview, Schedules, Agents, Kanban Tasks, Cross-project Sessions), Provider Proxy & bindings, and MCP / Skill management; refactored the frontend UI onto `shadcn-ui` + `beautifului` with component test coverage and accessibility fixes.

- **JetBrains IDE 插件（`packages/jetbrains`）**：基于 `JBCefBrowser`（支持降级处理）、本地静态资源服务与 `JBCefJSQuery` 通信桥接，集成 `PasswordSafe` 密钥存储、编辑器上下文同步、终端与 Diff 视图；通过 `sidecar.cjs` 守护进程与 VS Code 扩展共享主机核心与 `~/.harness-deck/` 配置状态。
  **JetBrains IDE plugin (`packages/jetbrains`)**: Built on `JBCefBrowser` (with fallback handling), an embedded static asset server and `JBCefJSQuery` bridge, `PasswordSafe` secret storage, editor context sync, terminal and diff integration; shares host runtime and `~/.harness-deck/` state with VS Code via `sidecar.cjs`.
- **原生多底层扩展**：新增 Claude Code（`claude -p`）、Pi（`pi --mode rpc`）和 ZCode（`zcode app-server --stdio`）原生适配器，支持自动定位安装与默认底层配置（`harnessDeck.defaultBackend`）。
  **New native backends**: Added native adapters for Claude Code (`claude -p`), Pi (`pi --mode rpc`), and ZCode (`zcode app-server --stdio`), with executable discovery and `harnessDeck.defaultBackend` configuration.
- **工作台与生态管理**：新增工作台面板（总览、定时调度与无人值守执行、智能体配置、看板任务、跨项目会话），以及服务商管理（含 OpenAI 转 Anthropic 本地代理与模型预设）、MCP 导入与管理、Skill 管理。
  **Workbench & ecosystem management**: Added the Workbench (Overview, Schedules & unattended runner, Agents, Kanban Tasks, Cross-project Sessions), Provider management (including local OpenAI-to-Anthropic proxy and presets), MCP importer/service, and Skill management.
- **界面重构与稳定性**：基于 `shadcn-ui` 与 `beautifului` 规范重构设置页与工作台视图，拆分大模块并消除重复逻辑；修复定时任务手风琴状态、深色模式对比度、键盘导航与 `Esc` 处理、流式输出记忆化渲染和错误提示稳定性，新增 jsdom + Testing Library 测试基线。
  **UI refactor & stability**: Refactored settings and workbench views onto `shadcn-ui` and `beautifului`, splitting oversized modules and deduplicating shared logic; fixed schedule accordion state, dark-mode contrast, keyboard navigation and `Esc` handling, streaming memoization, and toast stability, backed by a new jsdom + Testing Library test suite.

## 0.4.0

**全面审查后的修复**：底层的启动和切换、ACP 底层的安全保护、发送失败不再丢输入；输入框上方的状态栏合并成一行；对比度、点击区域和读屏支持。

**Fixes from a full review**: backend start-up and switching, safety parity on ACP backends, no more lost input when sending fails; the bars above the input are merged into one; contrast, hit targets and screen-reader support.

- 修复：面板隐藏时切换底层（或在设置里删掉当前底层），再打开面板一直停在「正在查找…」。现在面板每次显示都会确保当前底层已经启动。
  Fixed: switching backends while the panel was hidden (or removing the current backend in settings) left the panel stuck on "Looking for…". The active backend is now started whenever the panel is shown.
- 修复：连续快速切换底层时，先启动的那个底层进程没有被结束。切换现在按顺序执行。
  Fixed: switching backends twice in quick succession left the first backend's process running. Switches are now serialized.
- 修复：ACP 代理关闭输入或提前退出时出现未捕获异常、请求一直等待；设置里的命令不是 ACP 代理时一直停在「启动中」（现在 30 秒后提示）。
  Fixed: an uncaught error and a request that never finished when an ACP agent closed its input or exited early; a command that is not an ACP agent no longer stays on "Starting" forever (it fails after 30 s with a hint).
- 修复：dsh 还在启动时关闭窗口、重启或切换底层要等启动跑完（最长一分多钟），窗口关闭后 dsh 可能残留。现在立即结束还没就绪的进程，扩展宿主退出时也会带走自己启动的子进程。
  Fixed: closing the window, restarting or switching while dsh was still starting waited for the launch to finish (over a minute in the worst case) and could leave dsh behind. The launch is now aborted, and child processes are terminated when the extension host exits.
- 修复（Windows，未在真机验证）：命令是 `.cmd` / `.bat`（npm 全局安装的都是）且路径带空格时启动失败；参数里的 `&`、`|` 不再被当成命令分隔符。dsh 的 profile 名只接受字母、数字和 `. _ -`。
  Fixed (Windows, not verified on a real machine): launching a `.cmd` / `.bat` command (every npm global install) from a path with spaces; `&` and `|` in arguments are no longer treated as command separators. The dsh profile name only accepts letters, digits and `. _ -`.
- ACP 底层补上和 DeepSeek 一样的保护：审批要修改的文件有未保存内容时先让你保存；切换到不再逐项询问的模式（Bypass Permissions、YOLO、Full Access 等）前先确认；代理的输出和排查日志写进输出面板前先脱敏。
  ACP backends get the same protections as DeepSeek: an approval is blocked while its target file has unsaved changes; switching to a mode that stops asking (Bypass Permissions, YOLO, Full Access…) asks for confirmation; agent output and trace logs are redacted before they reach the output panel.
- ACP 审批卡片：代理提供「始终允许」时多一个按钮。等着审批的会话在会话列表里有提醒点（它的标签可能已经关了）。
  ACP approval cards show the agent's "always allow" option when it offers one. Sessions waiting for approval are flagged in the session list, even after their tab was closed.
- 消息没能发出去（没连上、建不了会话、单会话代理正忙）时，文字会回到输入框。ACP 代理中途退出时，排队的消息保留在队列里；固定的上下文在消息真正发出后才清空。新对话里连发两条消息不再建两个会话。
  When a message cannot be handed over (not connected, session could not be created, a single-session agent is busy) its text returns to the input. Queued messages survive an ACP agent exiting; pinned context is cleared only once the message is accepted. Two quick sends in a new chat no longer create two sessions.
- 输入框上方的待办、未保存提示和改动栏合并成一行状态栏，各占一段，点「待办」或「改动」在上方展开列表。窄侧边栏里底部不再占掉三四成高度。
  The to-do, unsaved-files and changes bars above the input are merged into one status row; click To-dos or the file count to expand the list above it. The bottom of a narrow side bar no longer takes a third of the height.
- 运行中输入了文字时，停止按钮仍然在（和发送并排）；输入框里按 Esc 停止生成。
  The Stop button stays while you type during a run (next to Send); Esc in the input stops generation.
- 标签不再被挤成一个字：放不下时横向滚动。面板拖得很宽时，正文保持在适合阅读的行宽内并居中。
  Tabs scroll instead of shrinking to one character. On a wide panel the conversation keeps a readable line width, centered.
- 修改行里文件名在前、目录在后（太长时省略的是目录）；失败的命令写明「运行失败」；回复里的文件路径（`src/a.ts:12`）和浏览行里读过的文件可以点开；回复右上角有复制按钮。
  Edit rows show the file name first and the directory after it (the directory is what gets truncated); failed commands say "Failed"; file paths in replies (`src/a.ts:12`) and files in a browse row open on click; replies have a copy button.
- 错误提示不再自动消失，有关闭按钮；启动失败的横幅先显示一行，点开看完整信息；首页放不下时可以滚动，不再被裁掉上半截。
  Error toasts stay until dismissed and have a close button; the start-up failure banner shows one line with the rest behind "Show full message"; the home screen scrolls when it does not fit instead of clipping its top.
- 无障碍：链接、警告和错误文字、次要文字的对比度到 4.5:1 以上；按钮的点击区域至少 24px；弹出菜单支持 ↑↓ / Home / End，关闭后焦点回到打开它的按钮；流式输出不再逐段播报，读屏只在开始回复、回复完成、需要你处理时播报一次；页面语言跟随界面语言。
  Accessibility: link, warning, error and secondary text reach 4.5:1; controls are at least 24px; popup menus support ↑↓ / Home / End and return focus to their button; streaming text is no longer announced piece by piece — screen readers hear one message when a reply starts, finishes, or needs you; the page language follows the UI language.
- 面板隐藏时不再按流式输出的节奏计算和推送；长回复流式输出时界面更跟手。
  The extension no longer recomputes and posts at streaming rate while the panel is hidden; long streaming replies stay responsive.

## 0.3.2

**ACP 底层（Claude、oh-my-pi、CodeBuddy）也有多开标签和会话改动栏**；新对话沿用上次选的模型；dsh 底层改叫 DeepSeek；护眼配色、滚动到底部、skill 补全和一轮界面打磨。

**Tabs and the session changes bar on ACP backends (Claude, oh-my-pi, CodeBuddy)**; new chats keep the last chosen model; the dsh backend is shown as DeepSeek; soft colors, scroll to bottom, skill completion and a round of UI polish.

- ACP 底层（Claude、oh-my-pi、CodeBuddy 等）也支持多开标签：新对话开在新标签里，从会话列表打开已在标签里的会话时切过去，后台标签显示运行中和等待审批；打开的标签按底层记住。
  Tabs for ACP backends (Claude, oh-my-pi, CodeBuddy…): a new chat opens a new tab, opening a session that already has a tab switches to it, background tabs show running and waiting-for-approval, and open tabs are remembered per backend.
- 界面细节打磨：流式回复的光标跟在文字末尾（不再单独占一行）；消息下面的「复制 / 编辑后重发」和排队消息的「编辑 / 插队 / 删除 / 现在发送」改成悬停变亮的灰色小图标（窄宽度下不再一个字一行地折行）；未保存文件的提示改成卡片；配置 API Key 页和首页风格一致；输入框的占位文字只占一行；上下文用量过半才显示百分比，平时只显示圆环；改动栏和输入框之间留出间距。
  UI polish: the streaming cursor follows the text instead of taking its own line; message and queue actions are compact gray icons that light up on hover (no more one-character-per-line wrapping when narrow); the unsaved-files notice is a card; the API key page matches the home; the placeholder stays on one line; the context ring shows a percentage only past 50%; the changes bar has a gap above the composer.
- ACP 底层（Claude、oh-my-pi、CodeBuddy 等）也有会话改动栏：输入框上方列出本会话用文件工具改过的文件和增删行数，点文件打开累计 Diff（从当前内容倒着撤回本会话的修改，还原出会话开始前的内容）。命令造成的改动 ACP 代理不上报，不在其中。
  The session changes bar now works on ACP backends (Claude, oh-my-pi, CodeBuddy…): files edited by file tools in this session with line counts; clicking one opens the cumulative diff, rebuilt by undoing this session's edits from the current file. Changes made by commands are not reported by ACP agents and are not included.
- 修复：DeepSeek（dsh）底层输入 `/` 看不到 skill。dsh 的 skill 不在命令列表里，现在另外读取 skill 目录（工作区 `.dsh/skills`、`.agents/skills` 和全局的），补全里带「skill」标签；每次打开会话都重新读取，新装的 skill 也能出现。
  Fixed: skills did not show up after typing `/` on the DeepSeek (dsh) backend. dsh lists skills separately from commands; they are now read on every session open and shown with a "skill" tag.
- 斜杠补全更好找：不区分大小写，名字中间的一段也能搜到（输入 `review` 能找到 `code-review`），名字可以带冒号（`/engineering:code-review`）。
  Slash completion is easier to search: case-insensitive, matches inside names (`review` finds `code-review`), and names may contain colons (`/engineering:code-review`).
- 护眼配色（默认）：对话里的文字不再用接近纯白的主题前景色，正文、标题、次要信息分层柔和，长时间看不累；「字体与字号」里可以关掉改用主题原色（设置 `harnessDeck.ui.palette`），高对比度主题始终用原色。
  Soft colors (default): chat text no longer uses the near-white theme foreground; body, headings and secondary text are toned down for long reading. Turn it off under Font & Size (setting `harnessDeck.ui.palette`); high-contrast themes always use theme colors.
- 「滚动到底部」按钮：往上翻看历史时出现在右下角，翻上去时有新内容会带提示点，点一下回到底部并继续跟随新内容。
  Scroll-to-bottom button: appears while you read earlier messages, shows a dot when new content arrives, and returns to following the conversation.
- 内置底层 dsh 在界面上改叫 **DeepSeek**（命令、网页等指 dsh 程序本身的地方仍写 dsh）；原来的会话和设置不受影响。
  The built-in dsh backend is now shown as **DeepSeek** (places that mean the dsh program itself still say dsh); sessions and settings are unchanged.
- 旧版扩展 DSH Copilot 还装着时（编辑器右键菜单里会多一个「DSH」），启动时提示并可以一键卸载。
  If the old DSH Copilot extension is still installed (it adds the "DSH" editor context menu), Harness Deck offers to uninstall it.
- ACP 底层的新对话沿用上次选的模型和思考等级（按底层记住）。之前 Claude 等代理的模型是按会话设置的，新开的会话总是回到默认模型，和刚才选的不一样；已有的会话仍保持自己的模型。
  New chats on ACP backends use the model and thought level you picked last (remembered per backend). Before, agents such as Claude set the model per session, so a new chat went back to the default model; existing sessions keep their own.
- 修复：回复后面开始调用工具时，前面那段文字末尾一直留着蓝色光标。
  Fixed: the blue cursor stayed after a reply's text once tool calls started.
- 修复：模型网关每次回复都用同一个消息 id 时，工具调用之后的文字被拼到前面的段落里，看起来像中间没有文字；现在按时间顺序另起一段。
  Fixed: with model gateways that reuse one message id, text after tool calls was merged into an earlier paragraph and looked missing; it now starts a new paragraph in order.
- 新设置 `harnessDeck.backendTrace`：把和 ACP 底层收发的消息原文写到「Harness Deck: Backend」输出面板，用来排查代理实际发了什么。
  New setting `harnessDeck.backendTrace`: writes the raw ACP messages to the "Harness Deck: Backend" output channel for troubleshooting.

## 0.3.1

**新的内置底层 Claude**；ACP 代理需要登录时的提示；内部包名改为 `@harness-deck/*`，README 重写。

**New built-in backend: Claude**; clearer sign-in handling for ACP agents; internal packages renamed to `@harness-deck/*` and a rewritten README.

- 新的内置底层 **Claude**：通过 Claude Code 的官方 ACP 适配器（`npm install -g @agentclientprotocol/claude-agent-acp`）接入，登录和设置与 Claude Code 共用；选择卡片、首页和菜单里显示 Claude 的图标。
  New built-in backend **Claude**, through Claude Code's official ACP adapter (`npm install -g @agentclientprotocol/claude-agent-acp`); sign-in and settings are shared with Claude Code. The chooser, home and menu show the Claude icon.
- ACP 底层发消息时才发现需要登录（Claude 没登录或登录过期）：代理有登录方式时先登录再重发这一轮，没有时在对话里说明怎么登录，而不是只显示「Authentication required」。
  When an ACP backend reports that sign-in is needed while sending (Claude signed out or expired), the panel signs in and resends if the agent offers a sign-in method, or explains how to sign in instead of showing "Authentication required".
- 工作区里的内部包改名为 `@harness-deck/shared`、`@harness-deck/webview-ui`；仓库 README 按 Harness Deck 重写（底层对照表、新截图、架构图、各底层的测试方法）。
  Workspace packages renamed to `@harness-deck/shared` and `@harness-deck/webview-ui`; the repository README is rewritten for Harness Deck (backend table, new screenshots, architecture, tests for every backend).

## 0.3.0

**改名为 Harness Deck，支持多个底层：dsh、oh-my-pi、CodeBuddy，以及任何 ACP 代理。** 第一次打开面板时选底层；新首页和新标志；子代理显示。dsh 底层支持 `0.2.1-rc.5` 及以上。

**Renamed to Harness Deck, with switchable backends: dsh, oh-my-pi, CodeBuddy and any ACP agent.** Pick a backend on first open; new home and logo; subagents shown. The dsh backend requires dsh `0.2.1-rc.5` or later.

- 底层可以切换：dsh，以及内置的 ACP（Agent Client Protocol）代理 oh-my-pi（`omp acp`）和 CodeBuddy（`codebuddy --acp`），也可以在设置 `harnessDeck.backends` 里加别的 ACP 代理。「…」→「底层」或命令「切换底层」里切换；每个底层的会话分开保存。
  Switchable backends: dsh, the built-in ACP (Agent Client Protocol) agents oh-my-pi (`omp acp`) and CodeBuddy (`codebuddy --acp`), and any ACP agent added in `harnessDeck.backends`. Switch from "…" → Backend or the Switch Backend command; sessions are kept per backend.
- 第一次打开面板时显示底层选择卡片：每个底层的说明、本机是否已安装，没装的给出可以复制的安装命令；选好或「稍后再说」后不再出现。首页重新设计：渐变标识、当前底层和工作区标签（点击切换底层）、带说明的示例任务、输入提示。选择卡片、首页和菜单里的底层显示官方图标（DeepSeek、oh-my-pi、CodeBuddy）。插件有了自己的标志：两张卡片组成 H，中间的挽带和节点把它们连起来（插件图标、侧边栏图标、首页）。
  On first open the panel asks which backend to use, with a description of each, whether it is installed on this machine and a copyable install command otherwise; it does not ask again once chosen or skipped. Redesigned home: gradient logo, current backend and workspace chips (click to switch backend), example tasks with descriptions, input tips. Backends show their official icons (DeepSeek, oh-my-pi, CodeBuddy) in the chooser, home and menu. New Harness Deck logo: two cards forming an H, joined by a strap and a node (extension icon, sidebar icon, home).
- CodeBuddy：需要登录时选择登录方式（iOA、Google/GitHub、微信、企业域名），在浏览器里完成；也可以用 `CODEBUDDY_API_KEY`。待办（TaskCreate / TaskUpdate）进入输入框上方的状态条，命令输出去掉包装格式，Edit 的 Diff 显示整个文件。CodeBuddy 的一个进程只给一个会话推送回复，切回别的会话发消息时插件会重启 CodeBuddy 并重新加载那个会话（约 2 秒）。
  CodeBuddy: pick a sign-in method (iOA, Google/GitHub, WeChat, enterprise domain) and finish in the browser, or use `CODEBUDDY_API_KEY`. To-dos (TaskCreate / TaskUpdate) go to the status strip, command output is unwrapped, Edit diffs show the whole file. A CodeBuddy process streams to one session only, so sending in another session restarts CodeBuddy and reloads that session (about 2 s).
- ACP 底层支持流式回复和推理、工具行（读文件和搜索合并、命令输出、修改的增删行数和 Diff）、审批、待办、用量、斜杠命令、模型和思考等级、模式（计划模式）、会话列表和重新打开、停止、图片；用真实的 oh-my-pi 和 CodeBuddy 做端到端测试，并每天在 CI 里对它们的固定版本和最新版本各跑一次。
  ACP backends cover streaming replies and reasoning, tool rows (grouped reads/searches, command output, edit line counts and diffs), approvals, to-dos, usage, slash commands, model and thought level, modes (plan), session list and reload, stop and images; tested end to end against real oh-my-pi and CodeBuddy, nightly in CI.
- 插件改名为 Harness Deck：命令、视图和设置从 `dsh.*` 改为 `harnessDeck.*`（原来的设置第一次启动时自动迁移），安装包改名为 `harness-deck-<版本>.vsix`。这是新的扩展 id，升级后可以卸载 DSH Copilot。
  Renamed to Harness Deck: commands, views and settings moved from `dsh.*` to `harnessDeck.*` (old settings are migrated on first start); the package is `harness-deck-<version>.vsix`. It is a new extension id, so DSH Copilot can be uninstalled afterwards.
- 子代理：dsh 派出的子代理显示成一张卡片（任务描述、状态、用时，点开看任务和回答），可以打开子代理自己的对话（只读）。
  Subagents show as a card (task, state, elapsed time; expand for the task and answer) and their conversation can be opened read-only.

## 0.2.3

行内代码不再是醒目的橙色；系统减少动画时加载转圈照常播放。支持 dsh `0.2.1-rc.5` 及以上。

Inline code no longer shows in orange; loading indicators keep animating under reduced motion. Requires dsh `0.2.1-rc.5` or later.

- 加载中的转圈、运行中的圆点和「思考中」在系统「减少动画」时也照常播放（之前全部停住；Windows 关了动画效果或在远程桌面里就是这种情况）。只停掉骨架屏的流光和光标闪烁。
  Spinners, running dots and the "thinking" pulse keep animating when the OS asks for reduced motion (Windows with animation effects off, Remote Desktop); only the skeleton shimmer and cursor blink stop.

- 行内代码不再是醒目的橙色：改用正文颜色，配淡淡的中性底色和描边（之前没设颜色，沿用了 VS Code 默认样式里主题的 textPreformat 色，很多深色主题是橙色）。跨行时每段都有完整描边。
  Inline code no longer shows in the theme's orange preformatted color: it uses the text color on a soft neutral background with a faint outline, and wraps cleanly.

## 0.2.2

粘贴图片、面板内调整字体与字号，修复从插件打开 dsh 网页时登录失败。支持 dsh `0.2.1-rc.5` 及以上。

Paste images, adjust font and size inside the panel, and fix logging in when opening dsh in the browser. Requires dsh `0.2.1-rc.5` or later.

- 「…」→「字体与字号」改为面板里直接调整：字号加减、界面字体、代码字体、恢复默认，立即生效并写入设置 `dsh.ui.*`（之前是跳到 VS Code 设置页，可能找不到对应设置）。
  "…" → "Font and size" now opens an in-panel editor (size stepper, UI and code fonts, reset) that applies immediately and writes `dsh.ui.*`, instead of jumping to the Settings page.

- 支持图片：在输入框里粘贴截图或复制的图片（也可以按住 Shift 拖进来），显示成缩略图，可以移除，随消息发给 dsh，可以只发图片。消息里显示发送过的图片（从 dsh 读取），点击放大。图片被 dsh 拒绝时提示原因。
  Images: paste a screenshot or copied image into the input box (or Shift-drag one in); it shows as a removable thumbnail and is sent with the message, text optional. Sent images appear in the conversation (read back from dsh) and open larger on click.

- 修复「在浏览器中打开 dsh」认证失败：VS Code 的 Uri 会把地址里的 `?token=` 编码成 `?token%3D`，dsh 认不出令牌，返回 401。现在打开的地址和 `dsh web` 打印的完全一样（远程开发时只转发端口）。回复里带参数的链接也不再被改写。
  Fix "Open dsh in browser" failing to log in: vscode.Uri encoded `?token=` as `?token%3D`, so dsh returned 401. The browser now gets exactly the URL `dsh web` prints (only the port is forwarded in remote setups). Links with query strings are no longer rewritten either.

## 0.2.1

运行状态与用时、逐题回答的提问卡片、级联的模型选择、更醒目的强调色、识别带前缀的工具，以及若干界面修正。支持 dsh `0.2.1-rc.5` 及以上。

Run status with elapsed time, step-by-step questions, a cascading model picker, a reliable accent color, prefixed tool names, and UI fixes. Requires dsh `0.2.1-rc.5` or later.

- 识别带前缀或别名的工具：`ops_grep`、`ops_read_files`、`mcp__fs__read_file`、`run_command`、`str_replace_editor` 等按对应的内置工具渲染——连续的读文件和搜索合并成一行「已浏览」，命令显示「已运行」，修改显示文件；一次读多个文件时显示第一个文件和其余数量。
  Prefixed or aliased tools (`ops_grep`, `ops_read_files`, `mcp__fs__read_file`, `run_command`, `str_replace_editor`, …) render like the built-in ones: reads and searches merge into one row, commands show "Ran", edits show the file; multi-file reads show the first file and a count.

- 运行状态：dsh 处理时对话末尾显示正在做什么（思考 / 回复 / 运行命令 / 编辑某文件 / 调用某工具 / 等你处理）和已用时间，每秒刷新；一轮结束后显示「已完成 · 用时 …」（超过 1 秒的轮次）。用时取 dsh 记录的开始和结束时间。
  Run status: while dsh works, the end of the conversation shows what it is doing and the elapsed time, updated every second; finished turns longer than a second show "Done · took …", using dsh's own start and end times.

- 强调色改为运行时从主题里挑第一个有颜色的（主按钮 → 焦点边框 → 链接 → 进度条 → 图表蓝），并配好文字色。按钮、输入框边框和焦点、链接、进度、选中项都用它，按钮和焦点色是灰色的主题下也不会再"没有颜色"。
  The accent color is picked at runtime from the first colorful theme color (button → focus border → link → progress bar → chart blue) with a matching text color, and used for buttons, the input border and focus, links, progress and selections, so themes with gray button or focus colors still look colored.

- 提问卡片逐题回答：多个问题时一次显示一道，顶部显示「第 1 / 3 题」和可点击的进度条，单选后自动进入下一题，可以返回上一题，最后一题才提交。选项改成带单选圈 / 多选框的卡片。
  Questions are answered one at a time: a "1 of 3" counter and clickable progress steps, single-choice answers advance automatically, Back/Next, and Submit on the last question. Options show radio or checkbox marks.

- 回复结尾不再显示改动文件卡片（输入框上方的会话改动栏已经列出）；需要时用设置 `dsh.ui.showTurnChanges` 打开。
  The changed-files card at the end of each reply is hidden by default (the session changes bar lists them); turn it back on with `dsh.ui.showTurnChanges`.
- 代码块和行内代码跟随对话文字的字号（之前代码块用编辑器字号，显得偏大）。
  Code blocks and inline code follow the chat font size instead of the editor's.

- 「在浏览器中打开 dsh」：通过 VS Code 转发端口打开（远程开发时 dsh 的 127.0.0.1 在远端机器上，之前直接打开连不上）；打开后提示当前会话的标题，并可以复制链接。dsh 网页目前没有指向某个会话的地址，只能在它的会话列表里选。
  "Open dsh in browser" goes through VS Code's port forwarding (dsh's 127.0.0.1 is on the remote machine in remote development), then shows the current session's title and a "Copy link" button. dsh's web UI has no per-session URL yet.
- 待办改成卡片：进度条和计数徽标，完成项绿色勾、进行中的项高亮并标「进行中」、待做项空心圈，状态标记连成时间线。
  To-dos are a card with a progress bar and count badge; done items get a green check, the current one is highlighted, pending ones show a hollow circle.
- 模型选择：当前项带勾和强调色底色；有多个思考等级的模型改为级联——先选模型，再在第二级选思考等级（标出当前和默认等级）。
  Model picker: the current item has a check and accent background; models with several reasoning levels open a second level to pick the level.

## 0.2.0

多开会话、会话改动栏、更快的 Diff、字体设置。支持 dsh `0.2.1-rc.5` 及以上。

Tabs for multiple sessions, a session changes bar, faster diffs and font settings. Requires dsh `0.2.1-rc.5` or later.

- 多开会话：「+」在新标签里开始新对话，不再覆盖当前会话；从会话列表打开的会话也放进标签。后台标签的会话继续运行，最近的 4 个后台标签一直跟随，切回时内容立即可见；标签上显示运行中和等待审批。关闭标签不会删除会话。每个标签有自己的输入草稿。
  Multiple sessions as tabs: "+" opens a new tab instead of replacing the current session, and sessions picked from the list open in tabs. Background sessions keep running; the four most recent stay followed so switching back is instant. Tabs show running and needs-attention state; closing a tab keeps the session. Each tab keeps its own draft.
- 图标颜色：强调色改用主题的链接色（不少主题的 focusBorder 是灰色或透明，图标会没有颜色）；空状态的示例任务各有一种颜色。
  Icons use the theme's link color as accent instead of focusBorder (gray or transparent in many themes); the empty-state suggestions each get their own color.

- 会话改动栏：输入框上方列出本会话改过的文件和增删行数，可以展开、收起、隐藏；点击文件打开本会话修改前 ↔ 当前的累计 Diff。
  Session changes bar above the input box: files changed in this session with line counts, collapsible and dismissible; click a file for its cumulative diff.
- 打开 Diff 更快：本轮改动能用会话日志里的工具片段还原时直接在本地还原，不再请求 dsh；只有命令造成的改动才读取 dsh 的记录（超时缩短到 15 秒，结果缓存）。改动汇总同时最多读两个，打开长会话时不再把 dsh 堵住。点击后对应的行显示加载中，重复点击不重复请求。
  Faster diffs: turn diffs are rebuilt locally from the session log when the tool edits explain the turn, and only fall back to dsh for changes made by commands (15 s timeout, cached). Change summaries load at most two at a time. Rows show a spinner while the diff opens; repeated clicks are ignored.
- 打开较早一轮的 Diff 时，右侧是那一轮结束时的内容（之前是当前文件，常常还原失败）。
  Diffs of earlier turns now compare against the content at the end of that turn.
- 字号默认比 VS Code 工作台大 1px；新增设置 `dsh.ui.fontSize`、`dsh.ui.fontFamily`、`dsh.ui.codeFontFamily`，「…」菜单里有「字体与字号」入口。
  Default font size is 1px larger than the workbench; new settings `dsh.ui.fontSize`, `dsh.ui.fontFamily`, `dsh.ui.codeFontFamily`, reachable from "…" → "Font and size".
- 工具活动行之间的间距加大；输入框顶边可以拖动调整高度（双击恢复）。
  More spacing between tool rows; drag the top edge of the input box to resize it (double-click to reset).

## 0.1.0

第一个可用版本。支持 dsh `0.2.1-rc.5` 及以上（已测试到 `0.2.2-alpha.3`）。

First usable release. Requires dsh `0.2.1-rc.5` or later (tested up to `0.2.2-alpha.3`).

### 对话 / Chat

- 侧边栏对话：逐字流式回复、Markdown 和代码高亮、推理过程折叠、停止生成；新建、切换、重命名、按标题搜索会话；加载更早的历史。
  Sidebar chat with streaming replies, Markdown and syntax highlighting, collapsible reasoning and stop; create, switch, rename and search sessions; load earlier history.
- dsh 的队列：回复时继续发送的消息排队，可以编辑、删除、插队；停止后可以「现在发送」。
  Queued messages from dsh's inbox: edit, delete, steer, and send now after a stop.
- 待办和目标状态条、计划模式标记。
  To-do and goal strip, plan-mode badge.

### 工具与改动 / Tools and changes

- 按工具类型显示：连续的读文件和搜索合并成一行，命令显示输出，文件修改显示增删行数。
  Tool rows by type: consecutive reads and searches merge into one row, commands show their output, edits show line counts.
- 用 VS Code 的 Diff 编辑器查看每次修改和每轮改动；dsh 重启后历史 Diff 仍能打开。
  Diffs for every edit and every turn in the VS Code diff editor, still available after dsh restarts.
- 审批卡片（预览将要写入的内容、未保存文件保护）、提问卡片、计划审阅卡片；权限预设切换。
  Approval cards (with a preview of proposed edits and an unsaved-file guard), question cards, plan review; permission presets.

### 编辑器集成 / Editor integration

- 自动附带当前选区或文件（可逐条关闭）、`@` 引用文件、`/` 斜杠命令（插件模板和 dsh 原生命令）、编辑器右键「DSH」菜单。
  Attach the current selection or file (per-message opt-out), `@` file references, `/` commands (templates and dsh's own), editor context menu.
- 多根工作区选择文件夹。
  Folder selection for multi-root workspaces.

### 界面细节 / UI details

- 按钮、菜单项、链接配上图标；点击后要等 dsh 回应的按钮显示加载中。
  Icons on buttons, menu items and links; buttons that wait for dsh show a spinner after you click.
- 上下文用量改成环形进度，随用量变色，悬停显示 token 数。
  Context usage as a ring that changes color with usage; hover for token counts.
- 加载状态：启动、打开会话（骨架屏）、会话列表、模型列表、`@` 搜索、发送中、加载更早的消息、断线重连。
  Loading states for startup, opening a session (skeleton), the session list, models, `@` search, sending, earlier history and reconnecting.
- 空状态加上示例任务；用户消息悬停可以复制、编辑后重发。
  Suggested tasks on the empty state; copy and edit-and-resend on sent messages.

### 运行时 / Runtime

- 自动查找、启动和监控 dsh，意外退出后自动重启并恢复对话；首次使用时引导配置 API Key。
  Finds, starts and supervises dsh, restarts it after a crash and restores the chat; guides you through setting the API key.
- 中英文界面，跟随 VS Code 的显示语言（设置 `dsh.ui.language` 可以覆盖）。
  Chinese and English UI following the VS Code display language (`dsh.ui.language` overrides it).
