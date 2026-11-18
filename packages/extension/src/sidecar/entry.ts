/**
 * 独立 Node.js Sidecar 进程入口（打包为 `dist/sidecar.cjs`）。
 * 通过标准输入输出（NDJSON JSON-RPC 2.0）与宿主 IDE（IntelliJ IDEA / WebStorm / PyCharm 等）通信。
 * 当父进程退出（stdin EOF）或收到终止信号时，自动清理全部后台代理子进程后退出。
 */
import { startSidecarSession } from './server.ts';

const session = startSidecarSession(process.stdin, process.stdout, {
  onShutdown: () => {
    setImmediate(() => process.exit(0));
  },
});

const handleSignal = (): void => {
  void session.dispose().finally(() => process.exit(0));
};

process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);
process.stdin.resume();
