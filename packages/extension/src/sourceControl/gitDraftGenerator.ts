/**
 * AI / 启发式提交信息与 PR 描述生成器（P0-2）：
 * - 优先调用已配置的直连服务商（OpenAI Chat / Anthropic Messages）根据真实 Diff 快速单轮生成；
 * - 未配置直连服务商、网络离线或接口超时时，自动回退到本地变更摘要规则生成 Conventional Commit / PR 草稿，保证零阻塞、总可用。
 */
import type { Locale, ProviderConfig, SourceControlFileView } from '@harness-deck/shared';
import { createProxyAwareFetch, type FetchLike } from '../providers/proxyFetch.ts';
import { readGitStatus, runGit } from './gitStatus.ts';

const defaultFetch: FetchLike = createProxyAwareFetch();

export interface DirectProviderCandidate {
  readonly provider: ProviderConfig;
  readonly apiKey: string;
}

export interface GeneratedCommitResult {
  readonly message: string;
  readonly source: 'ai' | 'heuristic';
}

export interface GeneratedPrDraftResult {
  readonly title: string;
  readonly body: string;
  readonly source: 'ai' | 'heuristic';
}

const MAX_DIFF_CHARS = 12_000;
const AI_TIMEOUT_MS = 12_000;

function inferCommitType(files: readonly SourceControlFileView[]): string {
  if (files.length === 0) return 'chore';
  const paths = files.map((f) => f.path.toLowerCase());
  if (paths.every((p) => p.endsWith('.md') || p.includes('/docs/'))) return 'docs';
  if (paths.every((p) => p.includes('test') || p.includes('.spec.') || p.includes('.test.'))) return 'test';
  if (paths.every((p) => p.endsWith('.css') || p.endsWith('.scss'))) return 'style';
  if (files.every((f) => f.status === 'added' || f.status === 'untracked')) return 'feat';
  if (paths.some((p) => p.includes('fix'))) return 'fix';
  return 'feat';
}

function inferScope(files: readonly SourceControlFileView[]): string | undefined {
  if (files.length === 0) return undefined;
  const segments = files.map((f) => {
    const parts = f.path.replace(/\\/gu, '/').split('/').filter(Boolean);
    if (parts[0] === 'packages' && parts[1]) return parts[1];
    if (parts[0] === 'src' && parts[1] && parts.length > 2) return parts[1];
    return parts.length > 1 ? parts[0]! : undefined;
  });
  const unique = [...new Set(segments.filter((s): s is string => Boolean(s)))];
  if (unique.length === 1) return unique[0];
  return undefined;
}

/** 离线启发式生成 Conventional Commit 信息。 */
export function buildHeuristicCommitMessage(files: readonly SourceControlFileView[], locale: Locale): string {
  if (files.length === 0) return locale === 'zh' ? 'chore: 更新工作区改动' : 'chore: update workspace changes';
  const type = inferCommitType(files);
  const scope = inferScope(files);
  const prefix = scope ? `${type}(${scope})` : type;
  const firstFile = files[0]!.path.replace(/\\/gu, '/').split('/').pop() ?? files[0]!.path;
  if (files.length === 1) {
    const verb =
      files[0]!.status === 'added' || files[0]!.status === 'untracked'
        ? locale === 'zh'
          ? '新增'
          : 'add'
        : files[0]!.status === 'deleted'
          ? locale === 'zh'
            ? '移除'
            : 'remove'
          : locale === 'zh'
            ? '更新'
            : 'update';
    return `${prefix}: ${verb} ${firstFile}`;
  }
  const summary =
    locale === 'zh'
      ? `更新 ${firstFile} 等 ${files.length} 个文件`
      : `update ${firstFile} and ${files.length - 1} other files`;
  return `${prefix}: ${summary}`;
}

/** 离线启发式生成 PR 标题与 Markdown 正文。 */
export function buildHeuristicPrDraft(
  files: readonly SourceControlFileView[],
  branch: string | undefined,
  commits: readonly string[],
  locale: Locale,
): { readonly title: string; readonly body: string } {
  const title =
    commits[0]?.trim() ||
    (branch && branch !== 'main' && branch !== 'master'
      ? branch.replace(/[-_/]+/gu, ' ').trim()
      : buildHeuristicCommitMessage(files, locale));
  const heading = locale === 'zh' ? '## 改动摘要' : '## Summary';
  const filesHeading = locale === 'zh' ? '## 涉及文件' : '## Changed Files';
  const commitLines = commits.slice(0, 8).map((c) => `- ${c}`);
  const fileLines = files.slice(0, 20).map((f) => `- \`${f.path}\` (${f.status})`);
  const sections = [heading, commitLines.length > 0 ? commitLines.join('\n') : `- ${buildHeuristicCommitMessage(files, locale)}`];
  if (fileLines.length > 0) {
    sections.push('', filesHeading, fileLines.join('\n'));
  }
  return { title, body: sections.join('\n') };
}

async function callDirectProvider(
  candidate: DirectProviderCandidate,
  systemPrompt: string,
  userPrompt: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<string | undefined> {
  const { provider, apiKey } = candidate;
  const model = provider.smallModel || provider.defaultModel || provider.models[0]?.id;
  if (!model || !apiKey) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    if (provider.openaiChatUrl) {
      const base = provider.openaiChatUrl.replace(/\/+$/u, '');
      const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 400,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return json.choices?.[0]?.message?.content?.trim() || undefined;
    }

    if (provider.anthropicUrl) {
      const base = provider.anthropicUrl.replace(/\/+$/u, '');
      const url = base.endsWith('/messages') ? base : `${base}/v1/messages`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 400,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) return undefined;
      const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
      return json.content?.find((c) => c.type === 'text')?.text?.trim() || undefined;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function collectDiffSnippet(cwd: string): Promise<string> {
  const [staged, unstaged, status] = await Promise.all([
    runGit(['diff', '--cached', '--stat'], cwd).catch(() => ''),
    runGit(['diff', '--stat'], cwd).catch(() => ''),
    runGit(['status', '--short'], cwd).catch(() => ''),
  ]);
  const fullDiff =
    (await runGit(['diff', '--cached'], cwd).catch(() => '')) ||
    (await runGit(['diff'], cwd).catch(() => ''));
  const combined = [status && `STATUS:\n${status}`, staged && `STAGED STAT:\n${staged}`, unstaged && `UNSTAGED STAT:\n${unstaged}`, fullDiff && `DIFF:\n${fullDiff}`]
    .filter(Boolean)
    .join('\n\n');
  return combined.slice(0, MAX_DIFF_CHARS);
}

/** 生成 Git Commit Message（优先直连 Provider，不可用时回退规则生成）。 */
export async function generateCommitMessage(
  cwd: string,
  options: {
    readonly locale: Locale;
    readonly provider?: DirectProviderCandidate;
    readonly fetchImpl?: FetchLike;
  },
): Promise<GeneratedCommitResult> {
  const sc = await readGitStatus(cwd, { checkGh: false });
  const fallback = buildHeuristicCommitMessage(sc.files, options.locale);
  if (!options.provider) return { message: fallback, source: 'heuristic' };

  const diff = await collectDiffSnippet(cwd);
  if (!diff.trim()) return { message: fallback, source: 'heuristic' };

  const langHint = options.locale === 'zh' ? '使用简体中文撰写描述部分' : 'Write the description in concise English';
  const system = `You generate a single-line Conventional Commit message (e.g. feat(scope): summary). ${langHint}. Output ONLY the commit message without quotes, markdown fences, or explanations.`;
  const raw = await callDirectProvider(options.provider, system, diff, options.fetchImpl);
  const cleaned = raw?.replace(/^```[a-z]*\n?/iu, '').replace(/\n?```$/u, '').trim().split('\n')[0]?.trim();
  if (cleaned && cleaned.length >= 4 && cleaned.length <= 200) {
    return { message: cleaned, source: 'ai' };
  }
  return { message: fallback, source: 'heuristic' };
}

/** 生成 PR 标题与正文草稿（优先直连 Provider，不可用时回退规则生成）。 */
export async function generatePrDraft(
  cwd: string,
  options: {
    readonly locale: Locale;
    readonly provider?: DirectProviderCandidate;
    readonly fetchImpl?: FetchLike;
  },
): Promise<GeneratedPrDraftResult> {
  const sc = await readGitStatus(cwd, { checkGh: false });
  const logOut = await runGit(['log', '-n', '10', '--format=%s'], cwd).catch(() => '');
  const commits = logOut
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const fallback = buildHeuristicPrDraft(sc.files, sc.branch, commits, options.locale);
  if (!options.provider) return { ...fallback, source: 'heuristic' };

  const diff = await collectDiffSnippet(cwd);
  const context = [`BRANCH: ${sc.branch ?? 'unknown'}`, commits.length ? `RECENT COMMITS:\n${commits.join('\n')}` : '', diff]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, MAX_DIFF_CHARS);

  const langHint = options.locale === 'zh' ? '使用简体中文' : 'Write in concise English';
  const system = `Generate a Pull Request title and short Markdown body summarizing the changes. ${langHint}. Format strictly as:\nTITLE: <one line title>\nBODY:\n<markdown bullet summary>`;
  const raw = await callDirectProvider(options.provider, system, context, options.fetchImpl);
  if (raw) {
    const titleMatch = /^TITLE:\s*(.+)$/im.exec(raw);
    const bodyMatch = /BODY:\s*([\s\S]+)$/im.exec(raw);
    const title = titleMatch?.[1]?.trim();
    const body = bodyMatch?.[1]?.trim();
    if (title && body) return { title, body, source: 'ai' };
  }
  return { ...fallback, source: 'heuristic' };
}
