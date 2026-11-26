# Halo 项目开发规范

## 术语

- **底层（backend）**：面板背后的编程代理运行时（dsh、Claude、Pi、ZCode、ACP 代理）。
- **底层 id / kind**：`id` 是配置项标识（可由用户覆盖），`kind` 是接入协议类型（`dsh` / `claude` / `pi` / `zcode` / `acp`）。
- **宿主（Host）**：运行在 IDE 扩展进程里的公共层（`packages/extension/src/host`），与具体 IDE 解耦。
- **控制器（Controller）**：把一个底层的数据投影成视图模型、处理 Webview 消息的模块。
- **能力描述符（capability）**：`packages/shared/src/capabilities.ts` 中声明的底层功能集合；界面只读它，不按 `kind` 判断功能。
- **会话（session）**：一段持久的对话，按底层分开保存。
- **回合（turn）**：一轮用户消息到回复结束（含后续检查点），见 `packages/shared/src/turns.ts`。
- **标签（tab）**：面板里打开的一个会话或新对话。
- **工作台（workbench）**：总览 / 改动 / 定时 / 智能体 / 任务 / 会话六个模块。
- **worktree 会话**：在独立 git worktree 中运行的串行化会话（HD-06，同一时间一个活动工作区）。
- **Sidecar**：JetBrains 插件启动的 Node 宿主进程（`packages/extension/src/sidecar`）。

## UI 组件库强制规范（严禁新造组件）

本项目前端界面（`packages/webview-ui`）**只允许使用 `shadcn-ui` 和 `beautifului` 两个组件库，严禁自己新造任何通用或基础 UI 组件**。

### 1. 组件库分工与职责边界

1. **通用基础控件统一使用 `shadcn-ui`**
   - 目录：`packages/webview-ui/src/components/ui/`（由 `packages/webview-ui/components.json` 管理，统一为小写文件名）。
   - 适用范围：按钮与按钮组（`Button`、`ButtonGroup`）、表单输入（`Input`、`Textarea`、`NativeSelect`、`Select`、`Switch`、`Checkbox`、`Label`）、弹窗与浮层（`Dialog`、`Popover`、`DropdownMenu`、`Tooltip`、`Sheet`）、布局与导航（`Sidebar`、`Tabs`、`Card`、`Badge`、`Separator`、`ScrollArea`、`Skeleton`）等一切通用交互控件。
   - 新增通用控件时，**必须**通过官方 CLI 拉取，禁止手写替代品：
     ```bash
     pnpm dlx shadcn@latest add -c packages/webview-ui <component>
     ```

2. **AI 对话专属组件使用 `beautifului`**
   - 基础原语目录：`packages/webview-ui/src/components/beautifului/`（`Shimmer`、`LoaderGrid`、`GlideMenu`、`ValuePill`）。
   - 样式与令牌：`packages/webview-ui/src/styles/beautifului-foundation.css`、`packages/webview-ui/src/styles/beautifului-prose.css`。
   - 适用范围：流光文字（`Shimmer`）、像素网格加载态（`LoaderGrid`）、滑动高亮层（`GlideMenu`）、状态胶囊（`ValuePill`），以及 AI 对话专属展现（推理流 `ThinkingState`、工具活动芯片 `ToolChips`、Diff 改动表 `DiffTable`、审批与提问卡片 `ApprovalCard` / `QuestionCard`、子代理状态行 `SubagentRow`、输入框上方状态栏 `StatusDock`、对话输入框 `Composer`、代码高亮块 `CodeBlock`）。

### 2. 红线禁令

- **禁止自造组件**：禁止手写自定义 `Modal`、`Popover`、`SidebarNav`、`FormControls`、`Stepper`、自定义 CSS 开关（如 `.bui-switch`）等基础控件，也禁止将手写组件冠以 `Beautiful UI` 或 `shadcn` 注释混入代码库。
- **禁止向 `src/components/ui/` 手动添加非 `shadcn-ui` 官方组件文件**。
- **业务视图只做组合**：`src/components/settings/*`、`src/components/workbench/*` 等业务模块只能组合 `shadcn-ui` 与 `beautifului` 已有组件实现业务布局，遇到缺失的通用交互原语请先从 `shadcn-ui` 安装。
- **禁止硬编码颜色**：`shadcn-ui` 语义变量已与 `beautifului-foundation.css` 的浅/深模式打通，请使用语义主题类名，禁止写死固定色值（主题预览卡片数据除外）。

## 组件尺寸规范（统一 size，杜绝高低不齐）

为避免输入框、下拉选择框、按钮等单行交互控件在同一行或同一表单中出现“一个大一个小”的错位，所有基础交互控件统一采用与 `shadcn-ui` 一致的 **4 档高度体系**，并通过 `size` 属性（同步输出 `data-size`）控制尺寸：

| `size` 档位 | 统一高度 | 对应图标按钮 | 字号 | 适用场景 |
| --- | --- | --- | --- | --- |
| `xs` | `h-6`（24px） | `icon-xs`（`size-6`） | `text-xs` | 紧凑工具栏、卡片头部微操作、行内标签按钮、`NumberStepper` 默认紧凑态 |
| **`sm`**（**IDE 表单默认推荐**） | **`h-8`（32px）** | **`icon-sm`（`size-8`）** | **`text-sm`** | **设置页表单、弹窗表单、搜索框、表单/工具栏操作按钮、弹窗底部主/次按钮** |
| `default` | `h-9`（36px） | `icon`（`size-9`） | `text-sm` | 独立宽松页面表单或强调型独立搜索栏 |
| `lg` | `h-10`（40px） | `icon-lg`（`size-10`） | `text-sm` | 欢迎页或强强调主操作入口 |

### 强制约束

1. **统一 `size` API**：`Button`、`Input`、`NativeSelect`、`SelectTrigger` 均统一支持 `size="xs" | "sm" | "default" | "lg"`，且同一档位在所有控件上保持完全相同的像素高度（`24 / 32 / 36 / 40px`）；`NumberStepper` 支持 `size="xs" | "sm"`。
2. **同行/同表单严格等高对齐**：
   - 同一水平行（如「输入框 + 按钮」「下拉框 + 输入框」「下拉框 + 提交按钮」「表格行内输入框 + 行操作图标按钮」）以及同一表单/弹窗中的所有单行控件，**必须使用相同的 `size` 档位**（如 `Input size="sm"` + `NativeSelect size="sm"` + `Button size="sm"` / `Button size="icon-sm"`）。
   - 本项目作为 VS Code / JetBrains IDE 插件面板，**表单、设置项与弹窗统一优先使用 `size="sm"`（32px）**，卡片头部与行内微操作统一使用 `size="xs"`（24px）。
3. **禁止手写散落高度覆盖控件尺寸**：
   - **禁止**在业务组件中通过 `className="h-7"`、`className="h-8"`、`className="h-9"`、`className="h-[30px]"` 等内联高度类覆盖 `Input`、`Button`、`NativeSelect`、`SelectTrigger` 的高度，必须通过 `size` 属性表达。
   - **豁免**：无边框内联透明输入（如 `QuestionCard` 中的 `h-auto` 自定义输入）与 `variant="link"` 纯文字链接按钮（`h-auto p-0`）。

## 设置页与分组卡片视觉规范（macOS 设置风格）

设置页及同类分组表单视图（`packages/webview-ui/src/components/settings/*`）统一采用 **macOS 设置风格的「无外框浅底圆角卡片 + 内缩极细横线分割 + 宽松行距呼吸感」**，严禁堆叠多层边框盒子或在卡片内嵌套圆角行胶囊：

1. **分组容器（`SettingsSection`）**：
   - 分区标题轻落在卡片外（`flex flex-col gap-2.5`，标题 `text-[13px] font-semibold tracking-tight text-ink`，右侧微操作按钮使用 `size="xs"` 或 `size="sm"`）。
   - 卡片本体使用**无外边框的柔和浅底圆角容器**：`overflow-hidden rounded-2xl bg-field/55 dark:bg-surface/65`（禁止添加外圈 `border` 或沉重阴影）。
   - 相邻分组之间保持充足留白（`gap-8`）。
2. **卡片内行间极细横线与宽松行距**：
   - 行列表容器使用 `flex flex-col divide-y divide-line/55 px-4`，让 `1px` 极细分割线与文本左右内缩对齐（16px inset）；需要整行选中态背景的列表（如最近项目、已保存服务商）使用 `flex flex-col divide-y divide-line/55` 配合行内 `px-4`，使选中底色在 `overflow-hidden` 卡片内齐边铺满。
   - **宽松呼吸感**：单行开关/下拉/步进器行统一 `py-3.5`、`gap-6`，主标签使用 `text-[13px] leading-5 text-ink`；多行或内含子表单的区块行使用 `py-4`。
   - **禁止卡片内套圆角行胶囊**：静态开关行与常规列表行不再套 `rounded-xl hover:bg-canvas/65` 嵌套底盒；仅内嵌预览块、渠道子表单或提示条等独立内容块允许使用 `rounded-xl bg-canvas/70 dark:bg-page/50` 轻量内凹面。
3. **文字对齐与微交互呼吸感**：
   - 同一行内图标、文字与次级数值（如倍速/计数）必须垂直居中对齐（`inline-flex items-center` + `leading-none` / 匹配行高），禁止因字号差异导致基线漂移。
   - 渠道/服务商等需要配置指引的设置项，使用离线品牌图标 + 轻量问号 `Popover` 展示配置说明，不把长篇大段说明直接平铺在主表单中破坏留白。

## 图标规范（Iconify 离线优先）

本项目前端界面（`packages/webview-ui`）中的通用 UI 图标**统一使用 Iconify 生态**，并且**必须支持 VS Code / JetBrains 插件在离线环境与严格 Webview CSP（`default-src 'none'`）下正常渲染，严禁运行时联网拉取图标**。

### 1. 技术方案与默认图标集

1. **渲染组件必须使用离线入口 `@iconify/react/offline`**
   - 统一通过 `packages/webview-ui/src/components/icons.tsx` 封装的 `<AppIcon />` 或语义图标组件（如 `PlusIcon`、`SettingsIcon`）渲染。
   - **禁止**从默认入口 `@iconify/react` 导入（该入口包含在线 API 拉取逻辑，在插件离线环境与 Webview CSP 下不可用）。
2. **图标数据必须静态按需打包**
   - 默认主图标集为 **`lucide`**（`@iconify-icons/lucide`，与 `shadcn-ui` 视觉风格保持一致）。
   - 必须按单图标子路径静态导入（如 `import checkIcon from '@iconify-icons/lucide/check'`），由 Vite 在构建期静态打入 `index.js`，实现零网络请求、离线可用与自动 Tree-Shaking。
   - 如需使用其他 Iconify 图标集，可安装对应的单图标包（如 `pnpm --filter @harness-deck/webview-ui add @iconify-icons/<set>`）并同样按单图标路径静态导入，**禁止**整包导入全量 `icons.json`。
3. **样式与无障碍规范**
   - 图标颜色默认继承 `currentColor`，通过语义主题类名控制颜色（如 `text-ink`、`text-ink-2`、`text-ink-3`、`text-brand`），禁止硬编码色值。
   - 图标尺寸优先使用 Tailwind 尺寸工具类（如 `size-3.5`、`size-4`），默认基准尺寸为 `16×16`；纯装饰性图标保持 `aria-hidden="true"`。

### 2. 新增图标流程

1. 优先在 `packages/webview-ui/src/components/icons.tsx` 中从 `@iconify-icons/lucide/<icon-name>` 导入图标数据，并使用 `createIcon(...)` 导出语义化图标组件（如 `export const FooIcon = createIcon(fooIcon)`）。
2. 对于仅在单处使用的特殊 Iconify 图标，可直接结合 `<AppIcon icon={xxxIcon} className="size-4" />` 渲染本地静态导入的 `@iconify-icons/*` 数据。

### 3. 红线禁令与豁免范围

- **禁止在线拉取图标**：禁止引入 `@iconify/react`（非 `/offline` 入口），禁止传字符串名称依赖 `api.iconify.design` 或外部 CDN 加载图标。
- **禁止混用其他图标库**：业务组件与 `beautifului` 禁止直接导入 `lucide-react`、`@heroicons/*`、`react-icons`、`@tabler/icons-react`、`@phosphor-icons/*`、`feather-icons` 等非 Iconify 图标库。
- **禁止手写通用内联 `<svg>` 图标**：不得在业务组件中手写路径拼装通用 UI 图标。
- **明确豁免**：
  - `packages/webview-ui/src/components/ui/*` 中由 `shadcn` CLI 生成的官方基础控件内部自带的 `lucide-react` 图标导入（构建期同样静态内联离线可用）。
  - 品牌标志与数据可视化/专属动效图形（如 `HarnessDeckLogo.tsx`、`BackendLogo.tsx`、`ContextRing.tsx` 及 `beautifului` 专属环形加载动效）。

## 改动自检清单（每个面都改到）

项目同时运行在 VS Code 与 JetBrains，界面、宿主与底层分属不同进程。改完一处不代表功能完成；提交前逐项确认，不适用的写「不适用」：

1. **入口**：对话、命令面板、设置页、编辑器右键菜单、状态栏。从对话能触发的功能，通常也要能从命令或设置到达。
2. **客户端**：VS Code Webview、JetBrains JCEF、宿主公共层（`packages/extension/src/host`、`packages/shared`）。至少确认两端都能加载新快照。
3. **底层**：该功能在 dsh / Claude / Pi / ZCode / ACP 上分别是「支持 / 降级 / 不支持」；把结论写进 `packages/shared/src/capabilities.ts`，不要在组件里按 `kind` 判断。
4. **契约**：`packages/shared/src/bridge.ts` 的消息与 `viewModel.ts` 的快照类型要同时改；Webview 与宿主不能只改一边。
5. **反向状态**：新增入口必须同时有退出、撤销或查看方式（例如新增 worktree 会话要有清理入口）。
6. **语言**：`packages/extension/src/i18n.ts` 与 `packages/webview-ui/src/i18n.ts` 的中英文都要补，占位符保持一致。
7. **文档**：用户可见行为改 `packages/extension/README.md`；跨组件的约束改 `ROADMAP.md` 或设计文档；只改实现细节不写文档。
8. **测试**：单测覆盖纯逻辑；协议或底层行为补 `acp-e2e` / `smoke`；界面布局与交互补 Webview 测试。纯视觉调整可用前后截图代替。

## 常用验证命令

修改代码后请确保以下检查通过：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

提交前可以先跑增量检查，只检查受影响的包：

```bash
pnpm check:changed          # 按改动范围跑 lint / typecheck / test
pnpm check:changed --dry-run # 只打印将执行的命令
```

## 推送与发版规范

仅推送到 `main` 只会触发 `.github/workflows/ci.yml`（构建与测试），**不会**发布 GitHub Release；发布新版本必须同步更新版本号、`CHANGELOG.md` 并推送 `v*` 标签以触发 `.github/workflows/release.yml`。

1. **推送前验证**：确保 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 全部通过。
2. **同步版本号与更新日志**（若需要发版）：
   - 同步更新 `packages/extension/package.json` 的 `"version"`、`packages/jetbrains/build.gradle.kts` 的 `version = "<x.y.z>"` 与 `packages/desktop/package.json` 的 `"version"`（`release.yml` 会校验三者必须与标签 `v<x.y.z>` 一致）。
   - 发版会同时产出 VS Code `.vsix`、JetBrains `.zip` 与桌面端安装包（Windows `.exe` / macOS `.dmg` / Linux `.AppImage`）；桌面端由 `packages/desktop` 的 electron-builder 配置打包，`electronVersion` 固定在 `packages/desktop/electron-builder.yml`。
   - 在 `packages/extension/CHANGELOG.md` 顶部添加 `## <x.y.z>` 节（中英双语），`release.yml` 会提取该节作为 Release 说明。
3. **提交、打标签并推送**：
   ```bash
   git add -A
   git commit -m "Release <x.y.z>: <summary>"
   git tag v<x.y.z>
   git push origin main v<x.y.z>
   ```
4. **推送后核验**：确认 GitHub Actions 中 `CI` 与 `Release` 工作流均执行成功，并在 GitHub Releases 页面确认新版本及 `.vsix`、`.zip`、`.sha256` 产物已生成。
