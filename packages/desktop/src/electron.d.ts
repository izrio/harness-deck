/**
 * 轻量 Electron 类型声明（无需在 CI 里下载 150MB 二进制即可完整完成严格类型检查）。
 */
declare namespace NodeJS {
  interface Process {
    /** Electron 打包后指向安装包 resources 目录（@types/node 未声明）。 */
    resourcesPath: string;
  }
}

declare module 'electron' {
  export interface BrowserWindowOptions {
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    minWidth?: number;
    minHeight?: number;
    title?: string;
    icon?: unknown;
    backgroundColor?: string;
    show?: boolean;
    webPreferences?: {
      preload?: string;
      contextIsolation?: boolean;
      nodeIntegration?: boolean;
      sandbox?: boolean;
    };
  }
  export class BrowserWindow {
    constructor(options?: BrowserWindowOptions);
    loadURL(url: string): Promise<void>;
    show(): void;
    hide(): void;
    focus(): void;
    isVisible(): boolean;
    isMinimized(): boolean;
    restore(): void;
    getBounds(): { x: number; y: number; width: number; height: number };
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    webContents: {
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void;
      send(channel: string, ...args: unknown[]): void;
    };
  }
  export class Tray {
    constructor(icon: unknown);
    setToolTip(tip: string): void;
    setContextMenu(menu: unknown): void;
    on(event: string, listener: () => void): this;
    destroy(): void;
  }
  export class Notification {
    constructor(options: { title: string; body: string });
    static isSupported(): boolean;
    show(): void;
  }
  export const Menu: {
    buildFromTemplate(template: readonly Record<string, unknown>[]): unknown;
  };
  export const nativeImage: {
    createEmpty(): unknown;
    createFromPath(path: string): unknown;
    createFromDataURL(url: string): unknown;
  };
  export const app: {
    isPackaged: boolean;
    whenReady(): Promise<void>;
    quit(): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    getPath(name: string): string;
    requestSingleInstanceLock(): boolean;
  };
  export const globalShortcut: {
    register(accelerator: string, callback: () => void): boolean;
    unregisterAll(): void;
  };
  export const ipcMain: {
    on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  };
  export const shell: {
    openExternal(url: string): Promise<void>;
  };
  export const contextBridge: {
    exposeInMainWorld(apiKey: string, api: Record<string, unknown>): void;
  };
  export const ipcRenderer: {
    send(channel: string, ...args: unknown[]): void;
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  };
}
