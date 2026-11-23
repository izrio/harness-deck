/**
 * 跨平台纯 JS 内置终端会话管理器（P1-4，供右侧栏「终端」标签页与 Mobile Web / Desktop 复用）：
 * - 零原生 C++ 编译依赖（VSIX / Sidecar 纯 JS 跨平台免编译）；
 * - Linux / macOS 自动通过系统 `python3` 打开真 PTY（FD 0 透传键盘输入，FD 3 独立控制窗口尺寸 TIOCSWINSZ）；
 * - Windows 或无 `python3` 环境自动降级为交互式 `child_process` Shell（PowerShell / cmd / $SHELL）；
 * - 内置 128KB 环形回滚缓冲，切换标签或手机端重连时可立即回放历史输出。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { basename } from 'node:path';
import type { Writable } from 'node:stream';
import type { TerminalSessionView, TerminalState } from '@harness-deck/shared';

const MAX_SCROLLBACK_CHARS = 128 * 1024;
const MAX_TERMINALS = 8;

/**
 * 极简 Python3 PTY 桥接脚本：
 * - FD 0：原始终端输入 -> PTY master
 * - FD 1：PTY master 输出 -> Node stdout
 * - FD 3：窗口尺寸控制通道（每行 `cols,rows\n` -> TIOCSWINSZ）
 */
const PYTHON_PTY_BRIDGE = `
import fcntl, os, pty, select, signal, struct, sys, termios
shell = sys.argv[1]
cols = int(sys.argv[2])
rows = int(sys.argv[3])
pid, master = pty.fork()
if pid == 0:
    os.environ.setdefault("TERM", "xterm-256color")
    os.environ.setdefault("COLORTERM", "truecolor")
    os.execvp(shell, [shell, "-i"])
def set_size(c, r):
    try:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
    except Exception:
        pass
set_size(cols, rows)
def on_term(_signum, _frame):
    try:
        os.kill(pid, signal.SIGHUP)
    except OSError:
        pass
    sys.exit(0)
signal.signal(signal.SIGTERM, on_term)
signal.signal(signal.SIGHUP, on_term)
ctrl_fd = 3
fds = [master, 0]
try:
    os.fstat(ctrl_fd)
    fds.append(ctrl_fd)
except OSError:
    ctrl_fd = -1
ctrl_buf = b""
while True:
    try:
        rlist, _, _ = select.select(fds, [], [], 0.2)
    except (OSError, ValueError):
        break
    if master in rlist:
        try:
            data = os.read(master, 8192)
            if not data:
                break
            os.write(1, data)
        except OSError:
            break
    if 0 in rlist:
        try:
            data = os.read(0, 4096)
            if not data:
                break
            os.write(master, data)
        except OSError:
            break
    if ctrl_fd != -1 and ctrl_fd in rlist:
        try:
            chunk = os.read(ctrl_fd, 1024)
            if not chunk:
                fds.remove(ctrl_fd)
                ctrl_fd = -1
            else:
                ctrl_buf += chunk
                while b"\\n" in ctrl_buf:
                    line, ctrl_buf = ctrl_buf.split(b"\\n", 1)
                    parts = line.decode("ascii", "ignore").strip().split(",")
                    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                        set_size(int(parts[0]), int(parts[1]))
        except OSError:
            if ctrl_fd in fds:
                fds.remove(ctrl_fd)
            ctrl_fd = -1
try:
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8)
except Exception:
    code = 0
sys.exit(code if isinstance(code, int) else 0)
`.trim();

let cachedPython3Available: boolean | undefined;

function hasPython3(): boolean {
  if (process.platform === 'win32') return false;
  if (cachedPython3Available !== undefined) return cachedPython3Available;
  try {
    const res = spawnSync('python3', ['--version'], { timeout: 2_000, stdio: 'ignore', windowsHide: true });
    cachedPython3Available = res.status === 0;
  } catch {
    cachedPython3Available = false;
  }
  return cachedPython3Available;
}

function defaultShell(): { readonly file: string; readonly args: readonly string[] } {
  if (process.platform === 'win32') {
    const ps = process.env.ComSpec && !process.env.PSModulePath ? process.env.ComSpec : 'powershell.exe';
    return ps.toLowerCase().includes('powershell') ? { file: ps, args: ['-NoLogo'] } : { file: ps, args: [] };
  }
  const sh = process.env.SHELL || '/bin/bash';
  return { file: sh, args: ['-i'] };
}

interface ManagedTerminal {
  readonly id: string;
  title: string;
  readonly cwd: string;
  readonly createdAt: number;
  cols: number;
  rows: number;
  running: boolean;
  exitCode?: number;
  scrollback: string;
  child?: ChildProcess;
  resizePipe?: Writable;
  usesPty: boolean;
}

export interface EmbeddedTerminalManagerOptions {
  readonly onStateChange: (state: TerminalState) => void;
  readonly onOutput: (event: { readonly id: string; readonly data: string; readonly reset?: boolean }) => void;
  readonly log?: (line: string) => void;
}

export class EmbeddedTerminalManager {
  private readonly sessions = new Map<string, ManagedTerminal>();
  private activeId?: string;
  private seq = 0;
  private disposed = false;

  constructor(private readonly options: EmbeddedTerminalManagerOptions) {}

  getState(): TerminalState {
    const list: TerminalSessionView[] = [];
    for (const s of this.sessions.values()) {
      list.push({
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        running: s.running,
        ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
        cols: s.cols,
        rows: s.rows,
        createdAt: s.createdAt,
      });
    }
    return {
      sessions: list,
      ...(this.activeId ? { activeId: this.activeId } : {}),
    };
  }

  getScrollback(id: string): string {
    return this.sessions.get(id)?.scrollback ?? '';
  }

  create(params: { readonly cwd: string; readonly title?: string; readonly cols?: number; readonly rows?: number }): TerminalSessionView {
    if (this.sessions.size >= MAX_TERMINALS) {
      const oldest = [...this.sessions.values()].find((s) => !s.running) ?? [...this.sessions.values()][0];
      if (oldest) this.close(oldest.id);
    }
    this.seq += 1;
    const id = `term-${this.seq}`;
    const cols = Math.max(20, Math.min(400, params.cols ?? 80));
    const rows = Math.max(5, Math.min(200, params.rows ?? 24));
    const title = params.title?.trim() || `${basename(params.cwd) || 'shell'} #${this.seq}`;
    const session: ManagedTerminal = {
      id,
      title,
      cwd: params.cwd,
      createdAt: Date.now(),
      cols,
      rows,
      running: false,
      scrollback: '',
      usesPty: false,
    };
    this.sessions.set(id, session);
    this.activeId = id;
    this.spawnProcess(session);
    this.emitState();
    return this.getState().sessions.find((s) => s.id === id)!;
  }

  select(id: string): void {
    if (!this.sessions.has(id)) return;
    this.activeId = id;
    this.emitState();
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || !session.running || !session.child) return;
    if (!session.usesPty && data === '\x03') {
      try {
        session.child.kill('SIGINT');
      } catch {
        // ignore
      }
      return;
    }
    try {
      session.child.stdin?.write(data);
      // 非 PTY 降级模式下回显输入，让用户能看到敲出的命令
      if (!session.usesPty) {
        const echo = data.replace(/\r(?!\n)/gu, '\r\n');
        this.appendOutput(session, echo);
      }
    } catch {
      // ignore broken pipe
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.cols = Math.max(20, Math.min(400, Math.round(cols)));
    session.rows = Math.max(5, Math.min(200, Math.round(rows)));
    if (session.resizePipe && !session.resizePipe.destroyed) {
      try {
        session.resizePipe.write(`${session.cols},${session.rows}\n`);
      } catch {
        // ignore
      }
    }
  }

  clear(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.scrollback = '';
    this.options.onOutput({ id, data: '', reset: true });
  }

  restart(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.killChild(session);
    session.scrollback = '';
    session.exitCode = undefined;
    this.options.onOutput({ id, data: '', reset: true });
    this.spawnProcess(session);
    this.emitState();
  }

  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.killChild(session);
    this.sessions.delete(id);
    if (this.activeId === id) {
      const remaining = [...this.sessions.keys()];
      this.activeId = remaining.at(-1);
    }
    this.emitState();
  }

  dispose(): void {
    this.disposed = true;
    for (const session of this.sessions.values()) {
      this.killChild(session);
    }
    this.sessions.clear();
    this.activeId = undefined;
  }

  private spawnProcess(session: ManagedTerminal): void {
    const sh = defaultShell();
    const usePty = hasPython3();
    session.usesPty = usePty;
    session.running = true;
    session.exitCode = undefined;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      COLUMNS: String(session.cols),
      LINES: String(session.rows),
    };

    try {
      const child = usePty
        ? spawn('python3', ['-u', '-c', PYTHON_PTY_BRIDGE, sh.file, String(session.cols), String(session.rows)], {
            cwd: session.cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
            windowsHide: true,
          })
        : spawn(sh.file, sh.args, {
            cwd: session.cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });

      session.child = child;
      session.resizePipe = usePty ? ((child.stdio[3] as Writable | null | undefined) ?? undefined) : undefined;

      child.stdout?.on('data', (chunk: Buffer) => {
        this.appendOutput(session, chunk.toString('utf8'));
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        this.appendOutput(session, chunk.toString('utf8'));
      });
      child.once('error', (error) => {
        this.appendOutput(session, `\r\n[terminal error] ${error.message}\r\n`);
        session.running = false;
        session.exitCode = 1;
        this.emitState();
      });
      child.once('exit', (code) => {
        if (session.child !== child) return;
        session.running = false;
        session.exitCode = code ?? 0;
        session.child = undefined;
        session.resizePipe = undefined;
        this.appendOutput(session, `\r\n[process exited with code ${String(code ?? 0)}]\r\n`);
        this.emitState();
      });
    } catch (error) {
      session.running = false;
      session.exitCode = 1;
      const msg = error instanceof Error ? error.message : String(error);
      this.options.log?.(`terminal spawn failed: ${msg}`);
      this.appendOutput(session, `[terminal failed to start: ${msg}]\r\n`);
    }
  }

  private killChild(session: ManagedTerminal): void {
    const child = session.child;
    session.child = undefined;
    session.resizePipe = undefined;
    session.running = false;
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }

  private appendOutput(session: ManagedTerminal, data: string): void {
    if (!data || this.disposed) return;
    const next = session.scrollback + data;
    session.scrollback = next.length > MAX_SCROLLBACK_CHARS ? next.slice(next.length - MAX_SCROLLBACK_CHARS) : next;
    this.options.onOutput({ id: session.id, data });
  }

  private emitState(): void {
    if (this.disposed) return;
    this.options.onStateChange(this.getState());
  }
}
