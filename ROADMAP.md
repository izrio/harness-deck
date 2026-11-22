# Harness Deck 改进路线图（对标 T3 Code）

> 基线：`v0.6.1`（`ea905bb`）。
> 目标：借鉴 [pingdotgg/t3code](https://github.com/pingdotgg/t3code) 在**适配层能力模型、回合级工作流、源码控制闭环、质量门禁、手机端远程互通**上的做法，补齐 Harness Deck 的短板；保持「IDE 插件 + 宿主运行时 + 多底层」核心形态，并通过内嵌桥接与 PWA 延伸至手机端。
> 用法：每完成一项，把对应 `- [ ]` 改成 `- [x]`，并在「进度记录」写一行日期、版本和验证结果。每完成一个里程碑（M0–M5）对照本文件做一次评审，把新发现的遗漏补进来。

状态图例：`待开始` / `进行中` / `已完成` / `搁置`

---

## 0. 对标结论与边界

### 0.1 值得借的

1. **能力放适配器边界**：每个底层自己声明支持什么、不支持时降级到哪里；编排和 UI 不判断厂商。
2. **回合是一等公民**：每轮有独立 id、状态、改动文件、用量和可回滚点，diff / 回滚 / PR 都围绕回合。
3. **工作流闭环**：任务 → worktree → Agent → 审 diff → commit / push / PR。
4. **质量门禁**：测试禁轮询/睡等、隔离用例必须带 issue、模型可见文本用 eval 回归。
5. **文档纪律**：内部设计、用户文档、运维手册分开；维护「每个面都要改到」清单。

### 0.2 不借的

- **Effect + 事件溯源 + outbox + projection**：面向超大规模重放；我们沿用现有 `HostSnapshot` + `ItemsPatch` + `CommandReceipts` 即可支撑多客户端同步，迁移成本远大于收益。
- **自建商业云中继（Clerk + Cloudflare Relay）与独立维护 App Store 原生 RN App**：不背负云账号运营与商店审核成本；手机端互通改走「宿主内嵌 HTTP/WS 桥 + 复用 `webview-ui` 的 PWA + Tailscale / BYO 隧道」（见 M5 与 [docs/MOBILE-INTEROP.md](./docs/MOBILE-INTEROP.md)）。
- **自研工具链**（vite-plus、oxlint、effect-tsgo）：收益不足以抵消迁移成本。
- **为 50 万用户做的性能工程**：保留「掉帧当 bug」的态度即可，不复制具体手段。
- **托管策略（managed policy）、访客链接、多人协作**：面向团队与服务器场景，单机/个人多设备插件收益低；有企业需求再评估。

### 0.3 每项的完成定义（DoD）

一项事务只有同时满足以下条件才算完成：

- [ ] 代码改动 + 对应测试（能复现的行为优先补测试）
- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 通过
- [ ] 涉及界面时，VS Code 与 JetBrains 两端至少各验证一次（见 HD-02；JetBrains 的自动化手段见 HD-20）
- [ ] 涉及协议或底层行为时，跑对应的端到端测试（`pnpm smoke` / `acp-e2e` / `vscode-e2e`，按 `AGENTS.md` 的测试节选择）
- [ ] 涉及文案时，中英文 key 同步（见 HD-04）
- [ ] 涉及用户可见行为时，更新 `packages/extension/README.md` 或对应文档
- [ ] 一项一个 commit；需要发版时按 `AGENTS.md` 的流程同步版本号与 CHANGELOG

---

## 1. 总览

| ID | 优先级 | 事项 | 里程碑 | 状态 |
| --- | --- | --- | --- | --- |
| HD-01 | P0 | 底层能力描述符 | M0 护栏 | 已完成 |
| HD-02 | P0 | 「每个面都改到」清单 | M0 护栏 | 已完成 |
| HD-03 | P0 | 测试纪律 lint 规则 | M0 护栏 | 已完成 |
| HD-04 | P0 | i18n 校验门禁 | M0 护栏 | 已完成 |
| HD-05 | P0 | 底层安装归属检查 | M0 护栏 | 已完成 |
| HD-06 | P1 | 每会话独立 worktree | M1 会话工作流 | 已完成 |
| HD-07 | P1 | 回合级回滚 | M1 会话工作流 | 已完成 |
| HD-08 | P1 | 回合一等模型 | M1 会话工作流 | 已完成 |
| HD-09 | P1 | 源码控制只读面板 | M2 工作流闭环 | 已完成 |
| HD-10 | P1 | commit / push / PR | M2 工作流闭环 | 已完成 |
| HD-11 | P2 | 模型行为 eval | M3 质量与评测 | 已完成 |
| HD-12 | P2 | `check:changed` 增量检查 | M3 质量与评测 | 已完成 |
| HD-13 | P2 | 底层差异与降级文档 | M3 质量与评测 | 已完成 |
| HD-14 | P3 | driver / instance 多账号 | M4 按需 | 已完成 |
| HD-15 | P3 | 侧车连接监督器 | M4 按需 | 已完成 |
| HD-16 | P3 | 幂等 command receipt | M4 按需 | 已完成 |
| HD-17 | P3 | 性能基线 | M4 按需 | 已完成 |
| HD-18 | P3 | 定时任务后台化（sidecar 常驻） | M4 按需 | 已完成 |
| HD-19 | P2 | 文档体系与术语表 | M3 质量与评测 | 已完成 |
| HD-20 | P2 | JetBrains 端冒烟测试 | M3 质量与评测 | 已完成 |
| HD-21 | P3 | ACP 代理注册表导入 | M4 按需 | 已完成 |
| HD-22 | P1 | 多客户端会话总线与 Webview 传输抽象 | M5 手机端互通 | 已完成 |
| HD-23 | P1 | 宿主 HTTP/WS 桥接与局域网 QR 配对 | M5 手机端互通 | 已完成 |
| HD-24 | P1 | 移动端响应式界面与 PWA 适配 | M5 手机端互通 | 已完成 |
| HD-25 | P1 | 移动端内嵌 Diff 审阅与无 IDE 动作降级 | M5 手机端互通 | 已完成 |
| HD-26 | P2 | 公网穿透（Tailscale 优先 + BYO 隧道） | M5 手机端互通 | 已完成 |
| HD-27 | P2 | 移动端推送通知（Web Push + Webhook） | M5 手机端互通 | 已完成 |
| HD-28 | P3 | 脱离 IDE 的独立守护进程模式 | M5 手机端互通 | 已完成 |

执行顺序建议：**M0–M4 已全部完成**；M5 手机端互通按 **HD-22 → HD-23 → HD-25 → HD-24（可与 HD-25 并行）→ HD-26 → HD-27 → HD-28** 推进。详细调研与架构约束见 [docs/MOBILE-INTEROP.md](./docs/MOBILE-INTEROP.md)。

版本映射（非承诺，只作对照锚点）：M0 → `v0.7.0`，M0+M1 → `v0.8.0`，加 M2 → `v0.9.0`，M3 收尾 → `v1.0.0`，M5 手机端互通 MVP（HD-22–25）→ `v1.1.0`，M5 跨网与推送（HD-26–27）→ `v1.2.0`。

---

## 2. M0 护栏（先做，成本低、收益立竿见影）

### HD-01 底层能力描述符

- **目标**：新增或修改一个底层时，只改它的描述符，UI 和编排自动适配；不再在组件里写 `kind === 'claude'`。
- **现状**：
  - `packages/shared/src/providers.ts:293` 的 `backendProtocolCapability()` 用底层 id 字符串硬编码协议支持。
  - `profile.kind` 分支约 23 处，`BackendView`（`packages/shared/src/viewModel.ts:418`）只暴露 `kind`，没有能力集合。
- **借鉴**：t3code 的 `ProviderAdapter` 边界 + `docs/user/permission-modes.md` 的「支持 / 降级 / 不支持」写法。
- **做法**：
  1. 在 `packages/shared/src/capabilities.ts` 定义 `BackendCapabilities`：
     - `protocols`、`quota`、`webUi`、`apiKeySetup`、`approvalHint`、`steer`、`turnChanges`、`subagents`、`questions`、`goal`、`images`、`rollback`、`worktree`
     - **权限档位不重复放进来**：已核实它随会话由 `PermissionState.options` 从底层下发
     - `rollback` 先统一为 `'none'`，HD-07 的 spike 后再改
  2. 每个 backend 工厂（`backend/dsh.ts`、`acp.ts`、`claude.ts`、`pi.ts`、`zcode.ts`）返回自己的描述符。
  3. `BackendView` 增加 `capabilities`，随快照下发。
  4. Webview 的能力判断改为读描述符；不支持的控件隐藏或置灰并显示原因。
  5. 把 `backendProtocolCapability()` 迁移为描述符上的字段，删除 id 判断。
  6. 红线：探测与健康检查必须只读、无副作用（不启动 MCP、不触发登录浏览器）。当前 `probeCommandVersion()` 只跑 `<cmd> --version`，符合要求；新增探测保持这条红线。
- **改动点**：`packages/shared/src/capabilities.ts`（新增）、`packages/shared/src/providers.ts`、`packages/shared/src/viewModel.ts`、`packages/extension/src/backend/profiles.ts`、`packages/extension/src/quota/provider.ts`、`packages/webview-ui/src/components/Interactions.tsx`、`settings/agents/BackendCard.tsx`、`preview/mockData.ts`。
- **验收**：
  - 新增一个自定义 ACP 底层，只写描述符，设置页与输入框自动隐藏不支持项。
  - 全仓库 `grep "kind === 'claude'\|kind === 'pi'\|kind === 'zcode'\|kind === 'dsh'"` 不再出现在业务组件中（协议实现内部允许保留）。
  - 每个内置底层至少有一条测试断言其描述符与预期一致。
- **风险**：描述符与实际能力漂移。缓解：为每个底层保留一条冒烟用例；描述符字段只增不改语义。

### HD-02 「每个面都改到」清单

- **目标**：把 t3code 的 “Hit every surface” 改造成我们的清单，减少「VS Code 好了、JetBrains 漏了」这类缺陷。
- **做法**：在 `AGENTS.md` 增加一节「改动自检清单」，至少覆盖：
  - 入口：对话、命令面板、设置页、右键菜单、状态栏
  - 客户端：VS Code Webview、JetBrains JCEF、宿主公共层
  - 底层：dsh、ACP、Claude、Pi、ZCode，每项明确「支持 / 不支持 / 降级」
  - 契约：`packages/shared` 的类型与 `bridge.ts` 的消息
  - 反向状态：新增入口必须同时有退出、撤销或查看方式
  - 语言：`extension/src/i18n.ts` 与 `webview-ui/src/i18n.ts`
  - 文档：README / 使用说明 / DESIGN
  - 测试：单测、ACP e2e、VS Code e2e 各自是否需要补
- **验收**：清单进入 `AGENTS.md`；下一次跨端改动的 commit 说明里能对应勾选。
- **风险**：清单太长被忽略。控制在 8 条以内，每条一句话。

### HD-03 测试纪律 lint 规则

- **目标**：把 t3code 的测试规则变成可执行的检查，而不是口头约定。
- **做法**：在 `eslint.config.mjs` 增加 3 条自定义规则（只作用于测试文件）：
  1. `no-sleep-in-tests`：禁止 `setTimeout` / `sleep` / 空转等待；应等待具体事件或 promise。
  2. `no-wall-clock-in-tests`：禁止用 `Date.now()` / `performance.now()` 差值做断言；断言事件和次数。
  3. `quarantine-needs-issue`：`it.skip` / `describe.skip` 上一行必须是 `// quarantine: #<issue> <原因>`。
- **验收**：在测试里故意写 `await new Promise((r) => setTimeout(r, 100))`，`pnpm lint` 报错；正常测试不受影响。
- **风险**：误伤现有的合法等待。先以 `warn` 上线，清理完存量后改 `error`。

### HD-04 i18n 校验门禁

- **目标**：中英文的占位符一致性与 key 卫生不再靠人眼对齐。
- **现状**（已核实）：`extension/src/i18n.ts` 与 `webview-ui/src/i18n.ts` 都用 `zh` 推导 `en` 的类型，**缺失 key 已被 `pnpm typecheck` 挡住**。真正没挡住的是：① `{0}` 占位符数量——`en` 的类型只约束 key 存在，不约束占位符一致；② 未使用 key 无检查；③ 同一文件里的重复 key。
- **做法**：
  1. 新增 `scripts/check-i18n.mjs`：解析两套 i18n 文件，检查占位符一致、同文件重复 key、未使用 key（缺失 key 交给现有类型检查，不重复做）。
  2. 加 `pnpm check:i18n`，并接入 CI。
  3. 输出按文件分组，失败时给出可直接复制的修复片段。
- **验收**：
  - 把某个 `en` 值里的 `{0}` 删掉，脚本失败并指出占位符不匹配。
  - 删除代码里某 key 的唯一使用点，脚本给出未使用警告。
  - 缺失 `en` key 仍由 `pnpm typecheck` 挡住（脚本不重复检查此项）。- **风险**：动态拼 key 会误报「未使用」。维护一份白名单，按前缀匹配。

### HD-05 底层安装归属检查

- **目标**：不再用 `npm install -g` 覆盖用户通过 Homebrew / mise / Volta 安装的底层。
- **现状**：`packages/extension/src/backend/npmManager.ts:287` 直接执行 `npm install -g <pkg>`。
- **借鉴**：t3code `docs/internals/providers.md` 的「Provider updates run only through the owning installer」。
- **做法**：
  1. 安装/切换版本前，解析当前可执行文件的真实路径（`which` + `realpath`）。
  2. 判断是否位于 `npm prefix -g` 的 `bin` 下；是才允许 npm 操作。
  3. 否则返回 `{ owned: false, manualCommand }`，界面只展示手动命令与说明，不执行。
  4. 在日志里记录判定依据，便于排查。
- **验收**：模拟 Homebrew 路径（或用一个假的可执行文件）时，安装按钮改为「复制命令」，不调用 npm；npm 安装的底层行为不变。
- **风险**：pnpm / Bun / Yarn 的全局目录布局不同。先覆盖 npm 与 Homebrew，其余按「不归我管」处理。
- **Windows**：用 `where` 定位，解析 `.cmd` / `.ps1` shim 指向的真实目标后再判定；判定不了的一律走手动命令，不做 npm 操作。

---

## 3. M1 会话工作流

### HD-08 回合一等模型

- **目标**：为回滚、按回合查看 diff、按回合统计用量和生成 PR 打基础。
- **现状**：视图模型里有 `turnDone` 条目和 `seq`，但没有统一的回合记录；各底层投影各写各的。
- **借鉴**：t3code 的 `thread / turn / run / turn_item` 分层（只借概念，不借事件溯源）。
- **做法**：
  1. 在 `packages/shared/src/viewModel.ts` 增加 `TurnView`：
     - `id`、`seq`、`startedAt`、`endedAt`、`status`（`running | completed | failed | interrupted`）
     - `authoredPaths`（本轮真正改过的文件）
     - `usage`（可选，沿用现有用量结构）
     - `rollback`（`none | native | checkpoint`，来自能力描述符）
  2. 两种投影（dsh / ACP）都填充 `TurnView`，界面按 `TurnView` 渲染回合头。
  3. 会话快照增加 `turns`，保留现有条目结构，避免一次性大改。
- **验收**：打开一个多轮会话，每轮能定位到自己的改动文件与用量；历史会话回放不丢回合。
- **风险**：旧快照没有 `turns`。加载时按现有条目惰性合成，不做持久化迁移。

### HD-07 回合级回滚

- **目标**：能「回到这一轮之前」，而不只是看 diff。
- **现状**：Diff 是从工具片段反推的（`packages/extension/src/vm/diffs.ts`），只能看不能恢复；没有回滚入口。
- **借鉴**：t3code 每回合 checkpoint + provider 原生 rollback；不能回滚的 provider 在改文件前就拒绝。
- **做法**：
  1. 调研结论：dsh / Claude / Pi / ZCode / ACP 都没有会话级原生回滚；dsh 的投影记录了每个文件的工具片段，可以按片段反推本轮开始前的内容。
  2. 已实现（dsh）：最后一轮的 `turnDone` 旁显示「恢复本轮文件」；写盘前弹窗确认，任何文件无法可靠还原、或有未保存内容时整体放弃，不写一半。对话不回退，描述符标记为 `rollback: 'files'`。
  3. 其他底层：`rollback: 'none'`，不显示入口。
  4. 与 HD-06 的交叉：worktree 会话的回滚只作用于当前激活的 worktree；切回主工作区不会受影响。
  5. git checkpoint（hidden ref）仍作为第二阶段单独评估；它涉及写 git 对象，需要先修订 DESIGN 的 D6「插件不写工作区」。
- **验收**：dsh 能恢复最后一轮的文件且对话保持不变；有未保存文件/片段不足时拒绝；其他底层不出现可点击入口；回滚失败不破坏当前分支（本实现不碰 git）。
- **风险**：不同底层的「回滚」语义不一致（只回滚对话 / 只回滚文件）。必须在描述符里写清，并在 UI 上说明。

### HD-06 每会话独立 worktree

- **目标**：一个窗口里一次运行一个独立 worktree 会话，与主工作区隔离；其他工作区的会话保留在标签与历史里。
- **现状**：已有 `createProjectWorktree()`（`packages/extension/src/projects/ProjectService.ts:294`），但只在项目设置里手动触发。
- **借鉴**：t3code「每个 thread 可以有自己的 worktree」；本实现先做串行化版本。
- **做法**：
  1. 会话列表侧栏新增「在 worktree 中新建会话」按钮；输入分支名后复用 `createProjectWorktree`（复制文件、准备命令）。
  2. 创建成功后整窗切换到该 worktree，再开一个新会话；同一时间只有一个工作区活动（串行化），其他会话不会并行收事件。
  3. 切换失败保留原工作区并提示原因；worktree 路径与分支在项目列表/改动模块可见。
  4. 跨工作区切换复用 `switchWorkspace()`，与项目切换走同一条路径。
- **验收**：从会话侧栏能创建 worktree 并直接开始会话；窗口切换到新 worktree；切回原项目后原会话仍在标签/历史里；不声称并行。

---

## 4. M2 工作流闭环

### HD-09 源码控制只读面板

- **目标**：先让用户在工作台里看清「这个会话改了什么」，不写任何东西。
- **做法**：
  1. 新增宿主侧 `SourceControlService`：识别 git 根、remote、当前分支、staged / unstaged / untracked、与基线的 diff。
  2. 工作台增加「改动」视图，按会话的 `authoredPaths` 过滤；点击打开现有 Diff。
  3. 只读，不执行 commit / checkout / stash。
- **验收**：在测试仓库能正确列出三类改动；未跟踪文件可打开；不修改工作区。
- **风险**：大仓库 status 慢。加超时与上限，超过阈值只显示摘要。

### HD-10 commit / push / PR

- **目标**：把「任务 → worktree → Agent → 审 diff → 提交」接上。
- **借鉴**：t3code 的 source-control provider 结构与「一个按钮完成 commit / push / PR」。
- **做法**：
  1. 检测 `gh` / `glab` / `fj`（先支持 GitHub，再 GitLab / Gitea），显示是否可用与登录状态。
  2. 提交前展示将要提交的文件与 diff；commit message 可由当前回合摘要生成，用户可改。
  3. push 与 PR 必须二次确认；PR 标题/正文可编辑。
  4. **不保存 token**，依赖 CLI 自己的凭据。
  5. 失败时保留草稿，不丢用户输入。
  6. 第二阶段：PR 合并后自动把关联的看板任务标为完成（t3code settlement 的轻量版——定时重查 PR 状态，不做归档以外的自动动作）。
- **验收**：在测试仓库完成一次 commit → push → 创建 PR；未登录时给出安装/登录提示；不会覆盖已有 remote 或强推。
- **风险**：不同 forge 的 CLI 参数差异。先做 GitHub 一条链路，其余按能力描述符渐进。

---

## 5. M3 质量与评测

### HD-11 模型行为 eval

- **目标**：改 skill / MCP 工具描述 / 会话标题提示词时，能知道行为有没有变差。
- **借鉴**：t3code `evals/` 的「一个 eval 一个入口 + cases 即数据 + 跑多次 + 与基线比较」。
- **做法**：
  1. 新建 `evals/`，先做 3 个 case：skill 选择、MCP 工具调用、会话标题生成。
  2. 直接 import 现有提示词与工具描述，不复制文本。
  3. 手动运行、记录成本，不进 CI；CI 只跑 grader 的单测。
- **验收**：修改一段提示词后，同一 case 的前后结果可对比；case 在旧文本上失败、新文本上通过。
- **风险**：真实模型调用有成本。默认只跑 1 个 case、1 个样本，确认流程后再加量。

### HD-12 `check:changed` 增量检查

- **目标**：提交前只跑受影响包的检查，减少等待。
- **做法**：脚本读取 `git diff --name-only` 与 `git diff --cached --name-only`，按包映射到 `typecheck` / `test` / `lint`；根配置变更时回退全量。映射可借 pnpm `--filter` 的依赖图（含反向依赖），也可以自写固定映射（我们的包图只有 `shared → extension / webview-ui`，固定映射更直观）。
- **验收**：只改 `packages/shared` 时，自动跑 `shared` 及其依赖方（extension、webview-ui）；只改文档时不跑测试。
- **风险**：映射漏包。首次上线与全量 CI 并行跑一周，对比结果。

### HD-13 底层差异与降级文档

- **目标**：用户和开发者都能查到「这个底层支持什么、不支持时怎么办」。
- **做法**：在 `packages/extension/README.md` 增加一张矩阵：权限、回滚、worktree、MCP、图片、排队/插队、用量；每项写「支持 / 降级为 X / 不支持」。数据尽量从 HD-01 的描述符生成，避免手写漂移。
- **验收**：矩阵与描述符一致；新增底层时必须补一行。
- **风险**：文档滞后。加一个脚本比对描述符与文档表格的底层列表。

### HD-19 文档体系与术语表

- **目标**：把「为什么这么设计」和「怎么用」分开，降低后续维护（包括 AI 协作）的阅读成本。
- **借鉴**：t3code 的 `docs/internals`（跨组件约束与陷阱）、`docs/user`（任务导向）、`docs/operations`（维护流程）三分 + `AGENTS.md` 术语表。
- **做法**：
  1. 恢复/整理 `docs/`：从 DESIGN.md 拆出「内部约束与陷阱」（对应 internals）与「里程碑记录」（对应 operations）；使用说明保持用户视角。
  2. 在 `AGENTS.md` 增加术语表：底层（backend）、会话、回合（turn，HD-08 之后启用）、工作台、worktree 会话、宿主运行时等，8–12 条即可。
  3. 写作规则借 t3code：代码能回答的不进文档；跨边界的理由才进 internals；文档索引只更新受影响的条目。
- **验收**：三个入口边界清晰；术语表与代码用法一致；README 的文档索引指向新结构。
- **备注**：`docs/` 当前在工作区处于删除状态（未提交），动手前先确认保留范围。

### HD-20 JetBrains 端冒烟测试

- **目标**：让 DoD 的「双端验证」有自动化手段，而不是只靠手点。
- **现状**（已核实）：`packages/jetbrains` 只有 1 个测试文件（`src/test/.../protocol/JsonRpcTransportTest.kt`，100 行）；sidecar 启动、消息往返、UI 加载均无自动化。
- **做法**：
  1. 第一步：协议级冒烟——启动真实 sidecar 进程，断言一轮「快照 → 发消息 → 收增量」的往返；与 `JsonRpcTransportTest` 同栈（Kotlin 侧）实现。
  2. 第二步（可选）：CI 里用 IntelliJ 远程运行时跑一次插件启动冒烟；成本过高则保持本地手动触发并写明触发方式。
- **验收**：改动 `packages/shared` 或 sidecar 协议后，跑该冒烟能抓到不兼容；CI 流程有对应 job 或说明。
- **风险**：Gradle + IntelliJ 平台依赖导致 CI 变慢。第一步不依赖 IntelliJ 运行时，保持秒级完成。

---

## 6. M4 按需（有明确需求再做）

### HD-14 driver / instance 多账号

- **目标**：同一底层可以配多个账号（例如工作 / 个人 Claude），互不共享会话与凭据。
- **借鉴**：t3code 的 `driverKind` 与 `instanceId` 分离。
- **做法**：把 `BackendProfile.id` 拆成 `driver` + `instanceId`；配置迁移；会话记录带 instance。
- **已实现**：`BackendProfile` 增加可选 `driver` / `instanceId`，旧数据分别回退到 `kind` / `id`；`harnessDeck.backends` 支持显式 `instanceId`；`profileView` 下发这两个字段。历史会话仍按 `id`（即实例 id）保存，不需要迁移。
- **触发条件**：出现真实的多账号需求，否则不做。

### HD-15 侧车连接监督器

- **目标**：JetBrains sidecar 或未来的远程客户端断线后能稳定重连。
- **借鉴**：t3code `client-runtime/connection/supervisor.ts` 的「单一重试 owner + 抖动退避 + 健康探测」。
- **做法**：只借规则，不引入整个 client-runtime；先做连接状态机与探测，不做离线缓存。
- **已实现**：Sidecar 异常退出后清空 transport，1.5 秒后重启；5 分钟内最多 3 次，避免崩溃循环。健康探测留到远程多客户端场景。
- **触发条件**：sidecar 支持远程连接或多客户端。

### HD-16 幂等 command receipt

- **目标**：发送、审批、定时任务触发在重试时不重复执行。
- **做法**：给命令加 `commandId`，宿主保存短期回执；重复 id 直接返回上次结果。
- **已实现**：`sendMessage` / `respondApproval` / `answerQuestion` / `runScheduleNow` 由 Webview 生成 `commandId`，宿主 `CommandReceipts` 在 5 分钟内去重（`packages/extension/src/host/receipts.ts`）。
- **触发条件**：定时任务或后台运行出现重复触发。

### HD-17 性能基线

- **目标**：把「掉帧当 bug」落到可测量。
- **做法**：记录会话列表首屏、快照大小、流式推送合并次数；设预算，超预算在 CI 输出警告（不阻塞）。
- **已实现**：`pnpm perf:check` 测快照 JSON 大小、`deriveTurns` 与 `buildThreadRows` 耗时，预算写在脚本里；CI 步骤只警告。
- **触发条件**：会话数量或历史长度明显增长后。

### HD-18 定时任务后台化（sidecar 常驻）

- **目标**：IDE 关闭后定时任务仍然执行（t3code 的 background service 形态）。
- **现状**（已核实）：`WorkbenchHub` 用 15 秒 `setInterval`（`TICK_INTERVAL_MS`）在扩展宿主里轮询，窗口关闭任务即停。
- **做法**：复用 JetBrains 已有的 sidecar 进程做无头宿主，把 `UnattendedRunner` 的执行路径跑进去；结果写回共享存储，IDE 下次打开时补看板；需要单实例锁避免与 IDE 里的调度重复触发。
- **已实现**：sidecar 初始化时若存在启用的定时规则，会以 detached 方式拉起 `sidecar.cjs --headless-scheduler <configRoot> <projectPath>`；后台进程用文件存储 + `UnattendedRunner` 执行规则，写回 `global-state.json`。`scheduler.lock` 保证单实例；IDE 侧的 `WorkbenchHub` 检测到锁被其他进程持有就跳过自动触发，手动「立即执行」仍可用。集成测试在无 IDE 宿主里跑通一条到期规则。
- **已知限制**：后台进程无法读取 IDE 的 PasswordSafe，绑定第三方服务商密钥的调度需要后续接入凭据桥；原生代理自带的登录状态不受影响。
- **触发条件**：用户明确提出「关掉 IDE 也要跑」，或定时任务的使用反馈说明这是主要痛点。
- **风险**：无头进程与 IDE 同时运行会抢会话与凭据；需要结果合并策略。

### HD-21 ACP 代理注册表导入

- **目标**：像 t3code 的 ACP Registry 一样，从社区注册表一键发现并配置新的 ACP 底层。
- **做法**：拉取注册表清单（离线内置或按需下载），选中后落到现有 `harnessDeck.backends` 配置；装完后的能力展示沿用 HD-01 的描述符。
- **已实现**：设置 -> Agent -> ACP 注册表，填写 HTTPS 地址后读取；条目校验后展示安装命令，点「添加」落到 `harnessDeck.backends`。不内置任何假条目，也不自动安装。
- **触发条件**：社区 ACP 代理数量明显增长、手动配置成为摩擦点时再做。
- **风险**：注册表来源与更新策略需要安全评估（下载与执行的边界）；第一版只做「发现 + 展示安装命令」，不代跑安装。

---

## 7. M5 手机端互通（架构详解见 [docs/MOBILE-INTEROP.md](./docs/MOBILE-INTEROP.md)）

### HD-22 多客户端会话总线与 Webview 传输抽象

- **目标**：在不破坏现有 VS Code / JetBrains 体验的前提下，让宿主同时服务本地 IDE Webview 与多个远程客户端，且单播与广播分离。
- **现状**：
  - `HarnessHostRuntime` 通过单一 `platform.postToWebview(msg)` 广播；收到 `ready` 会把完整 `snapshot` 发给全部视图。
  - `packages/webview-ui/src/vscode.ts`（58 行）直接调用 `acquireVsCodeApi()`；`App.tsx` 通过 `window.addEventListener('message')` 收消息。
- **借鉴**：t3code `packages/client-runtime` 的共享传输抽象与 `EnvironmentSupervisor`（单一重试 owner + 抖动退避 + 切回前台健康探测）。
- **做法**：
  1. 在 `packages/extension/src/host/` 新增 `ClientHub`：管理已连接客户端（`id`、`surface: 'ide' | 'mobile-web'`、`scope`、`send()`），支持 `broadcast(msg)` 与 `sendTo(clientId, msg)`。
  2. 改造 `HarnessHostRuntime.handleWebviewMessage(msg, clientId?)`：`ready` 的 `snapshot` 及请求级响应（`fileCandidates`、`markdownPreview`、`diffContent`、`quotaFetched`、`providerModelsFetched`、`restoreDraft`）按 `clientId` 单播；会话流、审批、工作台状态更新继续广播。
  3. 改造 `packages/webview-ui/src/vscode.ts` 为双模 `Transport`：存在 `acquireVsCodeApi` 时走 IDE 模式；浏览器环境走 `WebSocketTransport` + `localStorage` 状态持久化 + `ConnectionSupervisor`（心跳 15s、指数抖动退避 1s–30s、`visibilitychange`/`online` 立即重连并重发 `ready`），沿用 HD-16 `commandId` 防重。
  4. `packages/shared/src/bridge.ts` 增加 `ClientSurface`（`'ide' | 'mobile-web'`）与连接状态字段。
- **验收**：
  - 单测覆盖 `ClientHub` 单播/广播隔离与 `ConnectionSupervisor` 断线重连/退避状态机。
  - 模拟两个客户端并发连接：客户端 B 重连发 `ready` 时，客户端 A 不收到多余 `snapshot`；任一端发消息或审批，双端实时同步。
- **风险**：旧测试直接 stub `platform.postToWebview`。缓解：`ClientHub` 默认注册一个 `ide` 通道代理到原 `postToWebview`，保持现有测试零改动通过。

### HD-23 宿主 HTTP/WS 桥接与局域网 QR 配对

- **目标**：在 VS Code 与 JetBrains 中一键开启局域网手机互通，扫码即连，且安全边界清晰、随时可吊销。
- **借鉴**：t3code `docs/internals/environment-auth.md` 的「宿主自主颁证 + 一次性短效配对码 + 作用域最小化 + 已授权设备管理与吊销」。
- **做法**：
  1. 新增 `packages/extension/src/remote/`：
     - `RemoteBridgeServer.ts`：默认关闭；启用后基于 Node `http` + 现有 `ws` 托管 `dist/webview` 静态资源、`/api/pair`、`/ws` 与 `/manifest.webmanifest`。
     - `PairingManager.ts`：生成 5 分钟单次有效 `pairCode`（放于 URL `#fragment`，不进查询串与访问日志），恒定时间校验，失败 5 次自动作废。
     - `DeviceAuthStore.ts`：持久化已授权设备（`deviceId`、名称、令牌哈希、`scope: 'read-only' | 'operate'`、创建时间、最后活跃时间），下发 `HttpOnly; SameSite=Strict` Cookie；支持单设备吊销并即时踢断对应 WS。
     - `ScopeGuard.ts`：`Host`/`Origin` 防 DNS Rebinding 校验；`read-only` 仅允许只读消息；`operate` 默认禁止高危宿主配置写操作（`installBackend` / `uninstallBackend` / `upsertBackendProfile` / `deleteBackendProfile` / `upsertProvider` / `deleteProvider` / `upsertMcpServer` / `deleteMcpServer` / `configureApiKey` / `setPreferences.advanced`）。
  2. 接入 VS Code（`extension.ts`）与 JetBrains Sidecar（`sidecar/server.ts`），状态与授权设备列表同步进 `HostSnapshot.remote`。
  3. 设置页新增「远程互通」Tab（仅使用 `shadcn-ui` + `beautifului` + Iconify 离线图标，配对二维码采用轻量本地 SVG 渲染，零外网请求）：总开关、LAN 网卡地址选择、作用域选择、生成配对 QR 码、已授权设备列表与一键吊销、全部断开急停按钮；同步注册命令面板命令与中英文文案。
- **验收**：
  - 集成测试起真实 `RemoteBridgeServer`：校验未配对 WS 拒连 → 一次码换 Cookie → 二次复用配对码失败 → WS 建连拿快照 → `read-only` 发 `sendMessage` 被拒 → `operate` 试图 `installBackend` 被拒 → 吊销设备后 WS 立刻关闭且重连失败。
  - VS Code 与 JetBrains 两端实测局域网手机扫码打开面板并同步对话。
- **风险**：本机多网卡（Docker/WSL/VPN 虚拟网卡）导致生成的 LAN IP 手机连不上。缓解：过滤常见虚拟网卡前缀并允许用户在设置页下拉切换绑定/广播 IP。

### HD-24 移动端响应式界面与 PWA 适配

- **目标**：把现有 `packages/webview-ui` 在手机竖屏（375–430px）上的对话、审批、切换会话与工作台体验打磨到顺手可用，并支持 PWA 主屏全屏运行。
- **做法**：
  1. 利用已有 `useIsMobile()`（`<768px`）与 `clientSurface === 'mobile-web'` 优化移动端布局：
     - 顶栏紧凑化、标签栏支持横向惯性滚动；会话列表侧栏在窄屏下改为 `shadcn-ui` `Sheet` 抽屉。
     - 审批卡片、提问卡片与底部输入框适配 `env(safe-area-inset-bottom)` 与 `visualViewport` 软键盘高度，避免按钮被底部手势条或键盘遮挡（t3code 移动端高频痛点）。
     - 主要可点控件（审批按钮、停止按钮、标签切换）触控热区 ≥ 44px；代码块与 Diff 表格支持横向滚动且不撑破整页。
     - 顶部增加连接状态胶囊（已连接 / 重连中 / 离线，点击手动重连）。
  2. 新增 PWA `manifest.webmanifest`、应用图标与最小 Service Worker（缓存静态壳，WS 与 API 走网络），在 Vite 构建（`packages/webview-ui/vite.config.ts`）时一并输出到 `dist/webview`。
- **验收**：
  - 在 390×844 视口（含 iOS Safari / Android Chrome 模拟与真机）下无横向溢出、审批卡片与输入框不被键盘遮挡、可添加到主屏幕全屏打开。
  - 新增组件与图标严格通过 `pnpm lint` 与 UI/Iconify 规范检查。
- **风险**：iOS Safari 键盘弹出时 `100vh` 错位。缓解：采用 `100dvh` + `visualViewport` 监听动态调整底边距。

### HD-25 移动端内嵌 Diff 审阅与无 IDE 动作降级

- **目标**：解决「手机端没有 IDE Diff 编辑器和原生弹窗」的闭环问题，使手机能独立完成审 diff、批命令、控权限与提交代码。
- **现状**：`openDiff` / `openSourceControlDiff` / `previewApproval` 依赖 `vscode.diff` 或 IDEA Diff；`workbench.confirm` / `workbench.input` / `pickOpenDialog` 弹在桌面 IDE。
- **做法**：
  1. 在 `packages/shared/src/bridge.ts` 新增 `diffContent`（Host → Webview）消息，携带路径、语言、改动前/后文本或 unified hunk 及摘要统计。
  2. 当 `openDiff` / `openSourceControlDiff` / `previewApproval` 来自 `mobile-web` 客户端时，宿主复用 `vm/diffs.ts` 与 `gitStatus.ts` 计算内容并单播 `diffContent`；Webview 用 `shadcn-ui` `Dialog` / 全屏 `Sheet` + 现有代码高亮与 Diff 渲染能力就地展示（支持 unified / 行号 / 增删统计）。
  3. 梳理所有依赖 `workbench.confirm` / `workbench.input` / `pickOpenDialog` / `openFile` / `openHostSettings` 的路径：
     - 危险操作确认（切换 `danger-full-access`、回合回滚、`sourceControlPush`、`sourceControlCreatePr`）与文本输入（`renameSession`、`createWorktree` 分支名）在移动端改为 Webview 内 `Dialog` 完成确认/输入后带参数提交，不触发桌面 IDE 阻塞弹窗。
     - IDE 专属能力（本地文件选择器 `pickFiles`、在编辑器打开文件 `openFile`、打开 IDE 设置 `openHostSettings`、项目打开新窗口 `openProject`）在移动端优雅隐藏或降级（例如点击文件路径在手机端改为只读内容预览）。
- **验收**：
  - 手机端点击工具活动行、本轮改动卡片、审批前预览与工作台「改动」列表，均可弹出内嵌 Diff 视图且内容与 IDE 一致。
  - 手机端执行回滚、切 `danger-full-access`、重命名会话、commit/push/PR 时，桌面 IDE 不弹出阻塞模态框，全流程在手机端完成。
- **风险**：超大文件 Diff 卡顿手机浏览器。缓解：超过阈值（如 200KB / 2000 行）按 hunk 截断并提示「文件过大，仅展示变更上下文」。

### HD-26 公网穿透（Tailscale 优先 + BYO 隧道）

- **目标**：在零自建云中继的前提下，让用户在离桌/外出使用 4G/5G 时安全连回开发机，并获得 HTTPS/WSS 环境（解锁完整 PWA 与 Web Push）。
- **借鉴**：t3code 的多路由（LAN / Tailscale / 隧道）连接思路与 `tailscale serve` 模式。
- **做法**：
  1. **Tailscale 集成**（遵循 HD-01 探测无副作用红线）：只读执行 `tailscale status --json` 探测本机 Tailnet 状态与 MagicDNS 域名；提供一键配置/引导 `tailscale serve` 将本机桥接端口反代为 `https://<node>.<tailnet>.ts.net`，在设置页生成对应 HTTPS 二维码。
  2. **BYO 自带隧道**：设置页支持填写用户自定义外部 HTTPS 入口（如 `cloudflared tunnel` / `frp` / 自有反代域名），自动加入 `Origin`/`Host` 校验白名单并生成外部配对二维码。
  3. **多路由信息展示与客户端回退**：配对页清晰区分「局域网 / Tailscale / 自定义隧道」三条入口，并允许手机端在保存的多个候选地址间自动回退尝试（LAN 优先，不通切 Tailscale/隧道）。
- **验收**：
  - 单测覆盖 `tailscale status --json` 解析（在线/未登录/未安装）与白名单校验。
  - 实测经 Tailscale HTTPS 扫码连入，WSS 正常、PWA 可安装。
- **风险**：不同操作系统下 `tailscale` CLI 权限策略不同（部分系统需 `tailscale serve` 授权）。缓解：探测失败或无权限时降级为展示可一键复制的准确命令，不做越权提权操作。

### HD-27 移动端推送通知（Web Push + Webhook）

- **目标**：离开电脑后，当 Agent 等待审批、完成回合、异常退出或定时任务完成时，手机锁屏也能及时收到提醒并点开直达会话。
- **借鉴**：t3code 移动端的通知触发分类与「桌面活跃时静默抑制」策略。
- **做法**：
  1. 扩展 `packages/extension/src/notifications/NotificationService.ts` 支持多目标投递（IDE 原生通知 + 远端推送适配层）。
  2. **本地 VAPID Web Push（免自建中继）**：宿主首次开启时生成并本地持久化 VAPID 密钥对；手机端在 HTTPS PWA 下注册 Push Subscription 并上报宿主绑定到当前 `deviceId`；事件触发时宿主直接向浏览器的 Push Endpoint 发送加密推送（纯标准 RFC 8291/8292，零中间服务器）。
  3. **通用 Webhook 兜底（兼容 LAN HTTP）**：设置页支持配置可选 Webhook URL（内置 Bark / ntfy / 通用 JSON 模板），供未走 HTTPS 的纯局域网用户使用；支持「发送测试推送」与单通道开关。
  4. **桌面活跃静默**：沿用 `platform.isWindowFocused()` 并在存在活跃 IDE 焦点时默认抑制手机推送（可在设置中关闭此抑制）。
- **验收**：
  - 单测覆盖通知路由、去重、桌面焦点抑制与退订清理（设备吊销时同步删除关联 Push Subscription）。
  - 实测锁屏/后台状态下 Agent 触发审批请求时手机收到通知，点击直接跳回对应会话的审批卡片。
- **风险**：iOS Web Push 要求 iOS 16.4+ 且必须「添加到主屏幕」以 PWA 打开，且依赖 HTTPS。缓解：界面明确提示前置条件，并对 HTTP 局域网用户直接推荐 Webhook / Tailscale 路径。

### HD-28 脱离 IDE 的独立守护进程模式（按需演进）

- **目标**：关闭 VS Code / JetBrains 后，本机常驻无头宿主继续提供手机端远程访问（在 HD-18 后台调度的基础上补齐远程交互能力）。
- **做法**：
  1. 在 `packages/extension/src/sidecar/entry.ts` 增加 `--headless-server` 模式，复用 `HarnessHostRuntime` + `RemoteBridgeServer` + `FileKeyValueStore`/`FileSettingsStore` 与单实例锁。
  2. 解决 IDE 窗口启动/退出与常驻进程之间的端口协调、锁交接与凭据桥接（延续 HD-18 的凭据限制评估）。
  3. 提供系统托盘或 CLI 启停状态查看（`status` / `stop` / `pair`）。
- **触发条件**：M5 Phase 2–3（IDE 内嵌模式）稳定上线后，用户高频提出「关掉 IDE 也要用手机连」时再启动。
- **风险**：多工作区管理与系统密钥链读取复杂度较高；必须先解决 HD-18 遗留的凭据桥后再全面推广。

---

## 8. 进度记录
| 日期 | 版本 | 完成项 | 验证 | 备注 |
| --- | --- | --- | --- | --- |
| 2026-11-20 | 0.6.1+ | HD-01 底层能力描述符 | `pnpm typecheck` / `lint` / `test`（514 通过）/ `build` | 新增 `capabilities.ts`；界面不再按 `kind` 判断功能；`BackendView.capabilities` 可选，旧快照用 resolver 兜底 |
| 2026-11-20 | 0.6.1+ | HD-02 每个面清单 | 文档检查 | 写入 `AGENTS.md` 的「改动自检清单」，8 条覆盖入口/客户端/底层/契约/反向状态/语言/文档/测试 |
| 2026-11-20 | 0.6.1+ | HD-03 测试纪律 lint | `pnpm lint`（0 error / 31 warn） | 本地插件 `eslint-rules/test-discipline.mjs`；quarantine 为 error，sleep/时钟先 warn |
| 2026-11-20 | 0.6.1+ | HD-04 i18n 门禁 | `pnpm check:i18n`、`typecheck`、`test`（514 通过） | 新增 `scripts/check-i18n.mjs` 并接入 CI；清理 37 个死 key（74 行） |
| 2026-11-20 | 0.6.1+ | HD-05 安装归属检查 | `typecheck` / `lint` / `test`（519 通过）/ `build` | npm list + 真实路径双重判断；非 npm 安装拒绝覆盖并提示；新增 5 个单测 |
| 2026-11-20 | 0.6.1+ | HD-08 回合模型 | `typecheck` / shared 5 个单测 | 新增 `turns.ts` 与 `TurnView`；五个控制器的快照都带上 `session.turns`；按回合用量与界面入口待后续 |
| 2026-11-20 | 0.6.1+ | HD-12 增量检查 | `pnpm check:changed` 实跑通过 | 新增 `scripts/check-changed.mjs`；按改动包跑 lint / typecheck / test |
| 2026-11-20 | 0.6.1+ | HD-13 底层能力矩阵 | 新增 README 矩阵测试 | 表头扩到 5 组底层，覆盖 17 项能力；新增 `readmeMatrix.test.ts` 防止漏更新 |
| 2026-11-20 | 0.6.1+ | HD-19 术语表 | 文档检查 | `AGENTS.md` 增加 11 条术语；`docs/` 目录整理待恢复后继续 |
| 2026-11-20 | 0.6.1+ | HD-09 源码控制只读面板 | `typecheck` / `lint` / `check:i18n` / `test`（531 通过）/ `build` | 新增 `gitStatus.ts`、工作台「改动」模块、`refreshSourceControl` 消息；4 个 Git 单测 + 1 个界面测试 |
| 2026-11-20 | 0.6.1+ | HD-10 commit / push / PR | `typecheck` / `lint` / `test`（533 通过）/ `build` | 新增 `gitWrite.ts` 与三个显式消息；PR 标题正文可编辑；不 force、不存 token；2 个 Git 写操作单测 |
| 2026-11-20 | 0.6.1+ | HD-11 模型行为 eval | `pnpm eval:check`、`pnpm eval -- --dry-run` | 新增 `evals/`：3 个 case、纯 grader、OpenAI 兼容运行器；真实调用不进 CI |
| 2026-11-20 | 0.6.1+ | HD-08 回合界面入口 | `typecheck` / `test`（533 通过） | `TurnDone` 显示「第 N 轮」；`TurnView.usage` 字段预留 |
| 2026-11-20 | 0.6.1+ | HD-19 文档索引 | 文档检查 | 恢复 `docs/`，新增索引与写作规则，README 文档表更新 |
| 2026-11-20 | 0.6.1+ | HD-20 冒烟现状修正 | `pnpm test`（sidecarE2e）、Kotlin 协议测试 | 自动化已覆盖握手/快照/协议/Diff；IntelliJ UI 运行时仍需手动 |
| 2026-11-20 | 0.6.1+ | HD-06 串行 worktree 会话 | `typecheck` / 新增桥接与界面测试 | 会话侧栏新增 worktree 按钮；整窗切换工作区，同一时间一个活动工作区 |
| 2026-11-20 | 0.6.1+ | HD-07 文件级回滚 | 控制器回滚单测 / `typecheck` | dsh 最后一轮可恢复文件；写盘前确认、未保存文件拒绝、对话不回退 |
| 2026-11-20 | 0.6.1+ | HD-16 幂等回执 | `receipts` 单测 / 全量测试 | 发送、审批、回答、手动跑定时任务带 `commandId`；宿主 5 分钟内去重 |
| 2026-11-20 | 0.6.1+ | HD-17 性能基线 | `pnpm perf:check` | 快照大小、`deriveTurns`、`buildThreadRows` 三项预算；CI 只警告不阻塞 |
| 2026-11-20 | 0.6.1+ | HD-15 侧车重启 | Kotlin 代码检查（本机无 JDK） | 异常退出清空 transport，1.5s 后重启，5 分钟最多 3 次 |
| 2026-11-20 | 0.6.1+ | HD-21 注册表导入 | `acpRegistry` 单测 / 全量测试 | 用户配置 HTTPS 地址，校验后展示安装命令并落到 `harnessDeck.backends` |
| 2026-11-20 | 0.6.1+ | HD-14 driver/instance 拆分 | `profiles` 单测 / 全量测试 | 旧数据回退到 kind/id；配置支持 instanceId；会话 id 不变 |
| 2026-11-20 | 0.6.1+ | HD-18 无头宿主 spike | `pnpm headless:spike` | 临时 config 下启动并销毁 HarnessHostRuntime；调度执行待后续 |
| 2026-11-20 | 0.6.1+ | HD-18 最小无头调度 | `pnpm headless:spike` 跑通真实定时任务 | 文件存储 + 单实例锁 + `UnattendedRunner` + mock ACP；结果写回 global-state |
| 2026-11-20 | 0.6.1+ | HD-18 产品生命周期 | 集成测试 / sidecar 构建 | sidecar 自动 spawn detached 调度；锁被后台持有时 IDE 跳过自动触发；测试覆盖到期规则执行 |
| 2026-11-20 | 0.6.1+ | HD-15 Kotlin 验证 | `gradle test --offline`（JDK21 + Gradle 8.11.1） | `compileTestKotlin` 与 `test` 均通过 |
| 2026-11-22 | 0.8.0+ | HD-22–HD-28 手机端远程互通（M5 全量） | `typecheck` / `lint` / `check:i18n` / `test` / `build` | `ClientHub` 多客户端总线、`ConnectionSupervisor`、`RemoteBridgeServer`（QR/Cookie/ScopeGuard）、PWA 与移动端 Sheet/Diff/弹窗降级、Tailscale/BYO 隧道、VAPID Web Push + Webhook、`--headless-server` 独立守护模式及 VS Code / JetBrains 双端命令与状态栏指示全部落地并通过端到端集成与前端单测 |

---

## 9. 决策记录（随做随记）
- **2026-11-20**：确立「借能力模型与工作流，不借 Effect / 多端 / 自研工具链」的边界。
- **2026-11-20**：首次评审。新增 HD-18（定时任务后台化）、HD-19（文档体系与术语表）、HD-20（JetBrains 冒烟）、HD-21（ACP 注册表导入）；修正 HD-04 现状描述（两套 i18n 均已有类型强制，缺口在占位符/未使用 key/漂移）；HD-01 增加探测无副作用红线；HD-06/HD-07 补并行与 worktree 交叉风险；DoD 补端到端测试要求与 HD-20 引用。
- **2026-11-20**：HD-01 实施结论。权限档位已由 `PermissionState.options` 按会话下发，不再进静态描述符；能力表集中在 `packages/shared/src/capabilities.ts`，`BackendView.capabilities` 设为可选以兼容旧快照与测试夹具，界面统一用 `backendCapabilities()` 兜底。
- **2026-11-20**：HD-07 实施结论。dsh / Claude / Pi / ZCode / ACP 均无会话级原生回滚 API；最终在 dsh 上实现按工具片段恢复最后一轮文件（含删除新建文件与失败回滚保护、不回退对话，`rollback: 'files'`），其他底层标记 `rollback: 'none'`；git checkpoint（hidden ref）留作后续阶段评估。
- **2026-11-20**：HD-06 实施结论。并行多工作区需改造每会话独立进程架构，本阶段落地串行化版本（会话侧栏创建 worktree 并整窗切换，设置页提供 `git worktree remove` 安全清理入口），其他工作区会话保留在标签与历史里。
- **2026-11-20**：HD-20 现状修正。`packages/extension/test/sidecarE2e.test.ts` 已有 Node 侧完整冒烟（握手、快照、外观持久化、密钥隔离、选区注入、断流自毁）；缺口只剩 Kotlin/IntelliJ 运行时，优先级下调。
- **2026-11-21**：修订 0.2 边界，正式立项 **M5 手机端互通（HD-22–HD-28）**。深度调研 T3 Code 手机端实现后，确定采用「宿主内嵌 HTTP/WS 桥 + 复用 `webview-ui` 的 PWA 移动 Web + 短效 QR 配对与设备吊销 + Tailscale/BYO 隧道 + 免中继 Web Push/Webhook」路线，不自建商业云中继与商店原生 App；完整技术剖析与安全红线写入 [docs/MOBILE-INTEROP.md](./docs/MOBILE-INTEROP.md)。
- **待定**：HD-07 后续是否引入 git checkpoint（hidden ref）；HD-06 后续是否演进为多进程并行 worktree 会话；HD-18 / HD-28 后台无头进程的凭据桥（读取 IDE PasswordSafe）；M5 完成后是否按需提供轻量 Capacitor/Expo 外壳以支持 iOS Live Activities。

---

## 10. 本轮执行总结（2026-11-20）

**已完成**

- HD-01 能力描述符：`capabilities.ts` 统一声明，界面不再按 `kind` 判断功能。
- HD-02 每个面清单：写入 `AGENTS.md`，8 条覆盖双端与底层。
- HD-03 测试纪律 lint：本地插件，quarantine 为 error，sleep/时钟先 warn。
- HD-04 i18n 门禁：`check:i18n` 接入 CI，清理 37 个死 key。
- HD-05 安装归属检查：npm list + 真实路径双重判断，拒绝覆盖非 npm 安装。
- HD-09 源码控制只读面板：工作台新增「改动」模块，展示分支、远程、暂存/未暂存与增删行数，不写工作区。
- HD-10 commit / push / PR：显式提交全部改动、推送当前分支、用 `gh` 创建 PR；PR 标题正文可编辑，不 force、不存 token。
- HD-11 模型行为 eval：`evals/` 框架、3 个 case、纯 grader 与 OpenAI 兼容运行器。
- HD-12 增量检查：`check:changed` 按改动包跑 lint / typecheck / test。
- HD-13 能力矩阵：README 覆盖 5 组底层 / 17 项能力，附矩阵测试。
- HD-08 回合模型：`TurnView` + `deriveTurns`，五个控制器快照均带 `session.turns`；`TurnDone` 显示回合编号；`usage` 字段预留。
- HD-19 文档体系：恢复 `docs/`，新增索引与写作规则；`AGENTS.md` 增加 11 条术语。
- HD-20 JetBrains 冒烟：Node 侧 `sidecarE2e.test.ts` 覆盖握手/快照/密钥隔离/选区注入/断流；Kotlin 侧有 `JsonRpcTransportTest` 覆盖协议与 Diff 解析。
- HD-06 串行 worktree 会话：会话侧栏可创建 worktree 并整窗切换；同一时间只有一个活动工作区。
- HD-07 文件级回滚：dsh 最后一轮可「恢复本轮文件」，写盘前确认、未保存文件拒绝、对话不回退。
- HD-16 幂等回执：发送/审批/回答/手动触发定时任务带 `commandId`，宿主短期去重。
- HD-17 性能基线：`pnpm perf:check` 测快照大小、回合推导与工具行合并，超预算只警告。
- HD-15 侧车重启：异常退出后清空 transport 并按退避重启，限制崩溃循环。
- HD-21 ACP 注册表：用户配置 HTTPS 地址后读取、校验、展示安装命令并添加到底层配置；不内置假条目。
- HD-14 driver/instance 拆分：profile 与配置支持 `driver` + `instanceId`，旧数据回退到 `kind`/`id`，会话记录不变。
- HD-18 后台调度：sidecar 自动 spawn detached 无头宿主，单实例锁 + IDE 跳过重复触发，集成测试跑通到期规则。

**已知限制**

- 无头调度读不到 IDE 的 PasswordSafe；绑定第三方服务商密钥的规则需要后续凭据桥，原生代理自带的登录状态不受影响。
- IntelliJ UI 运行时冒烟仍作为手动检查项保留。

**本轮验证**

- `pnpm typecheck`、`pnpm lint`（0 error / 31 条既有测试等待警告，新增测试 0 警告）、`pnpm check:i18n`、`pnpm eval:check`、`pnpm eval -- --dry-run`、`pnpm perf:check`、`pnpm test`（87 文件 / 551 用例）、`pnpm build` 全部通过。
- Kotlin：用 JDK21 + Gradle 8.11.1 离线跑 `compileKotlin`、`compileTestKotlin` 与 `test`，均 BUILD SUCCESSFUL。
