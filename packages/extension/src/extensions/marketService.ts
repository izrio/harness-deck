/**
 * 在线扩展市场服务（MCP 市场 + Agent 技能市场）：
 * - MCP 市场：实时对接官方 MCP Registry API（https://registry.modelcontextprotocol.io/v0/servers），
 *   解析 remotes（Streamable HTTP / SSE）与 packages（npm / pypi / oci），带 TTL 缓存与离线精选兜底。
 * - 技能市场：实时扫描官方开源 SKILL.md 仓库树并抓取最新 SKILL.md Frontmatter，带 TTL 缓存与离线精选兜底。
 */
import type {
  McpMarketCategory,
  McpMarketItem,
  McpMarketState,
  McpTransport,
  SkillMarketCategory,
  SkillMarketItem,
  SkillMarketState,
} from '@harness-deck/shared';
import { parseSkillMarkdown } from './skillService.ts';

const MCP_REGISTRY_ENDPOINT = 'https://registry.modelcontextprotocol.io/v0/servers';
const MCP_MARKET_CACHE_TTL_MS = 5 * 60 * 1000;
const SKILL_MARKET_CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1_500_000;
const USER_AGENT = 'Halo-IDE-Extension/1.0';

interface SkillRepoSource {
  readonly repo: string;
  readonly ref: string;
  readonly idPrefix: string;
}

const OFFICIAL_SKILL_REPOS: readonly SkillRepoSource[] = [
  { repo: 'anthropics/skills', ref: 'main', idPrefix: 'anthropic' },
  { repo: 'vercel-labs/agent-skills', ref: 'main', idPrefix: 'vercel' },
];

export const BUILTIN_SKILL_MARKET: readonly SkillMarketItem[] = [
  {
    id: 'anthropic:frontend-design',
    name: 'frontend-design',
    repo: 'anthropics/skills',
    ref: 'main',
    subpath: 'skills/frontend-design',
    category: 'frontend',
    description: 'Build distinctive, production-grade frontend interfaces',
    descZh: '构建高质感前端界面与组件，避免模板化视觉',
    descEn: 'Build distinctive, production-grade frontend interfaces',
  },
  {
    id: 'vercel:vercel-react-best-practices',
    name: 'vercel-react-best-practices',
    repo: 'vercel-labs/agent-skills',
    ref: 'main',
    subpath: 'skills/vercel-react-best-practices',
    category: 'frontend',
    description: 'React and Next.js performance and engineering best practices',
    descZh: 'React 与 Next.js 性能优化及工程最佳实践',
    descEn: 'React and Next.js performance and engineering best practices',
  },
  {
    id: 'vercel:web-design-guidelines',
    name: 'web-design-guidelines',
    repo: 'vercel-labs/agent-skills',
    ref: 'main',
    subpath: 'skills/web-design-guidelines',
    category: 'frontend',
    description: 'Review UI code against web accessibility and UX guidelines',
    descZh: '审查 Web 界面可访问性、交互与布局规范',
    descEn: 'Review UI code against web accessibility and UX guidelines',
  },
  {
    id: 'vercel:vercel-composition-patterns',
    name: 'vercel-composition-patterns',
    repo: 'vercel-labs/agent-skills',
    ref: 'main',
    subpath: 'skills/vercel-composition-patterns',
    category: 'frontend',
    description: 'Scalable React component composition patterns',
    descZh: '可扩展的 React 组件组合与状态设计模式',
    descEn: 'Scalable React component composition patterns',
  },
  {
    id: 'anthropic:mcp-builder',
    name: 'mcp-builder',
    repo: 'anthropics/skills',
    ref: 'main',
    subpath: 'skills/mcp-builder',
    category: 'dev',
    description: 'Design, implement, and test MCP servers cleanly',
    descZh: '按规范设计、实现并测试 MCP 服务器',
    descEn: 'Design, implement, and test MCP servers cleanly',
  },
  {
    id: 'anthropic:skill-creator',
    name: 'skill-creator',
    repo: 'anthropics/skills',
    ref: 'main',
    subpath: 'skills/skill-creator',
    category: 'dev',
    description: 'Author, refine, and evaluate new SKILL.md skills',
    descZh: '编写、精炼并评估新的 Agent SKILL.md 技能',
    descEn: 'Author, refine, and evaluate new SKILL.md skills',
  },
  {
    id: 'anthropic:web-artifacts-builder',
    name: 'web-artifacts-builder',
    repo: 'anthropics/skills',
    ref: 'main',
    subpath: 'skills/web-artifacts-builder',
    category: 'dev',
    description: 'Build interactive React + Tailwind web artifacts',
    descZh: '快速构建 React + Tailwind 交互式 Web 产物',
    descEn: 'Build interactive React + Tailwind web artifacts',
  },
  {
    id: 'anthropic:pdf',
    name: 'pdf',
    repo: 'anthropics/skills',
    ref: 'main',
    subpath: 'skills/pdf',
    category: 'docs',
    description: 'Extract, manipulate, and generate PDF documents',
    descZh: 'PDF 文本提取、合并拆分与文档生成',
    descEn: 'Extract, manipulate, and generate PDF documents',
  },
  {
    id: 'anthropic:docx',
    name: 'docx',
    repo: 'anthropics/skills',
    ref: 'main',
    subpath: 'skills/docx',
    category: 'docs',
    description: 'Create, edit, and review Word (.docx) documents',
    descZh: '创建、修改与批注 Word (.docx) 文档',
    descEn: 'Create, edit, and review Word (.docx) documents',
  },
  {
    id: 'anthropic:pptx',
    name: 'pptx',
    repo: 'anthropics/skills',
    ref: 'main',
    subpath: 'skills/pptx',
    category: 'docs',
    description: 'Create and edit PowerPoint (.pptx) presentations',
    descZh: '生成与编排 PowerPoint (.pptx) 演示文稿',
    descEn: 'Create and edit PowerPoint (.pptx) presentations',
  },
  {
    id: 'anthropic:canvas-design',
    name: 'canvas-design',
    repo: 'anthropics/skills',
    ref: 'main',
    subpath: 'skills/canvas-design',
    category: 'design',
    description: 'Create visual posters and graphic canvas designs',
    descZh: '海报、配图与平面视觉排版设计',
    descEn: 'Create visual posters and graphic canvas designs',
  },
  {
    id: 'anthropic:theme-factory',
    name: 'theme-factory',
    repo: 'anthropics/skills',
    ref: 'main',
    subpath: 'skills/theme-factory',
    category: 'design',
    description: 'Apply cohesive color palettes and typography themes',
    descZh: '为文档与演示产物应用统一主题配色与字体',
    descEn: 'Apply cohesive color palettes and typography themes',
  },
];

export const BUILTIN_MCP_MARKET: readonly McpMarketItem[] = [
  {
    id: 'context7',
    name: 'context7',
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    category: 'dev',
    description: 'Fetch up-to-date documentation and code examples for libraries.',
    descZh: '实时检索主流开源库最新版本文档与代码示例。',
    descEn: 'Fetch up-to-date documentation and code examples for libraries.',
  },
  {
    id: 'github',
    name: 'github',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    needsConfig: true,
    category: 'dev',
    description: 'Manage GitHub repositories, issues, pull requests, and code search.',
    descZh: '管理 GitHub 仓库、Issue、Pull Request 与代码搜索。',
    descEn: 'Manage GitHub repositories, issues, pull requests, and code search.',
  },
  {
    id: 'filesystem',
    name: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    category: 'dev',
    description: 'Read, write, and search local files within allowed directories.',
    descZh: '按目录权限安全读写与检索本地文件。',
    descEn: 'Read, write, and search local files within allowed directories.',
  },
  {
    id: 'git',
    name: 'git',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-git'],
    category: 'dev',
    description: 'Inspect Git status, commit history, branches, and diffs.',
    descZh: '读取 Git 状态、提交历史、分支与差异。',
    descEn: 'Inspect Git status, commit history, branches, and diffs.',
  },
  {
    id: 'sequential-thinking',
    name: 'sequential-thinking',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    category: 'dev',
    description: 'Structured step-by-step reasoning for complex problem solving.',
    descZh: '结构化分步推理，适合复杂问题拆解与方案验证。',
    descEn: 'Structured step-by-step reasoning for complex problem solving.',
  },
  {
    id: 'playwright',
    name: 'playwright',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    category: 'web',
    description: 'Browser automation, screenshots, and end-to-end UI inspection.',
    descZh: '自动化操控浏览器、页面截图与端到端交互验证。',
    descEn: 'Browser automation, screenshots, and end-to-end UI inspection.',
  },
  {
    id: 'fetch',
    name: 'fetch',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    category: 'web',
    description: 'Fetch web pages and convert HTML content into clean Markdown.',
    descZh: '抓取网页正文并自动转换为精简 Markdown。',
    descEn: 'Fetch web pages and convert HTML content into clean Markdown.',
  },
  {
    id: 'brave-search',
    name: 'brave-search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envKeys: ['BRAVE_API_KEY'],
    needsConfig: true,
    category: 'web',
    description: 'Web and local search powered by the Brave Search API.',
    descZh: '通过 Brave Search API 执行实时网页与本地信息检索。',
    descEn: 'Web and local search powered by the Brave Search API.',
  },
  {
    id: 'memory',
    name: 'memory',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    category: 'data',
    description: 'Persistent knowledge-graph memory across sessions.',
    descZh: '基于本地知识图谱跨会话持久记录实体与关系。',
    descEn: 'Persistent knowledge-graph memory across sessions.',
  },
  {
    id: 'postgres',
    name: 'postgres',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
    needsConfig: true,
    category: 'data',
    description: 'Inspect schemas and run read-only SQL queries on PostgreSQL.',
    descZh: '只读查询 PostgreSQL 表结构与 SQL 数据。',
    descEn: 'Inspect schemas and run read-only SQL queries on PostgreSQL.',
  },
  {
    id: 'sqlite',
    name: 'sqlite',
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-sqlite'],
    category: 'data',
    description: 'Query and inspect local SQLite databases.',
    descZh: '本地 SQLite 数据库表结构查看与 SQL 查询分析。',
    descEn: 'Query and inspect local SQLite databases.',
  },
  {
    id: 'figma',
    name: 'figma',
    transport: 'http',
    url: 'https://mcp.figma.com/mcp',
    category: 'collab',
    description: 'Inspect Figma frames, design tokens, and component hierarchies.',
    descZh: '读取 Figma 设计稿节点、样式变量与组件结构。',
    descEn: 'Inspect Figma frames, design tokens, and component hierarchies.',
  },
  {
    id: 'linear',
    name: 'linear',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    category: 'collab',
    description: 'Browse and update Linear issues, projects, and cycles.',
    descZh: '读取和更新 Linear 项目、Issue 与研发周期。',
    descEn: 'Browse and update Linear issues, projects, and cycles.',
  },
  {
    id: 'notion',
    name: 'notion',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    envKeys: ['NOTION_TOKEN'],
    needsConfig: true,
    category: 'collab',
    description: 'Search, read, and update Notion pages and databases.',
    descZh: '搜索、阅读并同步更新 Notion 文档与数据库。',
    descEn: 'Search, read, and update Notion pages and databases.',
  },
];

const BUILTIN_SKILL_BY_KEY = new Map<string, SkillMarketItem>(
  BUILTIN_SKILL_MARKET.map((item) => [`${item.repo.toLowerCase()}:${item.subpath.toLowerCase()}`, item]),
);
const BUILTIN_MCP_BY_NAME = new Map<string, McpMarketItem>(
  BUILTIN_MCP_MARKET.map((item) => [item.name.toLowerCase(), item]),
);

const mcpMarketCache = new Map<string, { readonly expiresAt: number; readonly state: McpMarketState }>();
let skillMarketCache: { readonly expiresAt: number; readonly state: SkillMarketState } | undefined;

export function clearMarketCacheForTests(): void {
  mcpMarketCache.clear();
  skillMarketCache = undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fetchTextCapped(
  url: string,
  fetchImpl: typeof fetch,
  accept = 'application/json',
): Promise<string> {
  const response = await fetchImpl(url, {
    headers: { Accept: accept, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error('response too large');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('response too large');
  }
  return text;
}

export function inferMcpCategory(name: string, description: string): McpMarketCategory {
  const haystack = `${name} ${description}`.toLowerCase();
  if (/(figma|linear|notion|slack|jira|discord|trello|asana|calendar|mail|gmail|confluence|lark|feishu)/u.test(haystack)) {
    return 'collab';
  }
  if (/(postgres|mysql|sqlite|mongo|redis|supabase|snowflake|bigquery|clickhouse|database|sql|memory|graph|qdrant|pinecone|elastic)/u.test(haystack)) {
    return 'data';
  }
  if (/(playwright|puppeteer|browser|crawl|scrape|search|brave|exa|tavily|firecrawl|fetch|web|http|youtube|maps)/u.test(haystack)) {
    return 'web';
  }
  return 'dev';
}

export function inferSkillCategory(name: string, description: string): SkillMarketCategory {
  const haystack = `${name} ${description}`.toLowerCase();
  if (/(react|next|vue|svelte|frontend|web-design|tailwind|css|ui|ux|component)/u.test(haystack)) {
    return 'frontend';
  }
  if (/(pdf|docx|pptx|xlsx|word|excel|powerpoint|doc|markdown|slide|spreadsheet|writing)/u.test(haystack)) {
    return 'docs';
  }
  if (/(design|canvas|theme|poster|brand|visual|art|svg|color|palette|typography)/u.test(haystack)) {
    return 'design';
  }
  return 'dev';
}

function shortMcpSlug(rawName: string): string {
  const trimmed = rawName.trim();
  const slashIdx = trimmed.lastIndexOf('/');
  const base = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
  return base.replace(/^@[^/]+\//u, '').trim() || trimmed;
}

function normalizeMarketId(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 80) || 'mcp-server'
  );
}

/** 解析官方 MCP Registry API 返回的 JSON 为统一的 McpMarketItem 列表。 */
export function parseMcpRegistryPayload(payload: unknown): McpMarketItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.servers)) return [];

  const deduped = new Map<string, McpMarketItem>();
  for (const rawEntry of payload.servers) {
    if (!isRecord(rawEntry)) continue;
    const server = isRecord(rawEntry.server) ? rawEntry.server : rawEntry;
    const meta = isRecord(rawEntry._meta) ? rawEntry._meta : undefined;
    const officialMeta =
      meta && isRecord(meta['io.modelcontextprotocol.registry/official'])
        ? meta['io.modelcontextprotocol.registry/official']
        : undefined;
    if (officialMeta && officialMeta.isLatest === false) continue;

    const fullName = typeof server.name === 'string' ? server.name.trim() : '';
    if (!fullName) continue;
    const slug = shortMcpSlug(fullName);
    const id = normalizeMarketId(slug);
    if (deduped.has(id)) continue;

    const description = typeof server.description === 'string' ? server.description.trim() : '';
    const version = typeof server.version === 'string' ? server.version.trim() : undefined;
    const repositoryUrl =
      isRecord(server.repository) && typeof server.repository.url === 'string'
        ? server.repository.url.trim()
        : undefined;

    let transport: McpTransport | undefined;
    let url: string | undefined;
    let command: string | undefined;
    let args: string[] | undefined;
    let envKeys: string[] | undefined;
    let needsConfig = false;

    // 1. 优先检查远程 HTTP / SSE 端点
    if (Array.isArray(server.remotes)) {
      for (const remote of server.remotes) {
        if (!isRecord(remote) || typeof remote.url !== 'string') continue;
        const remoteUrl = remote.url.trim();
        if (!/^https?:\/\/\S+/iu.test(remoteUrl)) continue;
        const rawType = typeof remote.type === 'string' ? remote.type.toLowerCase() : '';
        transport = rawType === 'sse' ? 'sse' : 'http';
        url = remoteUrl;
        if (/\{[^}]+\}/u.test(remoteUrl)) needsConfig = true;
        if (Array.isArray(remote.headers)) {
          const hasRequiredHeader = remote.headers.some(
            (h) => isRecord(h) && (h.isRequired === true || h.isSecret === true),
          );
          if (hasRequiredHeader) needsConfig = true;
        }
        break;
      }
    }

    // 2. 否则解析本地安装包（npm / pypi / oci）
    if (!transport && Array.isArray(server.packages)) {
      for (const pkg of server.packages) {
        if (!isRecord(pkg)) continue;
        const identifier = typeof pkg.identifier === 'string' ? pkg.identifier.trim() : '';
        if (!identifier) continue;
        const registryType =
          typeof pkg.registryType === 'string'
            ? pkg.registryType.toLowerCase()
            : typeof pkg.registry_type === 'string'
              ? pkg.registry_type.toLowerCase()
              : '';
        if (registryType === 'npm') {
          transport = 'stdio';
          command = 'npx';
          args = ['-y', identifier];
        } else if (registryType === 'pypi') {
          transport = 'stdio';
          command = 'uvx';
          args = [identifier];
        } else if (registryType === 'oci') {
          transport = 'stdio';
          command = 'docker';
          args = ['run', '-i', '--rm', identifier];
        } else {
          continue;
        }

        const rawEnv = Array.isArray(pkg.environmentVariables)
          ? pkg.environmentVariables
          : Array.isArray(pkg.environment_variables)
            ? pkg.environment_variables
            : [];
        const keys: string[] = [];
        for (const ev of rawEnv) {
          if (!isRecord(ev) || typeof ev.name !== 'string') continue;
          const k = ev.name.trim();
          if (k) keys.push(k);
          if (ev.isRequired === true || ev.isSecret === true) needsConfig = true;
        }
        if (keys.length > 0) {
          envKeys = keys;
          needsConfig = true;
        }
        break;
      }
    }

    if (!transport) continue;

    const builtin = BUILTIN_MCP_BY_NAME.get(slug.toLowerCase()) ?? BUILTIN_MCP_BY_NAME.get(id);
    const desc = description || builtin?.description || fullName;

    deduped.set(id, {
      id,
      name: slug,
      transport,
      ...(command ? { command } : {}),
      ...(args && args.length > 0 ? { args } : {}),
      ...(envKeys && envKeys.length > 0 ? { envKeys } : {}),
      ...(url ? { url } : {}),
      ...(needsConfig ? { needsConfig: true } : {}),
      category: builtin?.category ?? inferMcpCategory(slug, desc),
      description: desc,
      ...(builtin?.descZh ? { descZh: builtin.descZh } : {}),
      ...(description ? { descEn: description } : builtin?.descEn ? { descEn: builtin.descEn } : {}),
      ...(version ? { version } : {}),
      ...(repositoryUrl ? { repositoryUrl } : {}),
    });
  }

  return [...deduped.values()];
}

export async function fetchOnlineMcpMarket(options?: {
  readonly query?: string;
  readonly force?: boolean;
  readonly fetchImpl?: typeof fetch;
}): Promise<McpMarketState> {
  const cleanQuery = options?.query?.trim() ?? '';
  const cacheKey = cleanQuery.toLowerCase();
  const now = Date.now();
  if (!options?.force) {
    const cached = mcpMarketCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.state;
    }
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  try {
    const url = new URL(MCP_REGISTRY_ENDPOINT);
    url.searchParams.set('limit', '40');
    if (cleanQuery) {
      url.searchParams.set('search', cleanQuery);
    }
    const raw = await fetchTextCapped(url.toString(), fetchImpl);
    const parsed = parseMcpRegistryPayload(JSON.parse(raw));
    // 无搜索词时把离线精选里的核心常用项合并到前部去重，保证常用服务器始终一触即达
    const merged: McpMarketItem[] = [];
    const seen = new Set<string>();
    if (!cleanQuery) {
      for (const item of parsed) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        merged.push(item);
      }
      for (const item of BUILTIN_MCP_MARKET) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        merged.push(item);
      }
    } else {
      merged.push(...parsed);
    }

    const state: McpMarketState = {
      items: merged,
      source: 'online',
      ...(cleanQuery ? { query: cleanQuery } : {}),
      updatedAt: now,
    };
    mcpMarketCache.set(cacheKey, { expiresAt: now + MCP_MARKET_CACHE_TTL_MS, state });
    return state;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      items: BUILTIN_MCP_MARKET,
      source: 'fallback',
      ...(cleanQuery ? { query: cleanQuery } : {}),
      updatedAt: now,
      error: detail,
    };
  }
}

async function fetchRepoSkills(
  source: SkillRepoSource,
  fetchImpl: typeof fetch,
): Promise<SkillMarketItem[]> {
  const treeUrl = `https://api.github.com/repos/${source.repo}/git/trees/${encodeURIComponent(source.ref)}?recursive=1`;
  const rawTree = await fetchTextCapped(treeUrl, fetchImpl, 'application/vnd.github+json');
  const treeJson: unknown = JSON.parse(rawTree);
  if (!isRecord(treeJson) || !Array.isArray(treeJson.tree)) return [];

  const skillPaths: { readonly subpath: string; readonly rawPath: string; readonly folderName: string }[] = [];
  for (const node of treeJson.tree) {
    if (!isRecord(node) || node.type !== 'blob' || typeof node.path !== 'string') continue;
    const match = /^(.+)\/SKILL\.md$/iu.exec(node.path);
    if (!match) continue;
    const subpath = match[1]!;
    const folderName = subpath.split('/').pop() ?? subpath;
    skillPaths.push({ subpath, rawPath: node.path, folderName });
  }

  const items: SkillMarketItem[] = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < skillPaths.length; i += CONCURRENCY) {
    const batch = skillPaths.slice(i, i + CONCURRENCY);
    const resolved = await Promise.all(
      batch.map(async (entry): Promise<SkillMarketItem> => {
        const key = `${source.repo.toLowerCase()}:${entry.subpath.toLowerCase()}`;
        const builtin = BUILTIN_SKILL_BY_KEY.get(key);
        let name = builtin?.name ?? entry.folderName;
        let description = builtin?.description ?? '';

        try {
          const rawUrl = `https://raw.githubusercontent.com/${source.repo}/${encodeURIComponent(source.ref)}/${entry.rawPath}`;
          const md = await fetchTextCapped(rawUrl, fetchImpl, 'text/plain');
          const meta = parseSkillMarkdown(md, entry.folderName);
          if (meta.name) name = meta.name;
          if (meta.description) description = meta.description;
        } catch {
          // 单个 SKILL.md 抓取失败时保留目录名与内置简介
        }

        const desc = description || builtin?.description || name;
        return {
          id: `${source.idPrefix}:${name}`,
          name,
          repo: source.repo,
          ref: source.ref,
          subpath: entry.subpath,
          category: builtin?.category ?? inferSkillCategory(name, desc),
          description: desc,
          ...(builtin?.descZh ? { descZh: builtin.descZh } : {}),
          ...(description ? { descEn: description } : builtin?.descEn ? { descEn: builtin.descEn } : {}),
        };
      }),
    );
    items.push(...resolved);
  }

  return items;
}

export async function fetchOnlineSkillMarket(options?: {
  readonly force?: boolean;
  readonly fetchImpl?: typeof fetch;
}): Promise<SkillMarketState> {
  const now = Date.now();
  if (!options?.force && skillMarketCache && skillMarketCache.expiresAt > now) {
    return skillMarketCache.state;
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const settled = await Promise.allSettled(
    OFFICIAL_SKILL_REPOS.map((repo) => fetchRepoSkills(repo, fetchImpl)),
  );

  const collected: SkillMarketItem[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];

  for (const res of settled) {
    if (res.status === 'fulfilled') {
      for (const item of res.value) {
        const key = item.id.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(item);
      }
    } else {
      errors.push(res.reason instanceof Error ? res.reason.message : String(res.reason));
    }
  }

  if (collected.length === 0) {
    return {
      items: BUILTIN_SKILL_MARKET,
      source: 'fallback',
      updatedAt: now,
      ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
    };
  }

  const state: SkillMarketState = {
    items: collected,
    source: 'online',
    updatedAt: now,
  };
  skillMarketCache = { expiresAt: now + SKILL_MARKET_CACHE_TTL_MS, state };
  return state;
}
