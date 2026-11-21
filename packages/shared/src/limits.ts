/**
 * 不依赖 zod 的常量，Webview 直接从 `@harness-deck/shared/limits` 引入。
 * 从包入口引入会把 bridge.ts 的 zod 模式一起打进 Webview，zod 启动时探测 `new Function` 会触发 CSP 违规。
 */

/** dsh 接受的图片格式。 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** 一条消息最多带的图片数，和单张图片 base64 的上限（约 15 MB 原始字节；dsh 自己还有更严格的限制）。 */
export const MAX_IMAGES = 10;
export const MAX_IMAGE_BASE64 = 20_000_000;

/** 工作台核心模块：总览 / 改动 / 定时 / 智能体 / 任务 / 会话。 */
export const WORKBENCH_MODULES = ['overview', 'changes', 'schedules', 'agents', 'tasks', 'sessions'] as const;
export type WorkbenchModule = (typeof WORKBENCH_MODULES)[number];

/** 任务看板四列状态。 */
export const TASK_COLUMNS = ['todo', 'in_progress', 'review', 'done'] as const;
export type TaskColumn = (typeof TASK_COLUMNS)[number];
