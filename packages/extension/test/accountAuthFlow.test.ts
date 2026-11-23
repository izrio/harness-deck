import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import type { AccountLoginProgress } from '@harness-deck/shared';
import { AccountAuthFlowManager, detectAuthCodePrompt, type AccountLoginHostDeps } from '../src/accounts/AccountAuthFlow.ts';
import { accountSlotSecretKey } from '../src/accounts/AccountStore.ts';
import type { SecretStore } from '../src/host/HostPlatform.ts';

function memorySecrets(): SecretStore & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (key) => map.get(key),
    store: async (key, value) => {
      map.set(key, value);
    },
    delete: async (key) => {
      map.delete(key);
    },
    onDidChange: () => () => undefined,
  };
}

/** 模拟 `agy acp --login`：打印授权链接后等待粘贴授权码，校验通过即写入凭据文件。 */
const FAKE_AGY = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
process.stdout.write('Open this link in a browser to log in with Google:\\n\\n  https://accounts.google.com/o/oauth2/auth?client_id=x&state=y\\n\\n');
process.stdout.write('Then paste the authorization code, or the full URL of the page you land on, and press Enter:\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const nl = buf.indexOf('\\n');
  if (nl < 0) return;
  const code = buf.slice(0, nl).trim();
  if (code !== 'good-code') {
    process.stderr.write('Error: invalid authorization code\\n');
    process.exit(1);
  }
  const file = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"token":"fresh"}');
  process.exit(0);
});
process.stdin.on('end', () => {
  process.stderr.write('Error: login cancelled: no authorization code was entered\\n');
  process.exit(1);
});
`;

type ProgressListener = (p: AccountLoginProgress | undefined) => void;
const progressListeners = new Set<ProgressListener>();

/** 等待登录流程推送满足条件的进度（事件驱动，不使用真实时间轮询）。 */
function waitForProgress(flow: AccountAuthFlowManager, predicate: (p: AccountLoginProgress | undefined) => boolean): Promise<void> {
  if (predicate(flow.progress)) return Promise.resolve();
  return new Promise((resolve) => {
    const listener: ProgressListener = (p) => {
      if (!predicate(p)) return;
      progressListeners.delete(listener);
      resolve();
    };
    progressListeners.add(listener);
  });
}

function makeDeps(root: string, secrets: SecretStore, progress: (AccountLoginProgress | undefined)[]): AccountLoginHostDeps {
  return {
    storageRoot: join(root, 'storage'),
    workspacePath: () => root,
    processEnv: () => ({ HOME: root, PATH: process.env.PATH }),
    settingsGet: <T>(_key: string, def: T) => def,
    secrets,
    openExternal: async () => true,
    runInTerminal: async () => undefined,
    log: () => undefined,
    onProgress: (p) => {
      progress.push(p);
      for (const listener of [...progressListeners]) listener(p);
    },
    onComplete: async () => undefined,
  };
}

describe('AccountAuthFlowManager', () => {
  it('detects authorization-code prompts from official CLIs', () => {
    assert.equal(
      detectAuthCodePrompt('Then paste the authorization code, or the full URL of the page you land on, and press Enter:'),
      true,
    );
    assert.equal(detectAuthCodePrompt('Enter the auth code:'), true);
    assert.equal(detectAuthCodePrompt('Open this link in a browser to log in with Google:'), false);
  });

  it('clears a finished (failed) login so the dialog can be closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hd-auth-'));
    try {
      const progress: (AccountLoginProgress | undefined)[] = [];
      const flow = new AccountAuthFlowManager(makeDeps(root, memorySecrets(), progress));
      await flow.startLogin({
        backendId: 'antigravity',
        backendName: 'Antigravity',
        accountId: 'acc-missing',
        acpCommand: join(root, 'missing-agy'),
      });
      assert.equal(flow.progress?.phase, 'failed');
      flow.cancel('acc-missing', { dismiss: true });
      assert.equal(flow.progress, undefined);
      assert.equal(progress.at(-1), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'asks for the authorization code and succeeds only after it is submitted',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'hd-auth-'));
      try {
        const script = join(root, 'fake-agy');
        await writeFile(script, FAKE_AGY);
        await chmod(script, 0o755);
        const secrets = memorySecrets();
        const progress: (AccountLoginProgress | undefined)[] = [];
        const flow = new AccountAuthFlowManager(makeDeps(root, secrets, progress));
        await flow.startLogin({
          backendId: 'antigravity',
          backendName: 'Antigravity',
          accountId: 'acc-1',
          acpCommand: script,
        });

        await waitForProgress(flow, (p) => p?.needsAuthCode === true);
        assert.equal(flow.progress?.phase, 'waiting-browser');
        assert.match(flow.progress?.authUrl ?? '', /accounts\.google\.com/u);
        assert.equal(progress.some((p) => p?.phase === 'failed' || p?.phase === 'succeeded'), false);

        assert.equal(flow.submitAuthCode('other-account', 'good-code'), false);
        assert.equal(flow.submitAuthCode('acc-1', 'good-code'), true);
        await waitForProgress(flow, (p) => p?.phase === 'succeeded');

        assert.equal(await secrets.get(accountSlotSecretKey('acc-1')), '{"token":"fresh"}');
        assert.equal(
          await readFile(join(root, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8'),
          '{"token":"fresh"}',
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')('reports failure when the submitted code is rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hd-auth-'));
    try {
      const script = join(root, 'fake-agy');
      await writeFile(script, FAKE_AGY);
      await chmod(script, 0o755);
      const progress: (AccountLoginProgress | undefined)[] = [];
      const flow = new AccountAuthFlowManager(makeDeps(root, memorySecrets(), progress));
      await flow.startLogin({ backendId: 'antigravity', backendName: 'Antigravity', accountId: 'acc-2', acpCommand: script });
      await waitForProgress(flow, (p) => p?.needsAuthCode === true);
      assert.equal(flow.submitAuthCode('acc-2', 'bad-code'), true);
      await waitForProgress(flow, (p) => p?.phase === 'failed');
      assert.match(flow.progress?.message ?? '', /invalid authorization code/u);
      flow.cancel(undefined, { dismiss: true });
      assert.equal(flow.progress, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
