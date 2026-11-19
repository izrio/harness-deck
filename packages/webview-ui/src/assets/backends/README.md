# 底层图标

选择底层的卡片、首页和菜单里用来标识各个底层。都取自各自官方发布的 npm 包，图标和名称归各自的所有者：

| 文件 | 来源 | 处理 |
| --- | --- | --- |
| `deepseek.svg` | `@deepseek-ai/dsh-web-frontend`（dsh 网页）`dist/favicon.svg` | 填充色改成 DeepSeek 品牌蓝 `#4D6BFE`（与 DeepSeek 应用图标一致） |
| `oh-my-pi.svg` | `can1357/oh-my-pi` 官方仓库 `packages/collab-web/public/favicon.svg` | 设为 `256×256` |
| `codebuddy.svg` | CodeBuddy 官方矢量徽标（`lobehub/lobe-icons` `codebuddy-color.svg`） | 设为 `256×256` |
| `claude.svg` | `@anthropic-ai/sdk`（Anthropic 官方 SDK，Claude ACP 适配器的依赖）`.github/logo.svg` | 无 |
| `opencode.svg` | `anomalyco/opencode` 官方仓库 `packages/ui/src/assets/favicon/favicon-v3.svg` | 去除外层嵌套 `<svg>` 与 `<style>` |
| `antigravity.svg` | Google Antigravity 官方徽标（`lobehub/lobe-icons` `antigravity-color.svg` / Wikimedia `Google_Antigravity_Logo.svg`） | 补充纯色底路径、设为 `256×256` 并由 `BackendLogo` 白色圆角底板渲染 |
| `zcode.svg` | `zcode.z.ai` / Z.ai 官方徽标（`z-cdn.chatglm.cn/z-ai/static/logo.svg`） | 去掉外描边并缩放到 256×256 圆角底板 |

这些图标只用来指明对应的产品，不表示 Harness Deck 与它们有关联或得到认可。
