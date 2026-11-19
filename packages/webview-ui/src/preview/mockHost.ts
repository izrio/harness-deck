import type {
  AppearanceState,
  BackendsState,
  ContextState,
  HostSnapshot,
  HostToWebview,
  Item,
  Locale,
  ModelState,
  PermissionState,
  PreferencesState,
  ProjectsState,
  ScheduleRule,
  TabView,
  WebviewToHost,
  WorkbenchState,
} from '@harness-deck/shared';
import {
  createInitialSessionList,
  createInitialSessions,
  createInitialWorkbench,
  PREVIEW_BACKENDS,
  PREVIEW_COMMANDS,
  PREVIEW_EXTENSIONS,
  PREVIEW_FILES,
  PREVIEW_MODELS,
  PREVIEW_PERMISSIONS,
  PREVIEW_PREFERENCES,
  PREVIEW_PROJECTS,
  PREVIEW_PROVIDERS,
  PREVIEW_WORKSPACE_PATH,
  type PreviewSessionData,
} from './mockData.ts';

const STATE_STORAGE_KEY = 'harness-deck:preview-persisted-state';

function readPersistedState(): unknown {
  try {
    const raw = window.localStorage.getItem(STATE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function writePersistedState(state: unknown): void {
  try {
    window.localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore storage errors in restricted browser contexts
  }
}

function postToWebview(message: HostToWebview): void {
  window.postMessage(message, '*');
}

function resolveLocale(pref: PreferencesState['language']): Locale {
  if (pref === 'zh' || pref === 'en') return pref;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function syncPreviewBodyClass(theme: AppearanceState['theme']): void {
  const isDark =
    theme === 'dark' ||
    (theme !== 'light' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('vscode-dark', isDark);
  document.body.classList.toggle('vscode-light', !isDark);
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

function installMockHost(): void {
  const sessions: Record<string, PreviewSessionData> = createInitialSessions();
  let sessionList = createInitialSessionList(sessions);
  let backends: BackendsState = PREVIEW_BACKENDS;
  const backendNameOf = (id: string): string => backends.items.find((b) => b.id === id)?.name ?? id;
  let tabs: TabView[] = [
    {
      key: 'tab-main',
      sessionId: 'session-preview-main',
      backendId: 'dsh',
      backendName: backendNameOf('dsh'),
      title: sessions['session-preview-main']!.header.title,
      running: false,
    },
    {
      key: 'tab-approval',
      sessionId: 'session-preview-approval',
      backendId: 'claude',
      backendName: backendNameOf('claude'),
      title: sessions['session-preview-approval']!.header.title,
      running: false,
      needsAttention: true,
    },
  ];
  let activeTabKey = 'tab-main';
  let models: ModelState = PREVIEW_MODELS;
  let permissions: PermissionState = PREVIEW_PERMISSIONS;
  let preferences: PreferencesState = PREVIEW_PREFERENCES;
  let appearance: AppearanceState = { theme: 'system', colorScheme: 'slate' };
  let locale: Locale = resolveLocale(preferences.language);
  let projects: ProjectsState = PREVIEW_PROJECTS;
  let workbench: WorkbenchState = createInitialWorkbench();
  let context: ContextState = {
    includeActiveByDefault: true,
    active: { kind: 'file', path: 'packages/webview-ui/src/App.tsx', key: 'preview-active' },
    pinned: [],
  };

  let activeStreamTimer: number | undefined;
  let activeStreamSessionId: string | undefined;

  syncPreviewBodyClass(appearance.theme);

  const currentTab = (): TabView | undefined => tabs.find((t) => t.key === activeTabKey) ?? tabs[0];

  const currentSessionId = (): string | undefined => currentTab()?.sessionId;

  const emptyHeader = () => ({
    title: locale === 'zh' ? '新对话' : 'New chat',
    running: false,
    hasOlder: false,
    loadingOlder: false,
    sync: 'live' as const,
    folder: 'harness-deck',
  });

  const currentSessionData = (): PreviewSessionData => {
    const id = currentSessionId();
    return id && sessions[id] ? sessions[id]! : { header: emptyHeader(), items: [], interactions: [] };
  };

  const syncTabsAndList = (): void => {
    tabs = tabs.map((tab) => {
      if (!tab.sessionId || !sessions[tab.sessionId]) return tab;
      const data = sessions[tab.sessionId]!;
      return {
        ...tab,
        title: data.header.title,
        running: data.header.running,
        needsAttention: data.interactions.length > 0,
      };
    });
    sessionList = Object.entries(sessions).map(([id, data], idx) => ({
      id,
      title: data.header.title,
      updatedAt: Date.now() - idx * 60_000,
      running: data.header.running,
      needsAttention: data.interactions.length > 0,
    }));
    postToWebview({ type: 'tabs', payload: { items: tabs, active: activeTabKey } });
    postToWebview({ type: 'sessions', payload: sessionList });
  };

  const pushActiveSession = (): void => {
    const data = currentSessionData();
    const sessionKey = data.header.id ?? '';
    postToWebview({ type: 'session', payload: data.header });
    postToWebview({
      type: 'items',
      payload: { sessionKey, reset: true, order: data.items.map((i) => i.id), upsert: data.items },
    });
    postToWebview({ type: 'interactions', payload: data.interactions });
  };

  const buildSnapshot = (): HostSnapshot => {
    const data = currentSessionData();
    return {
      hostKind: 'vscode',
      runtime: { kind: 'connected', version: '0.4.0', newerThanTested: false },
      connection: 'connected',
      sessions: sessionList,
      tabs: { items: tabs, active: activeTabKey },
      session: data.header,
      items: data.items,
      models,
      interactions: data.interactions,
      permissions,
      workspace: { dirtyFiles: 0 },
      context,
      commands: PREVIEW_COMMANDS,
      locale,
      appearance,
      preferences,
      backends,
      providers: PREVIEW_PROVIDERS,
      projects,
      extensions: PREVIEW_EXTENSIONS,
      workbench,
    };
  };

  const stopStream = (interrupted: boolean): void => {
    if (activeStreamTimer !== undefined) {
      window.clearInterval(activeStreamTimer);
      activeStreamTimer = undefined;
    }
    const sid = activeStreamSessionId;
    activeStreamSessionId = undefined;
    if (!sid || !sessions[sid]) return;
    const prev = sessions[sid]!;
    const nextItems = prev.items.map((item) =>
      item.kind === 'assistant' && item.streaming ? { ...item, streaming: false, ...(interrupted ? { interrupted: true } : {}) } : item,
    );
    sessions[sid] = {
      ...prev,
      header: { ...prev.header, running: false, runningSince: undefined },
      items: nextItems,
    };
    syncTabsAndList();
    if (currentSessionId() === sid) pushActiveSession();
  };

  const simulateReply = (sessionId: string, prompt: string): void => {
    stopStream(false);
    const data = sessions[sessionId];
    if (!data) return;

    const userItem: Item = { kind: 'user', id: nextId('u'), text: prompt };
    const assistantId = nextId('a');
    const startedAt = Date.now();
    const reasoning = '浏览器本地预览模式正在模拟推理与流式工具输出，用于验证排版、代码块高亮和状态栏响应。';
    const replyChunks = [
      `已收到你的消息：**「${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}」**\n\n`,
      '这是浏览器本地预览模式生成的模拟流式回复：\n\n',
      '- 当前底层：`',
      backends.items.find((b) => b.id === backends.active)?.name ?? backends.active,
      '`\n- 当前模型：`',
      models.current?.model ?? 'default',
      '`\n\n',
      '```tsx\nexport function PreviewReady() {\n  return <span>HMR + Mock Host 预览运行中</span>;\n}\n```\n',
    ];

    sessions[sessionId] = {
      ...data,
      header: {
        ...data.header,
        title: data.items.length === 0 ? prompt.slice(0, 28) : data.header.title,
        running: true,
        runningSince: startedAt,
      },
      items: [
        ...data.items,
        userItem,
        { kind: 'assistant', id: assistantId, markdown: '', reasoning, streaming: true },
      ],
    };
    syncTabsAndList();
    if (currentSessionId() === sessionId) pushActiveSession();

    let chunkIdx = 0;
    let accumulated = '';
    activeStreamSessionId = sessionId;
    activeStreamTimer = window.setInterval(() => {
      const latest = sessions[sessionId];
      if (!latest) {
        stopStream(false);
        return;
      }
      if (chunkIdx < replyChunks.length) {
        accumulated += replyChunks[chunkIdx]!;
        chunkIdx += 1;
        const assistantItem: Item = { kind: 'assistant', id: assistantId, markdown: accumulated, reasoning, streaming: true };
        sessions[sessionId] = {
          ...latest,
          items: latest.items.map((item) => (item.id === assistantId ? assistantItem : item)),
        };
        if (currentSessionId() === sessionId) {
          postToWebview({
            type: 'items',
            payload: {
              sessionKey: sessionId,
              reset: false,
              order: sessions[sessionId]!.items.map((i) => i.id),
              upsert: [assistantItem],
            },
          });
        }
        return;
      }

      if (activeStreamTimer !== undefined) {
        window.clearInterval(activeStreamTimer);
        activeStreamTimer = undefined;
      }
      activeStreamSessionId = undefined;
      const doneAssistant: Item = { kind: 'assistant', id: assistantId, markdown: accumulated, reasoning, streaming: false };
      const doneTurn: Item = { kind: 'turnDone', id: nextId('td'), durationMs: Date.now() - startedAt, completed: true };
      sessions[sessionId] = {
        ...latest,
        header: { ...latest.header, running: false, runningSince: undefined },
        items: [...latest.items.map((item) => (item.id === assistantId ? doneAssistant : item)), doneTurn],
      };
      syncTabsAndList();
      if (currentSessionId() === sessionId) pushActiveSession();
    }, 90);
  };

  const handleMessage = (message: WebviewToHost): void => {
    switch (message.type) {
      case 'ready':
        postToWebview({ type: 'snapshot', payload: buildSnapshot() });
        return;

      case 'sendMessage': {
        let sid = currentSessionId();
        if (!sid) {
          const newSid = nextId('session');
          const title = message.payload.text.slice(0, 28) || '新对话';
          sessions[newSid] = {
            header: {
              id: newSid,
              title,
              running: false,
              hasOlder: false,
              loadingOlder: false,
              sync: 'live',
              folder: 'harness-deck',
            },
            items: [],
            interactions: [],
          };
          tabs = tabs.map((t) => (t.key === activeTabKey ? { ...t, sessionId: newSid, title } : t));
          sid = newSid;
        }
        simulateReply(sid, message.payload.text);
        return;
      }

      case 'interrupt':
        stopStream(true);
        return;

      case 'newSession': {
        const emptyTab = tabs.find((t) => !t.sessionId);
        if (emptyTab) {
          tabs = tabs.map((t) =>
            t.key === emptyTab.key ? { ...t, backendId: backends.active, backendName: backendNameOf(backends.active) } : t,
          );
          activeTabKey = emptyTab.key;
        } else {
          const key = nextId('tab');
          tabs = [
            ...tabs,
            {
              key,
              backendId: backends.active,
              backendName: backendNameOf(backends.active),
              title: locale === 'zh' ? '新对话' : 'New chat',
              running: false,
            },
          ];
          activeTabKey = key;
        }
        syncTabsAndList();
        pushActiveSession();
        return;
      }

      case 'switchSession': {
        const existing = tabs.find((t) => t.sessionId === message.payload.sessionId);
        if (existing) {
          activeTabKey = existing.key;
          if (existing.backendId && existing.backendId !== backends.active) {
            backends = { ...backends, active: existing.backendId };
            postToWebview({ type: 'backends', payload: backends });
          }
        } else {
          const key = nextId('tab');
          const title = sessions[message.payload.sessionId]?.header.title ?? message.payload.label ?? '会话';
          tabs = [
            ...tabs,
            {
              key,
              sessionId: message.payload.sessionId,
              backendId: backends.active,
              backendName: backendNameOf(backends.active),
              title,
              running: false,
            },
          ];
          activeTabKey = key;
        }
        syncTabsAndList();
        pushActiveSession();
        postToWebview({ type: 'navigateToSession', payload: { sessionId: message.payload.sessionId } });
        return;
      }

      case 'activateTab': {
        activeTabKey = message.payload.key;
        const target = tabs.find((t) => t.key === activeTabKey);
        if (target?.backendId && target.backendId !== backends.active) {
          backends = { ...backends, active: target.backendId };
          postToWebview({ type: 'backends', payload: backends });
        }
        syncTabsAndList();
        pushActiveSession();
        return;
      }

      case 'closeTab': {
        tabs = tabs.filter((t) => t.key !== message.payload.key);
        if (tabs.length === 0) {
          const key = nextId('tab');
          tabs = [
            {
              key,
              backendId: backends.active,
              backendName: backendNameOf(backends.active),
              title: locale === 'zh' ? '新对话' : 'New chat',
              running: false,
            },
          ];
        }
        if (!tabs.some((t) => t.key === activeTabKey)) activeTabKey = tabs[tabs.length - 1]!.key;
        const nextActive = tabs.find((t) => t.key === activeTabKey);
        if (nextActive?.backendId && nextActive.backendId !== backends.active) {
          backends = { ...backends, active: nextActive.backendId };
          postToWebview({ type: 'backends', payload: backends });
        }
        syncTabsAndList();
        pushActiveSession();
        return;
      }

      case 'loadOlder': {
        const sid = currentSessionId();
        if (!sid || !sessions[sid]) return;
        const current = sessions[sid]!;
        const pages = current.olderPages ?? [];
        if (!current.header.hasOlder || current.header.loadingOlder || pages.length === 0) return;
        sessions[sid] = {
          ...current,
          header: { ...current.header, loadingOlder: true },
        };
        postToWebview({ type: 'session', payload: sessions[sid]!.header });
        window.setTimeout(() => {
          const latest = sessions[sid];
          if (!latest) return;
          const remaining = latest.olderPages ?? [];
          const [nextPage, ...rest] = remaining;
          if (!nextPage) {
            sessions[sid] = {
              ...latest,
              header: { ...latest.header, hasOlder: false, loadingOlder: false },
              olderPages: [],
            };
          } else {
            const mergedItems = [...nextPage, ...latest.items];
            sessions[sid] = {
              ...latest,
              header: { ...latest.header, hasOlder: rest.length > 0, loadingOlder: false },
              items: mergedItems,
              olderPages: rest,
            };
            if (currentSessionId() === sid) {
              postToWebview({ type: 'session', payload: sessions[sid]!.header });
              postToWebview({
                type: 'items',
                payload: {
                  sessionKey: sid,
                  reset: false,
                  order: mergedItems.map((i) => i.id),
                  upsert: [...nextPage],
                },
              });
            }
            return;
          }
          if (currentSessionId() === sid) postToWebview({ type: 'session', payload: sessions[sid]!.header });
        }, 180);
        return;
      }

      case 'selectModel':
        models = { ...models, current: message.payload };
        postToWebview({ type: 'models', payload: models });
        return;

      case 'selectPermission':
        permissions = { ...permissions, current: message.payload.preset };
        postToWebview({ type: 'permissions', payload: permissions });
        return;

      case 'selectBackend': {
        const nextIdVal = message.payload.id;
        backends = { ...backends, active: nextIdVal };
        const cur = tabs.find((t) => t.key === activeTabKey);
        if (cur && !cur.sessionId) {
          tabs = tabs.map((t) =>
            t.key === cur.key ? { ...t, backendId: nextIdVal, backendName: backendNameOf(nextIdVal) } : t,
          );
        } else {
          const existing = [...tabs].reverse().find((t) => t.backendId === nextIdVal);
          if (existing) {
            activeTabKey = existing.key;
          } else {
            const key = nextId('tab');
            tabs = [
              ...tabs,
              {
                key,
                backendId: nextIdVal,
                backendName: backendNameOf(nextIdVal),
                title: locale === 'zh' ? '新对话' : 'New chat',
                running: false,
              },
            ];
            activeTabKey = key;
          }
        }
        postToWebview({ type: 'backends', payload: backends });
        syncTabsAndList();
        pushActiveSession();
        return;
      }

      case 'setAppearance': {
        const p = message.payload;
        appearance = {
          ...appearance,
          ...(p.theme !== undefined ? { theme: p.theme ?? undefined } : {}),
          ...(p.colorScheme !== undefined ? { colorScheme: p.colorScheme ?? undefined } : {}),
          ...(p.fontSize !== undefined ? { fontSize: p.fontSize ?? undefined } : {}),
          ...(p.fontFamily !== undefined ? { fontFamily: p.fontFamily ?? undefined } : {}),
          ...(p.lineHeight !== undefined ? { lineHeight: p.lineHeight ?? undefined } : {}),
          ...(p.paragraphSpacing !== undefined ? { paragraphSpacing: p.paragraphSpacing ?? undefined } : {}),
          ...(p.contentWidth !== undefined ? { contentWidth: p.contentWidth ?? undefined } : {}),
          ...(p.codeFontFamily !== undefined ? { codeFontFamily: p.codeFontFamily ?? undefined } : {}),
          ...(p.terminalFontSize !== undefined ? { terminalFontSize: p.terminalFontSize ?? undefined } : {}),
          ...(p.terminalLineHeight !== undefined ? { terminalLineHeight: p.terminalLineHeight ?? undefined } : {}),
        };
        syncPreviewBodyClass(appearance.theme);
        postToWebview({ type: 'appearance', payload: appearance });
        return;
      }

      case 'setPreferences': {
        const p = message.payload;
        preferences = {
          ...preferences,
          ...(p.language !== undefined ? { language: p.language } : {}),
          ...(p.includeActiveEditor !== undefined ? { includeActiveEditor: p.includeActiveEditor } : {}),
          ...(p.showTurnChanges !== undefined ? { showTurnChanges: p.showTurnChanges } : {}),
          ...(p.schedulePermission !== undefined ? { schedulePermission: p.schedulePermission } : {}),
          ...(p.chatCommands !== undefined ? { chatCommands: p.chatCommands } : {}),
          ...(p.notifications && preferences.notifications
            ? { notifications: { ...preferences.notifications, ...p.notifications } }
            : {}),
          ...(p.advanced && preferences.advanced ? { advanced: { ...preferences.advanced, ...p.advanced } } : {}),
        };
        locale = resolveLocale(preferences.language);
        postToWebview({ type: 'preferences', payload: preferences });
        postToWebview({ type: 'locale', payload: locale });
        return;
      }

      case 'searchFiles': {
        const q = message.payload.query.trim().toLowerCase();
        const matched = q ? PREVIEW_FILES.filter((f) => f.path.toLowerCase().includes(q)) : PREVIEW_FILES;
        postToWebview({ type: 'fileCandidates', payload: { requestId: message.payload.requestId, items: matched } });
        return;
      }

      case 'removeAttachment':
        context = { ...context, pinned: context.pinned.filter((item) => item.id !== message.payload.id) };
        postToWebview({ type: 'context', payload: context });
        return;

      case 'respondApproval': {
        const sid = currentSessionId();
        if (sid && sessions[sid]) {
          const prev = sessions[sid]!;
          const allowed = message.payload.decision !== 'reject';
          sessions[sid] = {
            ...prev,
            interactions: prev.interactions.filter((i) => i.id !== message.payload.id),
            items: [
              ...prev.items,
              {
                kind: 'assistant',
                id: nextId('a'),
                streaming: false,
                markdown: allowed ? '已批准操作并执行完成（预览模式模拟）。' : '已拒绝本次操作（预览模式模拟）。',
              },
            ],
          };
          syncTabsAndList();
          pushActiveSession();
        }
        return;
      }

      case 'answerQuestion': {
        const sid = currentSessionId();
        if (sid && sessions[sid]) {
          const prev = sessions[sid]!;
          const cancelled = 'cancelled' in message.payload;
          sessions[sid] = {
            ...prev,
            interactions: prev.interactions.filter((i) => i.id !== message.payload.id),
            items: [
              ...prev.items,
              {
                kind: 'assistant',
                id: nextId('a'),
                streaming: false,
                markdown: cancelled ? '已取消本次提问。' : '已收到你的选择，继续按该方案推进（预览模式模拟）。',
              },
            ],
          };
          syncTabsAndList();
          pushActiveSession();
        }
        return;
      }

      case 'openDiff':
        if (message.payload.token !== undefined) {
          postToWebview({ type: 'diffOpened', payload: { token: message.payload.token } });
        }
        postToWebview({ type: 'toast', payload: { level: 'info', text: '浏览器预览模式：Diff 视图需在 IDE 中打开' } });
        return;

      case 'previewMarkdown':
        postToWebview({
          type: 'markdownPreview',
          payload: {
            path: message.payload.path,
            title: message.payload.path.split('/').pop() ?? message.payload.path,
            content: `# ${message.payload.path}\n\n这是浏览器本地预览模式返回的模拟 Markdown 内容。\n\n- 支持 GFM 表格与代码块\n- 支持实时切换配色与阅读排版`,
          },
        });
        return;

      case 'markUnreadRead':
        workbench = {
          ...workbench,
          overview: {
            ...workbench.overview,
            unread: message.payload.all ? [] : workbench.overview.unread.filter((u) => u.id !== message.payload.id),
          },
        };
        postToWebview({ type: 'workbench', payload: workbench });
        return;

      case 'toggleSchedule':
        workbench = {
          ...workbench,
          schedules: workbench.schedules.map((r) => (r.id === message.payload.id ? { ...r, enabled: message.payload.enabled } : r)),
        };
        postToWebview({ type: 'workbench', payload: workbench });
        return;

      case 'upsertSchedule': {
        const p = message.payload;
        const rule: ScheduleRule = {
          id: p.id ?? nextId('sched'),
          name: p.name,
          prompt: p.prompt,
          frequency: p.frequency,
          backendId: p.backendId,
          projectPath: p.projectPath ?? PREVIEW_WORKSPACE_PATH,
          enabled: p.enabled ?? true,
          createdAt: Date.now(),
          runs: [],
        };
        const exists = workbench.schedules.some((r) => r.id === rule.id);
        workbench = {
          ...workbench,
          schedules: exists ? workbench.schedules.map((r) => (r.id === rule.id ? { ...r, ...rule, runs: r.runs } : r)) : [rule, ...workbench.schedules],
        };
        postToWebview({ type: 'workbench', payload: workbench });
        return;
      }

      case 'deleteSchedule':
        workbench = { ...workbench, schedules: workbench.schedules.filter((r) => r.id !== message.payload.id) };
        postToWebview({ type: 'workbench', payload: workbench });
        return;

      case 'createTask': {
        const p = message.payload;
        const task = {
          id: nextId('task'),
          title: p.title?.trim() || p.prompt.slice(0, 32),
          prompt: p.prompt,
          status: p.autoStart ? ('in_progress' as const) : ('todo' as const),
          projectPath: p.projectPath,
          projectName: p.projectPath.split('/').pop() || p.projectPath,
          backendId: p.backendId,
          provider: p.provider,
          model: p.model,
          reasoningEffort: p.reasoningEffort,
          agentId: p.agentId,
          createdAt: Date.now(),
        };
        workbench = { ...workbench, tasks: { ...workbench.tasks, items: [task, ...workbench.tasks.items] } };
        postToWebview({ type: 'workbench', payload: workbench });
        return;
      }

      case 'updateTaskStatus':
        workbench = {
          ...workbench,
          tasks: {
            ...workbench.tasks,
            items: workbench.tasks.items.map((item) => (item.id === message.payload.id ? { ...item, status: message.payload.status } : item)),
          },
        };
        postToWebview({ type: 'workbench', payload: workbench });
        return;

      case 'deleteTask':
        workbench = {
          ...workbench,
          tasks: { ...workbench.tasks, items: workbench.tasks.items.filter((item) => item.id !== message.payload.id) },
        };
        postToWebview({ type: 'workbench', payload: workbench });
        return;

      case 'clearDoneTasks':
        workbench = {
          ...workbench,
          tasks: { ...workbench.tasks, items: workbench.tasks.items.filter((item) => item.status !== 'done') },
        };
        postToWebview({ type: 'workbench', payload: workbench });
        return;

      case 'setTaskQueueAutoRun':
        workbench = { ...workbench, tasks: { ...workbench.tasks, autoRun: message.payload.autoRun } };
        postToWebview({ type: 'workbench', payload: workbench });
        return;

      case 'openProjectSession': {
        const existing = tabs.find((t) => t.sessionId === message.payload.sessionId);
        if (existing) {
          activeTabKey = existing.key;
        } else {
          const key = nextId('tab');
          const title = sessions[message.payload.sessionId]?.header.title ?? '会话';
          tabs = [...tabs, { key, sessionId: message.payload.sessionId, title, running: false }];
          activeTabKey = key;
        }
        syncTabsAndList();
        pushActiveSession();
        postToWebview({ type: 'navigateToSession', payload: { sessionId: message.payload.sessionId } });
        return;
      }

      case 'startProjectSession':
      case 'startAgentSession':
        handleMessage({ type: 'newSession', payload: {} });
        postToWebview({ type: 'navigateToSession', payload: {} });
        return;

      case 'setProjectWorktreeConfig':
        projects = {
          ...projects,
          configs: {
            ...projects.configs,
            [message.payload.path]: {
              copyFiles: message.payload.copyFiles,
              setupCommands: message.payload.setupCommands,
              verifyCommands: message.payload.verifyCommands,
            },
          },
        };
        postToWebview({ type: 'projects', payload: projects });
        return;

      default:
        postToWebview({
          type: 'toast',
          payload: { level: 'info', text: `浏览器预览模式：已模拟触发 ${message.type}` },
        });
    }
  };

  (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (raw: WebviewToHost) => {
      window.setTimeout(() => handleMessage(raw), 0);
    },
    getState: readPersistedState,
    setState: writePersistedState,
  });
}

installMockHost();
