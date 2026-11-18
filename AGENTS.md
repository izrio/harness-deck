# Harness Deck 项目开发规范

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
- **禁止硬编码颜色**：`shadcn-ui` 语义变量已与 `beautifului-foundation.css` 的浅/深模式及 5 套配色方案（`slate` / `warm` / `forest` / `violet` / `rose`）打通，请使用语义主题类名，禁止写死固定色值（色卡预览数据除外）。

## 常用验证命令

修改代码后请确保以下检查通过：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
