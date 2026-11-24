/**
 * 侧边栏对话视图的宿主：生成带 CSP 的 HTML，加载 webview-ui 的构建产物，校验并转发 Bridge 消息。
 * 状态和业务逻辑都在 ChatController 里，这里只负责 Webview 的生命周期。
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { parseWebviewMessage, type HostToWebview, type WebviewToHost } from '@harness-deck/shared';

export interface ChatViewHost {
  /** 已校验的 Webview 消息；第二个参数在工作台面板时传入独立客户端标识，避免与侧边栏单播响应串台。 */
  readonly onMessage: (message: WebviewToHost, clientId?: string) => void;
  /** 视图打开、或隐藏后重新显示时调用（用于按需启动底层）。 */
  readonly onViewVisible: () => void;
  /** 编辑器工作台标签页打开时向宿主注册独立客户端，返回注销函数。 */
  readonly onPanelOpen?: (clientId: string, send: (message: HostToWebview) => void) => () => void;
  /** 界面语言（写进 `<html lang>`，读屏据此选择发音）。 */
  readonly locale?: () => 'zh' | 'en';
  readonly log: (line: string) => void;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'harnessDeck.chatView';
  static readonly panelId = 'harnessDeck.workbenchPanel';
  static readonly panelClientId = 'ide-panel';
  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private disposePanelClient: (() => void) | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly host: ChatViewHost,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.mountWebview(view.webview, 'ide');
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    // 隐藏后重新显示：resolveWebviewView 不会再调用，这里补上（面板隐藏期间切换的底层在这时启动）
    view.onDidChangeVisibility(() => {
      if (view.visible) this.host.onViewVisible();
    });
    this.host.onViewVisible();
  }

  /** 在编辑器标签页中打开全宽工作台面板，与侧边栏共享同一状态流。 */
  openPanel(title: string): void {
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal(vscode.ViewColumn.One);
      this.host.onViewVisible();
      return;
    }
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const panel = vscode.window.createWebviewPanel(
      ChatViewProvider.panelId,
      title,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [webviewRoot] },
    );
    this.panel = panel;
    this.disposePanelClient?.();
    this.disposePanelClient = this.host.onPanelOpen?.(ChatViewProvider.panelClientId, (message) => {
      void panel.webview.postMessage(message);
    });
    this.mountWebview(panel.webview, ChatViewProvider.panelClientId);
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
        this.disposePanelClient?.();
        this.disposePanelClient = undefined;
      }
    });
    panel.onDidChangeViewState(() => {
      if (panel.visible) this.host.onViewVisible();
    });
    this.host.onViewVisible();
  }

  private mountWebview(webview: vscode.Webview, clientId: string): void {
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };
    webview.html = renderHtml(webview, webviewRoot, this.host.locale?.() ?? 'zh');
    webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw);
      if (!message) {
        this.host.log('Webview：丢弃格式不对的消息');
        return;
      }
      if (clientId === 'ide') this.host.onMessage(message);
      else this.host.onMessage(message, clientId);
    });
  }

  get visible(): boolean {
    return Boolean(this.view?.visible || this.panel?.visible);
  }

  /** 视图还没打开时丢弃消息：Webview 加载后会发 ready 取完整快照。 */
  post(message: HostToWebview): void {
    void this.view?.webview.postMessage(message);
    // 若宿主已通过 onPanelOpen 将工作台面板注册为独立 ClientHub 客户端，广播由 ClientHub 直接投递，不再重复转发
    if (!this.host.onPanelOpen) {
      void this.panel?.webview.postMessage(message);
    }
  }
}

function renderHtml(webview: vscode.Webview, root: vscode.Uri, locale: 'zh' | 'en'): string {
  const nonce = randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.css'));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    // 入口脚本带 nonce；代码高亮的语言包按需从插件目录加载
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
  ].join('; ');
  return `<!doctype html>
<html lang="${locale === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style.toString()}">
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
}
