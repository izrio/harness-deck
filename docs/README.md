# 文档索引

| 文档 | 内容 |
| --- | --- |
| [DESIGN.md](./DESIGN.md) | 整体方案：架构、模块、界面设计原则、运行时管理、安全、测试、里程碑；第 15 节是多底层与各 ACP 代理的适配 |
| [DSH-INTEGRATION.md](./DSH-INTEGRATION.md) | dsh 调研：启动与认证、线上格式、Remote 方法、会话事件、版本策略 |
| [../ROADMAP.md](../ROADMAP.md) | 对标 T3 Code 的改进计划、进度与决策记录 |
| [../packages/extension/README.md](../packages/extension/README.md) | 使用说明：各底层的准备、功能差别、设置、常见问题 |
| [../packages/extension/CHANGELOG.md](../packages/extension/CHANGELOG.md) | 更新记录 |

## 写作规则

- **用户任务**放使用说明：怎么装、怎么用、遇到问题怎么办。不写实现细节。
- **跨组件的约束与陷阱**放 `DESIGN.md`：代码能直接回答的不写；只有理由、边界和容易踩的坑值得记。
- **进度与决策**放 `ROADMAP.md`：完成状态、待定事项、每次评审的结论。
- **更新已有段落**而不是追加第二份说明；行为变了就改原文或删掉过时内容。
- 内部文档和用户文档分开：同一个概念只在一个地方定义，其余地方链接过去。
