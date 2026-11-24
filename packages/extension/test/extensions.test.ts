import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpController, type AcpLink } from '../src/acp/AcpController.ts';
import { AcpError } from '../src/acp/connection.ts';
import {
  parseCodexTomlMcpServers,
  parseDshPatchYamlMcpServers,
  parseJsonc,
  scanAgentMcpConfigs,
} from '../src/extensions/mcpImporter.ts';
import {
  buildDshRuntimePatchYaml,
  deleteMcpServerSetting,
  importMcpServersSetting,
  parseMcpServersSetting,
  prepareBackendLaunch,
  toAcpMcpServers,
  toggleMcpServerSetting,
  upsertMcpServerSetting,
} from '../src/extensions/mcpService.ts';
import {
  deleteInstalledSkill,
  importLocalSkills,
  installSkillsFromGit,
  loadInstalledSkills,
  parseGitSkillSource,
  parseSkillMarkdown,
  scanAgentSkills,
  scanLocalSkillDirectory,
  scanSkillsFromGit,
  stageSkillsForBackend,
  syncInstalledSkill,
  updateSkillEntry,
} from '../src/extensions/skillService.ts';
import {
  BUILTIN_MCP_MARKET,
  BUILTIN_SKILL_MARKET,
  clearMarketCacheForTests,
  fetchOnlineMcpMarket,
  fetchOnlineSkillMarket,
  parseMcpRegistryPayload,
} from '../src/extensions/marketService.ts';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('Agent Skills (SKILL.md) 解析与 Git 仓库安装生命周期', () => {
  it('支持 GitHub 简写、GitHub/GitLab tree 子目录 URL，并拒绝危险 Git 参数与协议', () => {
    expect(parseGitSkillSource('anthropics/skills')).toEqual({
      repoUrl: 'https://github.com/anthropics/skills.git',
      displayRepo: 'anthropics/skills',
    });

    expect(parseGitSkillSource('https://github.com/anthropics/skills/tree/main/skills/frontend-design')).toEqual({
      repoUrl: 'https://github.com/anthropics/skills.git',
      displayRepo: 'anthropics/skills',
      ref: 'main',
      subpath: 'skills/frontend-design',
    });

    expect(parseGitSkillSource('https://gitlab.com/team/agent-pack/-/tree/v1.2.0/packs/audit')).toEqual({
      repoUrl: 'https://gitlab.com/team/agent-pack.git',
      displayRepo: 'team/agent-pack',
      ref: 'v1.2.0',
      subpath: 'packs/audit',
    });

    expect(() => parseGitSkillSource('--upload-pack=evil')).toThrow();
    expect(() => parseGitSkillSource('ext::sh -c whoami')).toThrow();
    expect(() => parseGitSkillSource('anthropics/skills', '-oProxyCommand=evil')).toThrow();
    expect(() => parseGitSkillSource('anthropics/skills', undefined, '../../etc')).toThrow();
  });

  it('解析 SKILL.md YAML Frontmatter 与正文摘要', () => {
    const parsed = parseSkillMarkdown(
      `---\nname: frontend-design\ndescription: >\n  Create distinctive, production-grade frontend interfaces\n  with clean typography.\n---\n\n# Frontend Design\nBody instructions.`,
      'fallback-dir',
    );
    expect(parsed).toEqual({
      name: 'frontend-design',
      description: 'Create distinctive, production-grade frontend interfaces with clean typography.',
    });

    const fallback = parseSkillMarkdown(`# Security Review\n\nAudit auth boundaries and SQL queries.\n`, 'sec-review');
    expect(fallback).toEqual({
      name: 'sec-review',
      description: 'Audit auth boundaries and SQL queries.',
    });
  });

  it('从真实 Git 仓库扫描、安装、防越界软链、同步更新、限定 Agent、生成挂载目录并卸载', async () => {
    const repoDir = await makeTempDir('hd-skill-repo-');
    const storageRoot = await makeTempDir('hd-skill-storage-');
    const outsideFile = join(storageRoot, 'secret-outside.txt');
    await writeFile(outsideFile, 'TOP_SECRET', 'utf8');

    const skillADir = join(repoDir, 'skills', 'code-review');
    const skillBDir = join(repoDir, 'skills', 'doc-writer');
    await mkdir(join(skillADir, 'scripts'), { recursive: true });
    await mkdir(skillBDir, { recursive: true });

    await writeFile(
      join(skillADir, 'SKILL.md'),
      `---\nname: code-review\ndescription: Deep code review checklist\n---\n\nCheck edge cases and types.\n`,
      'utf8',
    );
    await writeFile(join(skillADir, 'scripts', 'lint.sh'), '#!/bin/sh\necho ok\n', 'utf8');
    // 制造指向仓库外部的恶意软链接，验证安装器会自动忽略越界软链接
    await symlink(outsideFile, join(skillADir, 'leak.txt'));

    await writeFile(
      join(skillBDir, 'SKILL.md'),
      `---\nname: doc-writer\ndescription: Technical documentation writer\n---\n\nWrite concise docs.\n`,
      'utf8',
    );

    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init skills'], { cwd: repoDir, stdio: 'ignore' });

    // 1. 扫描 Git 仓库技能
    const scanned = await scanSkillsFromGit({ repoUrl: repoDir });
    expect(scanned.skills.map((s) => s.name)).toEqual(['code-review', 'doc-writer']);

    // 2. 选择性安装 code-review 并随后安装 doc-writer（限定 claude）
    const firstInstall = await installSkillsFromGit({
      storageRoot,
      repoUrl: repoDir,
      selectedSubpaths: ['skills/code-review'],
      now: 1_000,
    });
    expect(firstInstall.installed).toHaveLength(1);
    expect(firstInstall.installed[0]!.name).toBe('code-review');
    expect(firstInstall.installed[0]!.commit).toBeTruthy();
    // 附属脚本保留，越界软链被拦截丢弃
    const installedDirA = join(storageRoot, 'skills', 'installed', 'code-review');
    expect(existsSync(join(installedDirA, 'scripts', 'lint.sh'))).toBe(true);
    expect(existsSync(join(installedDirA, 'leak.txt'))).toBe(false);

    await installSkillsFromGit({
      storageRoot,
      repoUrl: repoDir,
      selectedSubpaths: ['skills/doc-writer'],
      agents: ['claude'],
      now: 1_100,
    });

    const loaded = await loadInstalledSkills(storageRoot);
    expect(loaded.map((s) => s.id)).toEqual(['code-review', 'doc-writer']);

    // 3. 验证按目标 Agent 生成运行时挂载目录（dsh 只拿到通用技能，claude 拿到两个技能）
    const dshBundle = await stageSkillsForBackend(storageRoot, 'dsh', loaded);
    expect(dshBundle.skills.map((s) => s.id)).toEqual(['code-review']);
    expect(existsSync(join(dshBundle.skillsDir, 'code-review', 'SKILL.md'))).toBe(true);

    const claudeBundle = await stageSkillsForBackend(storageRoot, 'claude', loaded);
    expect(claudeBundle.skills.map((s) => s.id)).toEqual(['code-review', 'doc-writer']);
    expect(existsSync(join(claudeBundle.bundleDir, '.claude', 'skills', 'doc-writer', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(claudeBundle.bundleDir, '.codebuddy', 'skills', 'code-review', 'SKILL.md'))).toBe(true);

    // 4. 上游仓库提交新内容后，执行 syncInstalledSkill 同步更新
    await writeFile(
      join(skillADir, 'SKILL.md'),
      `---\nname: code-review\ndescription: Updated review checklist v2\n---\n\nCheck security too.\n`,
      'utf8',
    );
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'update code-review'], { cwd: repoDir, stdio: 'ignore' });

    const synced = await syncInstalledSkill({ storageRoot, id: 'code-review', now: 2_000 });
    const syncedReview = synced.find((s) => s.id === 'code-review')!;
    expect(syncedReview.description).toBe('Updated review checklist v2');
    expect(syncedReview.commit).not.toBe(firstInstall.installed[0]!.commit);

    // 5. 切换启用状态与限定 Agent，最后卸载
    const toggled = await updateSkillEntry({ storageRoot, id: 'code-review', enabled: false, agents: ['dsh'] });
    expect(toggled.find((s) => s.id === 'code-review')).toMatchObject({ enabled: false, agents: ['dsh'] });

    const afterDelete = await deleteInstalledSkill(storageRoot, 'code-review');
    expect(afterDelete.map((s) => s.id)).toEqual(['doc-writer']);
    expect(existsSync(installedDirA)).toBe(false);
  });
});

describe('统一 MCP 服务器管理、各 Agent 配置导入与启动注入', () => {
  it('增删改查 MCP 服务器配置、转换为 ACP 线协议与生成 dsh Cordis patch', async () => {
    let raw: unknown = [];
    raw = upsertMcpServerSetting(raw, {
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/repo'],
      env: { LOG_LEVEL: 'info' },
      agents: ['dsh', 'claude', 'oh-my-pi', 'codebuddy', 'zcode'],
    });
    raw = upsertMcpServerSetting(raw, {
      name: 'context7',
      transport: 'http',
      url: 'https://mcp.context7.com/mcp',
      headers: { Authorization: 'Bearer secret' },
      agents: ['dsh', 'claude'],
    });

    const servers = parseMcpServersSetting(raw);
    expect(servers).toHaveLength(2);

    // ACP 标准转换：当代理支持 http MCP 时同时包含 stdio 和 http；否则自动过滤出 stdio
    const fullWire = toAcpMcpServers(servers, { http: true });
    expect(fullWire).toEqual([
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/repo'],
        env: [{ name: 'LOG_LEVEL', value: 'info' }],
      },
      {
        type: 'http',
        name: 'context7',
        url: 'https://mcp.context7.com/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer secret' }],
      },
    ]);
    const stdioOnlyWire = toAcpMcpServers(servers, { http: false });
    expect(stdioOnlyWire).toHaveLength(1);
    expect(stdioOnlyWire[0]!.name).toBe('filesystem');

    // dsh Cordis patch YAML 生成
    const patchYaml = buildDshRuntimePatchYaml({
      skillsDir: '/tmp/bundle/skills',
      skillCount: 1,
      mcpServers: servers,
    });
    expect(patchYaml).toContain('@deepseek-ai/dsh-skill-filesystem');
    expect(patchYaml).toContain('/tmp/bundle/skills');
    expect(patchYaml).toContain('@deepseek-ai/dsh-mcp-client');
    expect(patchYaml).toContain('transport: stdio');
    expect(patchYaml).toContain('transport: streamable-http');

    // prepareBackendLaunch 按不同 Agent 生成准确的启动参数
    const storageRoot = await makeTempDir('hd-launch-');
    const skillDir = join(storageRoot, 'skills', 'installed', 'my-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: demo\n---\nBody', 'utf8');
    const skills = [
      {
        id: 'my-skill',
        name: 'my-skill',
        description: 'demo',
        repoUrl: 'https://github.com/org/repo.git',
        skillMdPath: join(skillDir, 'SKILL.md'),
        enabled: true,
        installedAt: 1,
        updatedAt: 1,
      },
    ];

    const dshPrepared = await prepareBackendLaunch({
      storageRoot,
      profile: { id: 'dsh', name: 'DeepSeek', kind: 'dsh' },
      skills,
      mcpServers: servers,
    });
    expect(dshPrepared.launcherArgs[0]).toBe('--patch');
    const writtenPatch = await readFile(dshPrepared.launcherArgs[1]!, 'utf8');
    expect(writtenPatch).toContain('hd-mcp-filesystem');

    const ompPrepared = await prepareBackendLaunch({
      storageRoot,
      profile: { id: 'oh-my-pi', name: 'Pi', kind: 'acp', command: 'omp', args: ['acp'], env: {} },
      skills,
      mcpServers: servers,
    });
    expect(ompPrepared.extraArgs[0]).toBe('--skill');
    expect(ompPrepared.mcpServers.map((s) => s.id)).toEqual(['filesystem']);

    const cbPrepared = await prepareBackendLaunch({
      storageRoot,
      profile: { id: 'codebuddy', name: 'CodeBuddy', kind: 'acp', command: 'codebuddy', args: ['--acp'], env: {} },
      skills,
      mcpServers: servers,
    });
    expect(cbPrepared.extraArgs).toEqual(['--add-dir', cbPrepared.skillBundleDir]);

    const claudePrepared = await prepareBackendLaunch({
      storageRoot,
      profile: { id: 'claude', name: 'Claude Code', kind: 'acp', command: 'claude-agent-acp', args: [], env: {} },
      skills,
      mcpServers: servers,
    });
    expect(claudePrepared.skillMode).toBe('claude-meta');
    expect(claudePrepared.mcpServers.map((s) => s.id)).toEqual(['filesystem', 'context7']);

    // toggle & import & delete
    const toggled = toggleMcpServerSetting(raw, { id: 'filesystem', enabled: false, agents: ['claude'] });
    expect(parseMcpServersSetting(toggled).find((s) => s.id === 'filesystem')).toMatchObject({
      enabled: false,
      agents: ['claude'],
    });

    const imported = importMcpServersSetting(
      toggled,
      [{ name: 'sentry', transport: 'sse', url: 'https://mcp.sentry.dev/sse', importedFrom: 'Cursor' }],
      ['dsh'],
    );
    expect(parseMcpServersSetting(imported).find((s) => s.id === 'sentry')).toMatchObject({
      transport: 'sse',
      importedFrom: 'Cursor',
      agents: ['dsh'],
    });

    const afterDel = deleteMcpServerSetting(imported, 'context7');
    expect(parseMcpServersSetting(afterDel).map((s) => s.id)).toEqual(['filesystem', 'sentry']);
  });

  it('从 Claude Code、DeepSeek (dsh)、Pi、CodeBuddy、Codex、OpenCode 与 VS Code 配置文件扫描导入 MCP', async () => {
    const homeDir = await makeTempDir('hd-mcp-home-');
    const workspacePath = await makeTempDir('hd-mcp-ws-');

    // 1. Claude Code ~/.claude.json（含全局与项目级 mcpServers）
    await writeFile(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'tok' } },
        },
        projects: {
          [workspacePath]: {
            mcpServers: {
              projDb: { type: 'http', url: 'https://db.internal/mcp', headers: { 'X-Key': '123' } },
            },
          },
        },
      }),
      'utf8',
    );

    // 2. DeepSeek ~/.dsh/cordis.patch.yml
    await mkdir(join(homeDir, '.dsh'), { recursive: true });
    await writeFile(
      join(homeDir, '.dsh', 'cordis.patch.yml'),
      [
        '- insert:',
        '    - id: mcp-fetch',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        serverName: dsh-fetch',
        '        transport: streamable-http',
        '        url: "https://fetch.example.com/mcp"',
      ].join('\n'),
      'utf8',
    );

    // 3. Pi ~/.omp/agent/mcp.json
    await mkdir(join(homeDir, '.omp', 'agent'), { recursive: true });
    await writeFile(
      join(homeDir, '.omp', 'agent', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
        },
      }),
      'utf8',
    );

    // 4. Codex ~/.codex/config.toml
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(
      join(homeDir, '.codex', 'config.toml'),
      [
        '[mcp_servers.openai_docs]',
        'url = "https://developers.openai.com/mcp"',
        '',
        '[mcp_servers.sqlite]',
        'command = "uvx"',
        'args = ["mcp-server-sqlite", "--db", "test.db"]',
        '[mcp_servers.sqlite.env]',
        'SQLITE_RO = "1"',
      ].join('\n'),
      'utf8',
    );

    // 5. OpenCode ~/.config/opencode/opencode.jsonc（带注释、尾逗号与 URL）
    await mkdir(join(homeDir, '.config', 'opencode'), { recursive: true });
    const jsoncContent = `{
      // OpenCode MCP 配置
      "mcp": {
        "local_git": {
          "type": "local",
          "command": ["uvx", "mcp-server-git"],
          "environment": { "GIT_TRACE": "0" },
        },
        "remote_docs": {
          "type": "remote",
          "url": "https://docs.opencode.ai/mcp", // 保留 URL 双斜杠
        },
      },
    }`;
    expect(parseJsonc(jsoncContent)).toBeTruthy();
    await writeFile(join(homeDir, '.config', 'opencode', 'opencode.jsonc'), jsoncContent, 'utf8');

    // 6. Workspace .vscode/mcp.json (`servers` 字段)
    await mkdir(join(workspacePath, '.vscode'), { recursive: true });
    await writeFile(
      join(workspacePath, '.vscode', 'mcp.json'),
      JSON.stringify({
        servers: {
          playwright: { command: 'npx', args: ['@playwright/mcp@latest'] },
        },
      }),
      'utf8',
    );

    expect(parseCodexTomlMcpServers('invalid')).toEqual([]);
    expect(parseDshPatchYamlMcpServers('')).toEqual([]);

    const result = await scanAgentMcpConfigs({
      homeDir,
      workspacePath,
      existingIds: new Set(['github']),
    });

    const names = result.items.map((i) => i.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'github',
        'projDb',
        'dsh-fetch',
        'memory',
        'openai_docs',
        'sqlite',
        'local_git',
        'remote_docs',
        'playwright',
      ]),
    );

    const gh = result.items.find((i) => i.name === 'github')!;
    expect(gh.conflict).toBe(true);
    expect(gh.sourceAgentName).toBe('Claude Code');

    const localGit = result.items.find((i) => i.name === 'local_git')!;
    expect(localGit).toMatchObject({
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-git'],
      env: { GIT_TRACE: '0' },
    });
  });

  it('AcpController 在 session/new 中传递选中的 MCP 服务器与 Claude Skills 目录，并在远程 MCP 不兼容时自动回退到 stdio', async () => {
    const newSessionCalls: unknown[] = [];
    let rejectRemoteOnce = true;

    const link: AcpLink = {
      request: async <T,>(method: string, params: unknown): Promise<T> => {
        if (method === 'session/new') {
          newSessionCalls.push(params);
          const mcpList = (params as { mcpServers?: { type?: string }[] }).mcpServers ?? [];
          if (rejectRemoteOnce && mcpList.some((m) => m.type === 'http')) {
            rejectRemoteOnce = false;
            throw new AcpError(method, -32602, 'Invalid params: http mcp unsupported');
          }
          return { sessionId: 'sess-1' } as T;
        }
        return {} as T;
      },
      notify: () => undefined,
    };

    const controller = new AcpController({
      workspacePath: '/workspace',
      post: () => undefined,
      log: () => undefined,
      openExternal: () => undefined,
      showLogs: () => undefined,
      restartRuntime: () => undefined,
      loadActiveSessionId: () => undefined,
      saveActiveSessionId: () => undefined,
      loadSessions: () => [],
      saveSessions: () => undefined,
      backends: () => ({ items: [{ id: 'claude', name: 'Claude Code', kind: 'acp' }], active: 'claude' }),
      mcpServers: () => [
        {
          id: 'fs',
          name: 'fs',
          transport: 'stdio',
          command: 'npx',
          args: ['server-fs'],
          enabled: true,
          agents: ['claude'],
        },
        {
          id: 'remote',
          name: 'remote',
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          enabled: true,
          agents: ['claude'],
        },
      ],
      skillsContext: () => ({
        mode: 'claude-meta',
        bundleDir: '/storage/runtime/bundles/claude',
        skills: [
          {
            id: 'frontend-design',
            name: 'frontend-design',
            description: 'UI polish skill',
            repoUrl: 'https://github.com/anthropics/skills.git',
            skillMdPath: '/storage/skills/installed/frontend-design/SKILL.md',
            enabled: true,
            installedAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    });

    controller.setLink(link, {
      agentCapabilities: {
        mcpCapabilities: { http: true },
      },
    });

    await controller.handle({ type: 'sendMessage', payload: { text: 'hello', includeActive: false } });

    expect(newSessionCalls).toHaveLength(2);
    // 第一次尝试同时携带 stdio + http MCP 以及 Claude additionalDirectories
    expect(newSessionCalls[0]).toMatchObject({
      cwd: '/workspace',
      _meta: {
        claudeCode: {
          options: {
            additionalDirectories: ['/storage/runtime/bundles/claude'],
          },
        },
      },
    });
    expect((newSessionCalls[0] as { mcpServers: unknown[] }).mcpServers).toHaveLength(2);
    // 遇到 -32602 后自动降级保留 stdio MCP 成功建会话
    expect((newSessionCalls[1] as { mcpServers: { name: string }[] }).mcpServers.map((m) => m.name)).toEqual(['fs']);

    // 快照的斜杠命令中包含已安装的 Skill
    expect(controller.snapshot().commands.some((c) => c.name === 'frontend-design')).toBe(true);
    controller.dispose();
  });

  it('支持扫描本机/工作区 Agent 技能目录、手动目录扫描、本地安全导入与本地同步更新', async () => {
    const homeDir = await makeTempDir('hd-skill-home-');
    const workspacePath = await makeTempDir('hd-skill-ws-');
    const storageRoot = await makeTempDir('hd-skill-store-');
    const customDir = await makeTempDir('hd-skill-custom-');

    const claudeSkillDir = join(homeDir, '.claude', 'skills', 'code-review');
    await mkdir(claudeSkillDir, { recursive: true });
    await writeFile(
      join(claudeSkillDir, 'SKILL.md'),
      '---\nname: code-review\ndescription: Review TypeScript PRs\n---\nCheck types and tests.\n',
      'utf8',
    );

    const wsSkillDir = join(workspacePath, '.agents', 'skills', 'ui-style');
    await mkdir(wsSkillDir, { recursive: true });
    await writeFile(
      join(wsSkillDir, 'SKILL.md'),
      '---\nname: ui-style\ndescription: Polish UI\n---\nKeep spacing tight.\n',
      'utf8',
    );

    const customSkillDir = join(customDir, 'release-check');
    await mkdir(customSkillDir, { recursive: true });
    await writeFile(
      join(customSkillDir, 'SKILL.md'),
      '---\nname: release-check\ndescription: Pre-release checks\n---\nRun tests.\n',
      'utf8',
    );

    const scanned = await scanAgentSkills({
      homeDir,
      workspacePath,
      storageRoot,
      existingIds: new Set(['ui-style']),
    });
    expect(scanned.items.map((i) => i.name).sort()).toEqual(['code-review', 'ui-style']);
    expect(scanned.items.find((i) => i.name === 'code-review')?.sourceAgentName).toBe('Claude Code');
    expect(scanned.items.find((i) => i.name === 'ui-style')?.conflict).toBe(true);

    const picked = await scanLocalSkillDirectory(customDir);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.name).toBe('release-check');

    const imported = await importLocalSkills({
      storageRoot,
      skills: [
        { sourceDir: claudeSkillDir, importedFrom: 'Claude Code' },
        { sourceDir: picked[0]!.sourceDir, importedFrom: picked[0]!.sourceAgentName },
      ],
      agents: ['claude', 'codex'],
    });
    expect(imported.installed.map((s) => s.id)).toEqual(['code-review', 'release-check']);
    expect(imported.installed[0]).toMatchObject({
      sourceKind: 'local',
      importedFrom: 'Claude Code',
      agents: ['claude', 'codex'],
    });
    expect(existsSync(imported.installed[0]!.skillMdPath)).toBe(true);

    // 修改源目录 SKILL.md 后同步更新
    await writeFile(
      join(claudeSkillDir, 'SKILL.md'),
      '---\nname: code-review\ndescription: Updated review guide\n---\nUpdated content.\n',
      'utf8',
    );
    const synced = await syncInstalledSkill({ storageRoot, id: 'code-review' });
    expect(synced.find((s) => s.id === 'code-review')?.description).toBe('Updated review guide');
  });

  it('在线扩展市场：支持 MCP Registry 实时解析、GitHub 技能实时拉取、缓存与离线兜底', async () => {
    clearMarketCacheForTests();

    const parsed = parseMcpRegistryPayload({
      servers: [
        {
          server: {
            name: 'io.github.acme/super-db',
            description: 'Query Postgres and SQLite databases live',
            version: '1.2.0',
            packages: [
              {
                registryType: 'npm',
                identifier: '@acme/super-db-mcp',
                environmentVariables: [{ name: 'DB_URL', isRequired: true }],
              },
            ],
          },
          _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true } },
        },
        {
          server: {
            name: 'com.figma/figma-mcp',
            description: 'Inspect Figma frames',
            version: '2.0.0',
            remotes: [{ type: 'streamable-http', url: 'https://mcp.figma.com/mcp' }],
          },
        },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      id: 'super-db',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@acme/super-db-mcp'],
      envKeys: ['DB_URL'],
      needsConfig: true,
      category: 'data',
      version: '1.2.0',
    });
    expect(parsed[1]).toMatchObject({
      id: 'figma-mcp',
      transport: 'http',
      url: 'https://mcp.figma.com/mcp',
      category: 'collab',
    });

    // 在线拉取 MCP 市场并命中缓存，force 可跳过缓存
    let mcpCalls = 0;
    const mockMcpFetch: typeof fetch = async () => {
      mcpCalls++;
      return new Response(
        JSON.stringify({
          servers: [
            {
              server: {
                name: 'io.example/live-tool',
                description: 'Live registry server',
                version: '0.9.1',
                remotes: [{ type: 'streamable-http', url: 'https://live.example.com/mcp' }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const firstMcp = await fetchOnlineMcpMarket({ query: 'live', fetchImpl: mockMcpFetch });
    expect(firstMcp.source).toBe('online');
    expect(firstMcp.items[0]?.id).toBe('live-tool');
    await fetchOnlineMcpMarket({ query: 'live', fetchImpl: mockMcpFetch });
    expect(mcpCalls).toBe(1);
    await fetchOnlineMcpMarket({ query: 'live', force: true, fetchImpl: mockMcpFetch });
    expect(mcpCalls).toBe(2);

    // 断网时 MCP 市场回退到离线精选目录
    const fallbackMcp = await fetchOnlineMcpMarket({
      query: 'offline-test',
      force: true,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(fallbackMcp.source).toBe('fallback');
    expect(fallbackMcp.items.length).toBe(BUILTIN_MCP_MARKET.length);
    expect(fallbackMcp.error).toContain('ECONNREFUSED');

    // 在线拉取 GitHub 技能仓库树 + SKILL.md Frontmatter，并支持 skills.sh 在线搜索
    const mockSkillFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('skills.sh/api/search')) {
        const parsedUrl = new URL(url);
        const q = parsedUrl.searchParams.get('q') ?? '';
        if (q === 'tailwind') {
          return new Response(
            JSON.stringify({
              skills: [
                {
                  id: 'community/skills/tailwind-pro',
                  source: 'community/skills',
                  skillId: 'tailwind-pro',
                  name: 'tailwind-pro',
                  installs: 12400,
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ skills: [] }), { status: 200 });
      }
      if (url.includes('/repos/anthropics/skills/git/trees/')) {
        return new Response(
          JSON.stringify({
            tree: [{ type: 'blob', path: 'skills/brand-new-skill/SKILL.md' }],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/repos/vercel-labs/agent-skills/git/trees/')) {
        return new Response(JSON.stringify({ tree: [] }), { status: 200 });
      }
      if (url.includes('brand-new-skill/SKILL.md')) {
        return new Response('---\nname: brand-new-skill\ndescription: Live React UI toolkit\n---\nBody\n', {
          status: 200,
        });
      }
      return new Response('not found', { status: 404 });
    };
    const onlineSkills = await fetchOnlineSkillMarket({ force: true, fetchImpl: mockSkillFetch });
    expect(onlineSkills.source).toBe('online');
    expect(onlineSkills.items).toEqual([
      expect.objectContaining({
        id: 'anthropic:brand-new-skill',
        name: 'brand-new-skill',
        description: 'Live React UI toolkit',
        category: 'frontend',
      }),
    ]);

    const searchedSkills = await fetchOnlineSkillMarket({ query: 'tailwind', force: true, fetchImpl: mockSkillFetch });
    expect(searchedSkills.source).toBe('online');
    expect(searchedSkills.query).toBe('tailwind');
    expect(searchedSkills.items).toEqual([
      expect.objectContaining({
        id: 'community/skills/tailwind-pro',
        name: 'tailwind-pro',
        repo: 'community/skills',
        subpath: 'skills/tailwind-pro',
        installs: 12400,
      }),
    ]);

    // 断网时技能市场回退到离线精选目录
    const fallbackSkills = await fetchOnlineSkillMarket({
      force: true,
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    expect(fallbackSkills.source).toBe('fallback');
    expect(fallbackSkills.items.length).toBe(BUILTIN_SKILL_MARKET.length);
    expect(fallbackSkills.error).toContain('network down');
  });
});
