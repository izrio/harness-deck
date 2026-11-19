# 更新记录 / Changelog

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
