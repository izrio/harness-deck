/**
 * 独立 Node.js Sidecar 进程入口（打包为 `dist/sidecar.cjs`）。
 * 通过标准输入输出（NDJSON JSON-RPC 2.0）与宿主 IDE（IntelliJ IDEA / WebStorm / PyCharm 等）通信。
 * 当父进程退出（stdin EOF）或收到终止信号时，自动清理全部后台代理子进程后退出。
 */
import { runHeadlessScheduler } from './headlessScheduler.ts';
import { startSidecarSession } from './server.ts';

const [mode, schedulerConfigRoot, schedulerProjectPath] = process.argv.slice(2);
if (mode === '--headless-scheduler' && schedulerConfigRoot && schedulerProjectPath) {
  void runHeadlessScheduler({
    configRoot: schedulerConfigRoot,
    projectPath: schedulerProjectPath,
    log: (line) => console.log(`[scheduler] ${line}`),
  }).then((handle) => {
    if (!handle) {
      process.exit(0);
      return;
    }
    const shutdown = (): void => {
      void handle.stop().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
} else {
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
}
