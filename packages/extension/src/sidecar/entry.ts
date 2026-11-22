/**
 * 独立 Node.js Sidecar 进程入口（打包为 `dist/sidecar.cjs`）。
 * 通过标准输入输出（NDJSON JSON-RPC 2.0）与宿主 IDE（IntelliJ IDEA / WebStorm / PyCharm 等）通信。
 * 当父进程退出（stdin EOF）或收到终止信号时，自动清理全部后台代理子进程后退出。
 */
import { runHeadlessScheduler } from './headlessScheduler.ts';
import { readHeadlessServerStatus, runHeadlessServer, stopHeadlessServer } from './headlessServer.ts';
import { startSidecarSession } from './server.ts';

const [mode, arg1, arg2] = process.argv.slice(2);
if (mode === '--headless-scheduler' && arg1 && arg2) {
  void runHeadlessScheduler({
    configRoot: arg1,
    projectPath: arg2,
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
} else if (mode === '--headless-server' && arg1 && arg2) {
  const portArg = process.argv[5];
  const parsedPort = portArg ? Number.parseInt(portArg, 10) : undefined;
  void runHeadlessServer({
    configRoot: arg1,
    projectPath: arg2,
    ...(parsedPort && Number.isFinite(parsedPort) ? { port: parsedPort } : {}),
    log: (line) => console.log(`[headless-server] ${line}`),
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
} else if (mode === '--headless-status' && arg1) {
  void readHeadlessServerStatus(arg1).then((status) => {
    console.log(JSON.stringify(status, null, 2));
    process.exit(status.running ? 0 : 1);
  });
} else if (mode === '--headless-stop' && arg1) {
  void stopHeadlessServer(arg1).then((stopped) => {
    console.log(stopped ? 'stopped' : 'not running');
    process.exit(stopped ? 0 : 1);
  });
} else if (mode === '--headless-pair' && arg1) {
  void readHeadlessServerStatus(arg1).then((status) => {
    if (!status.running) {
      console.error('headless server is not running');
      process.exit(1);
      return;
    }
    if (status.pairingUrl) {
      console.log(status.pairingUrl);
      process.exit(0);
      return;
    }
    console.error('no active pairing URL');
    process.exit(1);
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
