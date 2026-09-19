import { IssueSearch, type SearchState } from './issue-search';
import {
  Pickers,
  type PickerOptions,
  type PickerField,
  type FieldLoad,
} from './pickers';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Pin,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleDot,
  Copy,
  ExternalLink,
  GripVertical,
  Keyboard,
  Link2,
  Loader2,
  LogIn,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  X,
} from 'lucide-react';
import type {
  Choice,
  Connection,
  EditOptions,
  Issue,
  IssuePatch,
  RootReference,
  RootView,
  TableColumn,
  TabState,
  TreeSnapshot,
  Workspace,
} from '../shared/types';
import {
  buildIssueTree,
  defaultShortcuts,
  eventShortcut,
  flattenVisible,
  matchesShortcut,
  parseIssueKey,
  SHORTCUT_LABELS,
  shortcutCollisions,
  filterTree,
  findNode,
  ancestorPath,
  expansionKeys,
  childCounts,
  indexTree,
  type IssueNode,
} from './tree';
import { IssuePreview } from './IssuePreview';
import { RowMenu } from './RowMenu';
import { StatusColors } from './status-colors';
import {
  activateTab,
  closeTabs,
  removeConnection,
  reorderTab,
  reopenTab,
  sameRoot,
  togglePinned,
  travel,
  visit,
  type Navigation,
} from './workspace';
import { TableHeader, ViewSettings } from './TableView';
import {
  canRank,
  defaultRootView,
  DEFAULT_VIEW,
  migrateViews,
  priorityRepresentatives,
  resetRootView,
  rootView,
  setRootView,
  sortIssueTree,
  tableStyle,
} from './table-view';
import { Mutations } from './mutations';
import { RefreshSchedule } from './refresh';
import {
  nextEditableCell,
  retainEditingOrder,
  type EditField,
} from './edit-navigation';

const PLATFORM_SHORTCUTS = defaultShortcuts();
const EMPTY_WORKSPACE: Workspace = {
  tabs: [],
  activeTabId: null,
  shortcuts: PLATFORM_SHORTCUTS,
  theme: 'system',
  sidebarCollapsed: false,
  sidebarWidth: 220,
  previewWidth: 420,
};

type Editor = { connectionId: string; key: string; field: EditField } | null;

function cx(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(' ');
}
function initials(value?: string) {
  return (value ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}
const ASSIGNEE_COLORS = [
  '#2563a6',
  '#087f5b',
  '#8749a8',
  '#b45309',
  '#be3a52',
  '#4f46a5',
  '#0e7490',
  '#6b6617',
];

function AssigneeAvatar({ assignee }: { assignee: Choice | null }) {
  let hash = 0;
  for (const character of assignee?.id ?? '')
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={
        assignee
          ? { backgroundColor: ASSIGNEE_COLORS[hash % ASSIGNEE_COLORS.length] }
          : undefined
      }
    >
      {assignee ? initials(assignee.name) : '—'}
    </span>
  );
}
function priorityTone(name?: string) {
  const value = name?.toLowerCase() ?? '';
  if (/highest|critical|blocker/.test(value)) return 'critical';
  if (/high/.test(value)) return 'high';
  if (/low|lowest/.test(value)) return 'low';
  return 'medium';
}
export function App() {
  const [workspace, setWorkspace] = useState<Workspace>(EMPTY_WORKSPACE);
  const [connections, storeConnections] = useState<Connection[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, TreeSnapshot>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  const [dialog, setDialog] = useState<
    'open' | 'commands' | 'shortcuts' | 'connect' | null
  >(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [options, setOptions] = useState<Record<string, PickerOptions>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [history, setHistory] = useState<Navigation>({ back: [], forward: [] });
  const historyRef = useRef(history);
  const workspaceRef = useRef(workspace);
  const draggedTab = useRef<string | null>(null);
  workspaceRef.current = workspace;
  historyRef.current = history;
  const [queries, setQueries] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<{ tabId: string; key: string } | null>(
    null,
  );
  const [currentUsers, setCurrentUsers] = useState<Record<string, Choice>>({});
  const [identityErrors, setIdentityErrors] = useState<Record<string, string>>(
    {},
  );
  const [identityRetry, setIdentityRetry] = useState(0);
  const identityGeneration = useRef(0);
  const setConnections = (value: Connection[]) => {
    identityGeneration.current += 1;
    setCurrentUsers({});
    setIdentityErrors({});
    setIdentityRetry((retry) => retry + 1);
    storeConnections(value);
  };
  const searchRef = useRef<HTMLInputElement>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<{
    issue: Issue;
    x: number;
    y: number;
  } | null>(null);
  const restoreTreeFocus = useCallback((key?: string) => {
    const row = key
      ? document.querySelector<HTMLElement>(`[data-tree-key="${key}"]`)
      : null;
    row?.focus({ preventScroll: true });
  }, []);
  const closeRowMenu = useCallback(
    (restore = true) => {
      if (restore) restoreTreeFocus(rowMenu?.issue.key);
      setRowMenu(null);
    },
    [restoreTreeFocus, rowMenu],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const displayedTrees = useRef(new Map<string, IssueNode | null>());
  const attemptedLoads = useRef(new Set<string>());
  const refreshSchedule = useRef(new RefreshSchedule());
  const deferredRefreshes = useRef(new Set<string>());
  const refreshBlocked = useRef<(connectionId: string) => boolean>(() => false);
  const [online, setOnline] = useState(navigator.onLine);
  const [foreground, setForeground] = useState(
    document.visibilityState === 'visible' && document.hasFocus(),
  );
  const [connectionErrors, setConnectionErrors] = useState<Set<string>>(
    new Set(),
  );
  const refreshSequences = useRef<Record<string, number>>({});
  const [undoState, setUndoState] = useState<{ label?: string; busy: boolean }>(
    { busy: false },
  );
  const [mutations] = useState(
    () =>
      new Mutations(
        window.canopy,
        (view) => {
          setSnapshots(view.snapshots);
          setSaving(view.saving);
          setUndoState({ label: view.undoLabel, busy: view.undoBusy });
        },
        (message) => setErrors((current) => ({ ...current, edit: message })),
      ),
  );
  const editSession = useRef(0);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const [pickers] = useState(() => new Pickers(window.canopy, setOptions));
  useEffect(() => {
    pickers.clear();
    setEditor(null);
  }, [connections, pickers]);
  useEffect(() => {
    for (const tab of workspace.tabs) {
      const tree = snapshots[tab.id];
      if (tree) pickers.observe(tab.connectionId, tree.issues);
    }
  }, [snapshots, workspace.tabs, pickers]);
  useEffect(
    () => () => {
      if (editor && editor.field !== 'summary')
        pickers.close(editor.connectionId, editor.key, editor.field);
    },
    [editor, pickers],
  );
  const tabsRef = useRef<TabState[]>([]);
  const pendingScrollRestore = useRef<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = workspace.activeTabId;
  refreshBlocked.current = (connectionId) =>
    editorRef.current?.connectionId === connectionId ||
    mutations.pending(connectionId);
  const activeTab =
    workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? null;
  const snapshot = activeTab ? snapshots[activeTab.id] : undefined;
  const query = activeTab ? (queries[activeTab.id] ?? '') : '';
  const filtering = Boolean(
    query.trim() || Object.values(activeTab?.filters ?? {}).some(Boolean),
  );
  useEffect(() => {
    const id = activeTab?.connectionId;
    if (!id || currentUsers[id]) return;
    let live = true;
    const generation = identityGeneration.current;
    window.canopy
      .currentUser(id)
      .then((user) => {
        if (live && generation === identityGeneration.current) {
          setCurrentUsers((current) => ({ ...current, [id]: user }));
          setIdentityErrors((current) => {
            const next = { ...current };
            delete next[id];
            return next;
          });
        }
      })
      .catch((error) => {
        if (live && generation === identityGeneration.current)
          setIdentityErrors((current) => ({
            ...current,
            [id]: `Couldn’t identify your Jira account: ${String(error)}. Check your connection, then retry.`,
          }));
      });
    return () => {
      live = false;
    };
  }, [activeTab?.connectionId, identityRetry]);
  useEffect(() => {
    setReveal(null);
  }, [activeTab?.id, query, activeTab?.filters, activeTab?.hideDone]);
  useEffect(() => {
    setReveal((current) =>
      current?.key === activeTab?.selectedKey ? current : null,
    );
  }, [activeTab?.selectedKey]);
  const view = activeTab ? rootView(workspace, activeTab) : DEFAULT_VIEW;
  const [priorityOrders, setPriorityOrders] = useState<
    Record<string, string[]>
  >({});
  const [priorityErrors, setPriorityErrors] = useState<Record<string, string>>(
    {},
  );
  const representatives = useMemo(
    () => priorityRepresentatives(snapshot?.issues ?? []),
    [snapshot],
  );
  const priorityCacheKey = JSON.stringify([
    activeTab?.connectionId,
    representatives.map(([id]) => id),
  ]);
  const priorityOrder = priorityOrders[priorityCacheKey];
  const priorityError = priorityErrors[priorityCacheKey];
  useEffect(() => {
    if (
      !activeTab ||
      !snapshot ||
      view.sort.column !== 'priority' ||
      priorityOrder ||
      priorityError
    )
      return;
    let live = true;
    window.canopy
      .priorityOrder(
        activeTab.connectionId,
        representatives.map(([, key]) => key),
      )
      .then((order) => {
        if (representatives.some(([id]) => !order.includes(id)))
          throw new Error('Priority values changed. Refresh and try again.');
        if (live)
          setPriorityOrders((current) => ({
            ...current,
            [priorityCacheKey]: order,
          }));
      })
      .catch((error) => {
        if (live)
          setPriorityErrors((current) => ({
            ...current,
            [priorityCacheKey]: String(error.message ?? error),
          }));
      });
    return () => {
      live = false;
    };
  }, [
    activeTab?.connectionId,
    Boolean(snapshot),
    view.sort.column,
    priorityCacheKey,
    priorityOrder,
    priorityError,
  ]);
  const updateView = useCallback(
    (patch: Partial<RootView>) => {
      if (!activeTab) return;
      setWorkspace((current) => setRootView(current, activeTab, patch));
      setDragKey(null);
      setEditor(null);
    },
    [activeTab],
  );
  const statusRegistries = useRef(new Map<string, StatusColors>());
  const statusColors = useMemo(() => {
    if (!activeTab) return new Map<string, string>();
    let registry = statusRegistries.current.get(activeTab.connectionId);
    if (!registry) {
      registry = new StatusColors();
      statusRegistries.current.set(activeTab.connectionId, registry);
    }
    return registry.include(
      snapshot?.issues.map((issue) => issue.status) ?? [],
    );
  }, [activeTab?.connectionId, snapshot]);
  const scopedOptions = useMemo(() => {
    if (!activeTab) return {};
    const prefix = `${activeTab.connectionId}:`;
    return Object.fromEntries(
      Object.entries(options)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value]),
    );
  }, [activeTab?.connectionId, options]);

  useEffect(() => {
    tabsRef.current = workspace.tabs;
  }, [workspace.tabs]);
  useEffect(() => {
    setEditor(null);
    setDragKey(null);
    setPreviewKey(null);
    setRowMenu(null);
    pendingScrollRestore.current = activeTab?.id ?? null;
  }, [activeTab?.id]);

  useEffect(() => {
    if (activeTab?.selectedKey)
      setPreviewKey((current) => (current ? activeTab.selectedKey! : null));
  }, [activeTab?.selectedKey]);
  const closePreview = useCallback(() => {
    setPreviewKey(null);
    restoreTreeFocus(activeTab?.selectedKey ?? activeTab?.rootKey);
  }, [activeTab?.selectedKey, activeTab?.rootKey, restoreTreeFocus]);
  useEffect(() => {
    if (!previewKey || dialog || editor || rowMenu) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        closePreview();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [previewKey, dialog, editor, rowMenu, closePreview]);

  useEffect(() => {
    let live = true;
    Promise.all([window.canopy.connections(), window.canopy.loadWorkspace()])
      .then(([nextConnections, saved]) => {
        if (!live) return;
        setConnections(nextConnections);
        // Remove the retired demo without dropping Jira tabs if a keyring is locked.
        const hasDemo = nextConnections.some(
          (connection) => connection.id === 'demo',
        );
        const tabs = (saved?.tabs ?? []).filter(
          (tab) => tab.connectionId !== 'demo' || hasDemo,
        );
        setWorkspace(
          migrateViews(
            saved
              ? {
                  ...EMPTY_WORKSPACE,
                  ...saved,
                  tabs,
                  pinnedRoots: saved.pinnedRoots?.filter(
                    (root) => root.connectionId !== 'demo' || hasDemo,
                  ),
                  recentRoots: saved.recentRoots?.filter(
                    (root) => root.connectionId !== 'demo' || hasDemo,
                  ),
                  closedTabs: saved.closedTabs?.filter(
                    (root) => root.connectionId !== 'demo' || hasDemo,
                  ),
                  activeTabId: tabs.some((tab) => tab.id === saved.activeTabId)
                    ? saved.activeTabId
                    : (tabs[0]?.id ?? null),
                  shortcuts: { ...PLATFORM_SHORTCUTS, ...saved.shortcuts },
                }
              : EMPTY_WORKSPACE,
          ),
        );
      })
      .catch((error) =>
        setErrors((value) => ({
          ...value,
          app: error instanceof Error ? error.message : String(error),
        })),
      )
      .finally(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = workspace.theme;
    if (!ready) return;
    const timer = window.setTimeout(
      () =>
        void window.canopy.saveWorkspace(workspace).catch((error) => {
          setErrors((value) => ({
            ...value,
            workspace: `Couldn’t save workspace: ${error instanceof Error ? error.message : String(error)}`,
          }));
        }),
      180,
    );
    return () => window.clearTimeout(timer);
  }, [workspace, ready]);

  const refreshTab = useCallback(
    async (tab: TabState, quiet = false, explicit = !quiet) => {
      if (!tabsRef.current.some((item) => item.id === tab.id)) return;
      if (!navigator.onLine || refreshBlocked.current(tab.connectionId)) {
        deferredRefreshes.current.add(tab.id);
        return;
      }
      if (!refreshSchedule.current.begin(tab.id, Date.now(), explicit)) return;
      deferredRefreshes.current.delete(tab.id);
      const sequence = (refreshSequences.current[tab.id] ?? 0) + 1;
      refreshSequences.current[tab.id] = sequence;
      const epoch = mutations.beginRefresh();
      const setter = quiet ? setRefreshing : setLoading;
      setter((current) => new Set(current).add(tab.id));
      try {
        const next = await window.canopy.tree(tab.connectionId, tab.rootKey);
        if (
          refreshSequences.current[tab.id] === sequence &&
          !refreshBlocked.current(tab.connectionId)
        ) {
          mutations.receive(tab, next, epoch);
        } else if (refreshSequences.current[tab.id] === sequence) {
          deferredRefreshes.current.add(tab.id);
        }
        if (refreshSequences.current[tab.id] !== sequence) return;
        setConnectionErrors((current) => {
          const copy = new Set(current);
          copy.delete(tab.id);
          return copy;
        });
        setErrors((current) => {
          const copy = { ...current };
          delete copy[tab.id];
          return copy;
        });
      } catch (error) {
        if (refreshSequences.current[tab.id] !== sequence) return;
        setConnectionErrors((current) => new Set(current).add(tab.id));
        setErrors((current) => ({
          ...current,
          [tab.id]: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        mutations.endRefresh(epoch);
        if (refreshSequences.current[tab.id] === sequence) {
          refreshSchedule.current.finish(tab.id, Date.now());
          setter((current) => {
            const copy = new Set(current);
            copy.delete(tab.id);
            return copy;
          });
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!ready) return;
    const activated = refreshSchedule.current.sync(
      workspace.tabs.map((tab) => tab.id),
      foreground ? workspace.activeTabId : null,
      Date.now(),
    );
    for (const tab of workspace.tabs) {
      if (!snapshots[tab.id] && !attemptedLoads.current.has(tab.id)) {
        attemptedLoads.current.add(tab.id);
        void refreshTab(tab);
      } else if (activated.includes(tab.id)) {
        void refreshTab(tab, true);
      }
    }
  }, [
    ready,
    workspace.tabs,
    workspace.activeTabId,
    foreground,
    snapshots,
    refreshTab,
  ]);

  useEffect(() => {
    if (!ready) return;
    const tick = () => {
      if (!navigator.onLine) return;
      const due = new Set(refreshSchedule.current.due(Date.now()));
      for (const tab of tabsRef.current) {
        if (due.has(tab.id) || deferredRefreshes.current.has(tab.id))
          void refreshTab(tab, true);
      }
    };
    const timer = window.setInterval(tick, 1000);
    const refreshActive = () => {
      const tab = tabsRef.current.find(
        (item) => item.id === activeIdRef.current,
      );
      if (tab) void refreshTab(tab, true);
    };
    const visibility = () => {
      const visible =
        document.visibilityState === 'visible' && document.hasFocus();
      setForeground(visible);
      if (visible) refreshActive();
    };
    const blur = () => setForeground(false);
    const connectivity = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) refreshActive();
    };
    window.addEventListener('focus', visibility);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', connectivity);
    window.addEventListener('offline', connectivity);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', visibility);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', connectivity);
      window.removeEventListener('offline', connectivity);
    };
  }, [ready, refreshTab]);

  useEffect(() => {
    for (const tab of workspace.tabs) {
      if (deferredRefreshes.current.has(tab.id)) void refreshTab(tab, true);
    }
  }, [editor, saving, online, workspace.tabs, refreshTab]);

  const restoreScroll = useCallback((tab: TabState) => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = tab.scrollTop;
    const scrollTop = element.scrollTop;
    if (scrollTop === tab.scrollTop) return;
    // Chromium can clamp without emitting another scroll event after a layout
    // restoration. Save the actual offset even while native events are guarded.
    setWorkspace((current) => {
      if (
        current.activeTabId !== tab.id ||
        current.tabs.find((item) => item.id === tab.id)?.scrollTop !==
          tab.scrollTop
      )
        return current;
      return {
        ...current,
        tabs: current.tabs.map((item) =>
          item.id === tab.id ? { ...item, scrollTop } : item,
        ),
      };
    });
  }, []);

  useLayoutEffect(() => {
    if (activeTab && snapshot) restoreScroll(activeTab);
  }, [snapshot, restoreScroll]);

  useEffect(() => {
    if (
      !activeTab ||
      !snapshot ||
      !scrollRef.current ||
      pendingScrollRestore.current !== activeTab.id
    )
      return;
    restoreScroll(activeTab);
    pendingScrollRestore.current = null;
  }, [activeTab, Boolean(snapshot), restoreScroll]);

  const updateTab = useCallback((tabId: string, patch: Partial<TabState>) => {
    setWorkspace((current) => {
      const tab = current.tabs.find((tab) => tab.id === tabId);
      const next =
        tab && ('hideDone' in patch || 'filters' in patch)
          ? setRootView(current, tab, {
              ...('hideDone' in patch ? { hideDone: patch.hideDone } : {}),
              ...('filters' in patch ? { filters: patch.filters ?? {} } : {}),
            })
          : current;
      return {
        ...next,
        tabs: next.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, ...patch } : tab,
        ),
      };
    });
  }, []);

  const navigate = useCallback((tab: TabState, restoring = false) => {
    const current = workspaceRef.current;
    const from = current.tabs.find((item) => item.id === current.activeTabId);
    if (!restoring) setHistory(visit(historyRef.current, from, tab));
    pendingScrollRestore.current =
      current.tabs.find((item) => sameRoot(item, tab))?.id ?? tab.id;
    setWorkspace((value) => activateTab(value, tab, restoring));
  }, []);

  const selectTab = useCallback(
    (id: string) => {
      const tab = workspaceRef.current.tabs.find((item) => item.id === id);
      if (tab) navigate(tab);
    },
    [navigate],
  );

  const openTab = useCallback(
    (connectionId: string, rootKey: string) => {
      const key = rootKey.toUpperCase();
      const existing = workspaceRef.current.tabs.find(
        (tab) => tab.connectionId === connectionId && tab.rootKey === key,
      );
      navigate(
        existing ?? {
          id:
            globalThis.crypto?.randomUUID?.() ??
            `${Date.now()}-${Math.random()}`,
          connectionId,
          rootKey: key,
          expanded: [key],
          hideDone: rootView(workspaceRef.current, {
            connectionId,
            rootKey: key,
          }).hideDone,
          filters: rootView(workspaceRef.current, {
            connectionId,
            rootKey: key,
          }).filters,
          scrollTop: 0,
        },
      );
      setDialog(null);
    },
    [navigate],
  );

  const forgetTabs = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        mutations.forget(id);
        displayedTrees.current.delete(id);
        attemptedLoads.current.delete(id);
        refreshSequences.current[id] = (refreshSequences.current[id] ?? 0) + 1;
        refreshSchedule.current.forget(id);
        deferredRefreshes.current.delete(id);
      }
      for (const setter of [setLoading, setRefreshing, setConnectionErrors])
        setter(
          (current) => new Set([...current].filter((id) => !ids.includes(id))),
        );
      setErrors((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) => !ids.includes(id)),
        ),
      );
    },
    [mutations],
  );

  const closeTabIds = useCallback(
    (ids: string[]) => {
      forgetTabs(ids);
      setQueries((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) => !ids.includes(id)),
        ),
      );
      setWorkspace((current) => closeTabs(current, ids));
      setTabMenu(null);
    },
    [forgetTabs],
  );
  const closeTab = useCallback(
    (id: string) => closeTabIds([id]),
    [closeTabIds],
  );
  const reopenClosedTab = useCallback(() => {
    const current = workspaceRef.current;
    const next = reopenTab(current);
    if (next === current) return;
    const tab = next.tabs.find((item) => item.id === next.activeTabId)!;
    setHistory(
      visit(
        historyRef.current,
        current.tabs.find((item) => item.id === current.activeTabId),
        tab,
      ),
    );
    pendingScrollRestore.current = tab.id;
    setWorkspace(next);
  }, []);
  const navigateHistory = useCallback(
    (direction: 'back' | 'forward') => {
      const current = workspaceRef.current;
      const result = travel(
        historyRef.current,
        current.tabs.find((item) => item.id === current.activeTabId),
        direction,
      );
      setHistory(result.history);
      if (result.tab) navigate(result.tab, true);
    },
    [navigate],
  );

  const selectRelativeTab = useCallback(
    (direction: -1 | 1) => {
      const current = workspaceRef.current;
      if (current.tabs.length < 2) return;
      const index = current.tabs.findIndex(
        (tab) => tab.id === current.activeTabId,
      );
      navigate(
        current.tabs[
          (index + direction + current.tabs.length) % current.tabs.length
        ],
      );
    },
    [navigate],
  );

  const selectTabAt = useCallback(
    (index: number) => {
      const tab = workspaceRef.current.tabs[index];
      if (tab) navigate(tab);
    },
    [navigate],
  );

  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
        document
          .querySelector<HTMLElement>(
            `[data-tab-id="${CSS.escape(tabMenu.id)}"]`,
          )
          ?.focus();
      }
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [tabMenu]);

  useEffect(() => {
    setWorkspace((current) => {
      let changed = false;
      const summaries = new Map<string, string>();
      for (const tab of current.tabs) {
        const summary = snapshots[tab.id]?.issues.find(
          (issue) => issue.key === tab.rootKey,
        )?.summary;
        if (summary !== undefined)
          summaries.set(`${tab.connectionId}:${tab.rootKey}`, summary);
      }
      const update = <T extends RootReference>(root: T): T => {
        const summary = summaries.get(`${root.connectionId}:${root.rootKey}`);
        if (summary === undefined || summary === root.summary) return root;
        changed = true;
        return { ...root, summary };
      };
      const next = {
        ...current,
        tabs: current.tabs.map(update),
        pinnedRoots: current.pinnedRoots?.map(update),
        recentRoots: current.recentRoots?.map(update),
      };
      return changed ? next : current;
    });
  }, [snapshots]);

  const openExternal = useCallback(
    async (connectionId: string, key: string) => {
      try {
        await window.canopy.openIssue(connectionId, key);
        setErrors((current) => {
          const copy = { ...current };
          delete copy.app;
          return copy;
        });
      } catch (error) {
        setErrors((current) => ({
          ...current,
          app: `Couldn’t open ${key}: ${error instanceof Error ? error.message : String(error)}`,
        }));
      }
    },
    [],
  );

  const copyIssueLink = useCallback(
    async (connectionId: string, key: string) => {
      try {
        await window.canopy.copyIssueLink(connectionId, key);
      } catch (error) {
        setErrors((current) => ({
          ...current,
          app: `Couldn’t copy link for ${key}: ${error instanceof Error ? error.message : String(error)}`,
        }));
      }
    },
    [],
  );

  const expandAll = useCallback(
    (expanded: boolean, includeLinks = false) => {
      if (!activeTab || !snapshot || filtering) return;
      const root = buildIssueTree(snapshot.issues, snapshot.rootKey);
      const focused = findNode(root, activeTab.focusKey) ?? root;
      const keys = expansionKeys(focused);
      const nodes = [
        ...indexTree(filterTree(focused, '', {}, activeTab.hideDone)).values(),
      ];
      const branches = nodes
        .filter((node) => node.children.length > 0)
        .map((node) => node.issue.key);
      const linked = nodes
        .filter((node) => node.issue.links.length > 0)
        .map((node) => node.issue.key);
      const scope = new Set(keys);
      const oldLinks = activeTab.linkedExpanded ?? [];
      const fullyExpanded =
        branches.every((key) => activeTab.expanded.includes(key)) &&
        linked.length > 0 &&
        linked.every((key) => oldLinks.includes(key));
      updateTab(activeTab.id, {
        expanded: expanded
          ? [...new Set([...activeTab.expanded, ...keys])]
          : fullyExpanded && !includeLinks
            ? activeTab.expanded
            : activeTab.expanded.filter((key) => !scope.has(key)),
        linkedExpanded: expanded
          ? includeLinks
            ? [...new Set([...oldLinks, ...linked])]
            : oldLinks
          : oldLinks.filter((key) => !scope.has(key)),
      });
    },
    [activeTab, snapshot, updateTab, filtering],
  );
  const expandDepth = (depth: number, branch = false) => {
    if (!activeTab || !snapshot || filtering) return;
    const root = buildIssueTree(snapshot.issues, snapshot.rootKey);
    const target =
      findNode(root, branch ? activeTab.selectedKey : activeTab.focusKey) ??
      root;
    const scope = new Set(expansionKeys(target));
    updateTab(activeTab.id, {
      expanded: [
        ...activeTab.expanded.filter((key) => !scope.has(key)),
        ...expansionKeys(target, depth),
      ],
    });
  };
  const revealSelection = () => {
    if (!activeTab?.selectedKey || !snapshot) return;
    const root = buildIssueTree(snapshot.issues, snapshot.rootKey);
    const path = ancestorPath(root, activeTab.selectedKey);
    if (!path.length) return;
    updateTab(activeTab.id, {
      focusKey: undefined,
      expanded: filtering
        ? activeTab.expanded
        : [
            ...new Set([
              ...activeTab.expanded,
              ...path.map((node) => node.issue.key),
            ]),
          ],
    });
    setReveal({ tabId: activeTab.id, key: activeTab.selectedKey });
  };

  const commands = useMemo(
    () => [
      {
        id: 'findInTree',
        label: 'Find in tree',
        icon: Search,
        run: () => {
          searchRef.current?.focus();
          searchRef.current?.select();
        },
      },
      {
        id: 'expandLinked',
        label: 'Expand hierarchy and linked issues',
        icon: ChevronsUpDown,
        run: () => expandAll(true, true),
      },
      {
        id: 'collapseLinked',
        label: 'Collapse hierarchy and linked issues',
        icon: ChevronsDownUp,
        run: () => expandAll(false, true),
      },
      {
        id: 'quickOpen',
        label: 'Open issue…',
        icon: Search,
        run: () => setDialog('open'),
      },
      {
        id: 'refresh',
        label: 'Refresh current tree',
        icon: RefreshCw,
        run: () => activeTab && void refreshTab(activeTab, true, true),
      },
      {
        id: 'expandAll',
        label: 'Expand all issues',
        icon: ChevronsUpDown,
        run: () => expandAll(true),
      },
      {
        id: 'collapseAll',
        label: 'Collapse all issues',
        icon: ChevronsDownUp,
        run: () => expandAll(false),
      },
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        icon: Keyboard,
        run: () => setDialog('shortcuts'),
      },
    ],
    [activeTab, expandAll, refreshTab],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = Object.keys(workspace.shortcuts).find((id) =>
        matchesShortcut(event, workspace.shortcuts[id]),
      );
      if (
        !dialog &&
        !editor &&
        !(
          event.target instanceof Element &&
          event.target.closest(
            'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
          )
        ) &&
        !event.shiftKey &&
        ((event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          ['ArrowLeft', 'ArrowRight'].includes(event.key)) ||
          (/mac/i.test(navigator.platform) &&
            event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            ['[', ']'].includes(event.key)))
      ) {
        event.preventDefault();
        navigateHistory(
          ['ArrowLeft', '['].includes(event.key) ? 'back' : 'forward',
        );
        return;
      }
      if (!command) return;
      if (command === 'commandPalette') {
        event.preventDefault();
        setDialog('commands');
      } else if (command === 'quickOpen' || command === 'newTab') {
        event.preventDefault();
        setDialog('open');
      } else if (command === 'closeTab' && activeTab) {
        event.preventDefault();
        closeTab(activeTab.id);
      } else if (command === 'reopenTab') {
        event.preventDefault();
        reopenClosedTab();
      } else if (command === 'nextTab') {
        event.preventDefault();
        selectRelativeTab(1);
      } else if (command === 'previousTab') {
        event.preventDefault();
        selectRelativeTab(-1);
      } else if (command === 'toggleSidebar') {
        event.preventDefault();
        setWorkspace((current) => ({
          ...current,
          sidebarCollapsed: !current.sidebarCollapsed,
        }));
      } else if (/^selectTab[1-9]$/.test(command)) {
        event.preventDefault();
        selectTabAt(Number(command.at(-1)) - 1);
      } else {
        const match = commands.find((item) => item.id === command);
        if (match) {
          event.preventDefault();
          match.run();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    workspace.shortcuts,
    activeTab,
    closeTab,
    commands,
    selectRelativeTab,
    selectTabAt,
    reopenClosedTab,
    navigateHistory,
    dialog,
    editor,
  ]);

  const loadOptions = useCallback(
    async (
      key: string,
      field: PickerField,
      query = '',
      more = false,
      refresh = false,
    ) => {
      if (activeTab)
        await pickers.load(
          activeTab.connectionId,
          key,
          field,
          query,
          more,
          refresh,
        );
    },
    [activeTab, pickers],
  );
  const beginEdit = useCallback(
    (key: string, field: EditField) => {
      if (!activeTab) return;
      editSession.current++;
      setEditor({ connectionId: activeTab.connectionId, key, field });
      if (field !== 'summary')
        void pickers.open(activeTab.connectionId, key, field);
    },
    [activeTab, pickers],
  );

  const updateIssue = useCallback(
    async (key: string, patch: IssuePatch) => {
      if (!activeTab) return;
      const connectionId = activeTab.connectionId;
      const tabId = activeTab.id;
      const session = editSession.current;
      const field: EditField =
        patch.assigneeId !== undefined
          ? 'assignee'
          : patch.priorityId !== undefined
            ? 'priority'
            : patch.transitionId !== undefined
              ? 'status'
              : 'summary';
      if (
        patch.assigneeId &&
        !(await pickers.validate(connectionId, key, patch.assigneeId))
      )
        return;
      setEditor((current) =>
        current?.connectionId === connectionId && current.key === key
          ? null
          : current,
      );
      const success = await mutations.update(
        connectionId,
        key,
        patch,
        pickers.values[`${connectionId}:${key}`],
      );
      if (success && field === 'status') pickers.invalidate(connectionId, key);
      if (!success && field !== 'summary') {
        pickers.rejected(connectionId, key, field);
        if (activeIdRef.current === tabId && editSession.current === session)
          setEditor((current) => current ?? { connectionId, key, field });
      }
    },
    [activeTab, mutations, pickers],
  );

  const rankBefore = useCallback(
    async (key: string, beforeKey: string) => {
      if (
        !activeTab ||
        !snapshot ||
        key === beforeKey ||
        !canRank(snapshot, view.sort, key)
      )
        return;
      await mutations.rank(activeTab.connectionId, key, beforeKey);
    },
    [activeTab, mutations, snapshot, view.sort],
  );

  useEffect(() => {
    const undo = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        dialog ||
        event.shiftKey ||
        event.altKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== 'z'
      )
        return;
      if (
        (event.target as HTMLElement).closest(
          'input,textarea,select,[contenteditable="true"]',
        )
      )
        return;
      if (!undoState.label) return;
      event.preventDefault();
      void mutations.undo();
    };
    window.addEventListener('keydown', undo);
    return () => window.removeEventListener('keydown', undo);
  }, [mutations, undoState.label, dialog]);

  const keyboardRank = useCallback(
    (node: IssueNode, direction: -1 | 1) => {
      if (!snapshot || !canRank(snapshot, view.sort, node.issue.key)) return;
      const siblings = snapshot.issues.filter(
        (issue) => issue.parentKey === node.issue.parentKey,
      );
      const index = siblings.findIndex((issue) => issue.key === node.issue.key);
      if (direction < 0 && index > 0)
        void rankBefore(node.issue.key, siblings[index - 1].key);
      if (direction > 0 && index >= 0 && index < siblings.length - 1)
        void rankBefore(siblings[index + 1].key, node.issue.key);
    },
    [snapshot, rankBefore, view.sort],
  );

  const tree = useMemo(
    () => (snapshot ? buildIssueTree(snapshot.issues, snapshot.rootKey) : null),
    [snapshot],
  );
  const retainedKeys = new Set(
    [...saving]
      .filter(
        (key) => activeTab && key.startsWith(`${activeTab.connectionId}:`),
      )
      .map((key) => key.slice(activeTab!.connectionId.length + 1)),
  );
  if (editor?.connectionId === activeTab?.connectionId && editor)
    retainedKeys.add(editor.key);
  const retainedPaths = new Set(
    [...retainedKeys].flatMap((key) =>
      ancestorPath(tree, key).map((node) => node.issue.key),
    ),
  );
  const focusedTree = findNode(tree, activeTab?.focusKey) ?? tree;
  const filteredTree = filterTree(
    focusedTree,
    query,
    activeTab?.filters ?? {},
    activeTab?.hideDone ?? false,
    activeTab ? currentUsers[activeTab.connectionId]?.id : undefined,
    reveal?.tabId === activeTab?.id ? reveal?.key : undefined,
    retainedKeys,
  );
  const sortedTree = filteredTree
    ? sortIssueTree(filteredTree, view.sort, priorityOrder)
    : null;
  const shownTree =
    view.sort.column === 'rank'
      ? sortedTree
      : retainEditingOrder(
          sortedTree,
          activeTab ? displayedTrees.current.get(activeTab.id) : null,
          retainedPaths,
        );
  useEffect(() => {
    if (activeTab) displayedTrees.current.set(activeTab.id, shownTree);
  });
  const expandedSet = new Set(
    filtering ? expansionKeys(shownTree) : (activeTab?.expanded ?? []),
  );
  const linkedSet = new Set(activeTab?.linkedExpanded ?? []);
  const counts = useMemo(() => {
    const result = new Map<string, ReturnType<typeof childCounts>>();
    const visit = (node: IssueNode): number => {
      const descendants = node.children.reduce(
        (sum, child) => sum + 1 + visit(child),
        0,
      );
      result.set(node.issue.key, {
        open: node.children.filter(
          (child) => child.issue.status.category !== 'done',
        ).length,
        total: node.children.length,
        descendants,
      });
      return descendants;
    };
    if (tree) visit(tree);
    return result;
  }, [tree]);
  const breadcrumb = ancestorPath(
    tree,
    activeTab?.selectedKey ?? activeTab?.focusKey,
  );
  useEffect(() => {
    if (
      !reveal ||
      reveal.tabId !== activeTab?.id ||
      reveal.key !== activeTab?.selectedKey ||
      editor
    )
      return;
    document
      .querySelector<HTMLElement>(
        `[data-tree-key="${reveal.key}"] > .issue-row`,
      )
      ?.scrollIntoView({ block: 'center' });
  }, [reveal, activeTab?.id, activeTab?.selectedKey, snapshot, editor]);
  useEffect(() => {
    // Only an explicit reveal request moves keyboard focus. Refresh preserves it.
    if (!reveal || reveal.tabId !== activeTab?.id || editor) return;
    document
      .querySelector<HTMLElement>(`[data-tree-key="${reveal.key}"]`)
      ?.focus({ preventScroll: true });
  }, [reveal, activeTab?.id]);
  const flat = useMemo(
    () => flattenVisible(shownTree, expandedSet),
    [shownTree, expandedSet],
  );

  const advanceEdit = (key: string, field: EditField, direction: -1 | 1) => {
    const target = nextEditableCell(flat, view.columns, key, field, direction);
    if (!target) {
      setEditor(null);
      return;
    }
    beginEdit(target.key, target.field);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          `[data-tree-key="${target.key}"] > .issue-row`,
        )
        ?.scrollIntoView({ block: 'nearest' }),
    );
  };

  const focusTreeNeighbor = (key: string, direction: -1 | 1) => {
    const index = flat.findIndex((node) => node.issue.key === key);
    const target = flat[index + direction];
    if (target)
      document
        .querySelector<HTMLElement>(`[data-tree-key="${target.issue.key}"]`)
        ?.focus();
  };

  if (!ready)
    return (
      <div className="boot">
        <Loader2 className="spin" />
        <span>Opening Canopy…</span>
      </div>
    );

  return (
    <div
      style={
        {
          '--sidebar-width': `${workspace.sidebarWidth ?? 220}px`,
        } as React.CSSProperties
      }
      className={cx(
        'app',
        workspace.sidebarCollapsed && 'sidebar-is-collapsed',
      )}
    >
      <aside className="sidebar" aria-label="Canopy sidebar">
        <div className="brand">
          <div className="brand-mark">
            <span />
          </div>
          <span>Canopy</span>
        </div>
        <button
          className="icon-button sidebar-toggle"
          aria-label={
            workspace.sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'
          }
          onClick={() =>
            setWorkspace((value) => ({
              ...value,
              sidebarCollapsed: !value.sidebarCollapsed,
            }))
          }
        >
          <Menu size={17} />
        </button>
        <div className="sidebar-body">
          {(workspace.pinnedRoots?.length ?? 0) > 0 && (
            <>
              <div className="side-heading">
                <span>PINNED ROOTS</span>
              </div>
              <nav className="side-tabs" aria-label="Pinned roots">
                {workspace.pinnedRoots!.map((root) => (
                  <div
                    className="pinned-root"
                    key={`${root.connectionId}:${root.rootKey}`}
                  >
                    <button
                      className={cx(
                        'side-tab',
                        activeTab && sameRoot(root, activeTab) && 'active',
                      )}
                      title={`${root.rootKey}: ${root.summary ?? ''} · ${connections.find((item) => item.id === root.connectionId)?.name ?? 'Unavailable site'}`}
                      onClick={() => openTab(root.connectionId, root.rootKey)}
                    >
                      <Pin size={14} />
                      <span>
                        <b>{root.rootKey}</b>
                        <small>{root.summary ?? root.rootKey}</small>
                      </span>
                    </button>
                    <button
                      className="icon-button unpin-root"
                      aria-label={`Unpin ${root.rootKey}`}
                      onClick={() =>
                        setWorkspace((current) => togglePinned(current, root))
                      }
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </nav>
            </>
          )}

          <div className="side-heading">
            <span>OPEN TREES</span>
            <button
              className="icon-button"
              onClick={() => setDialog('open')}
              aria-label="Open issue"
            >
              <Plus size={15} />
            </button>
          </div>
          <nav className="side-tabs">
            {workspace.tabs.map((tab) => (
              <button
                key={tab.id}
                title={`${tab.rootKey}: ${tab.summary ?? ''} · ${connections.find((item) => item.id === tab.connectionId)?.name ?? 'Unavailable site'}`}
                className={cx('side-tab', tab.id === activeTab?.id && 'active')}
                onClick={() => selectTab(tab.id)}
              >
                <ChevronRight size={14} />
                <span>
                  <b>{tab.rootKey}</b>
                  <small>
                    {tab.summary ??
                      connections.find((item) => item.id === tab.connectionId)
                        ?.name ??
                      'Unknown site'}
                  </small>
                </span>
              </button>
            ))}
            {workspace.tabs.length === 0 && (
              <p className="sidebar-empty">
                Open an issue to start exploring its tree.
              </p>
            )}
          </nav>
          <Connections
            connections={connections}
            setConnections={(nextConnections) => {
              setConnections(nextConnections);
              const removed = connections.filter(
                (item) => !nextConnections.some((next) => next.id === item.id),
              );
              forgetTabs(
                workspace.tabs
                  .filter((tab) =>
                    removed.some((item) => item.id === tab.connectionId),
                  )
                  .map((tab) => tab.id),
              );
              setWorkspace((current) =>
                removed.reduce(
                  (value, item) => removeConnection(value, item.id),
                  current,
                ),
              );
              setHistory((current) => ({
                back: current.back.filter(
                  (tab) =>
                    !removed.some((item) => item.id === tab.connectionId),
                ),
                forward: current.forward.filter(
                  (tab) =>
                    !removed.some((item) => item.id === tab.connectionId),
                ),
              }));
            }}
            onConnect={() => setDialog('connect')}
            onError={(message) =>
              setErrors((value) => ({ ...value, app: message }))
            }
          />
        </div>
        <button
          className="sidebar-settings"
          onClick={() => setDialog('shortcuts')}
        >
          <Settings2 size={16} />
          <span>Keyboard shortcuts</span>
        </button>
        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="Sidebar width"
          aria-orientation="vertical"
          tabIndex={0}
          aria-valuemin={180}
          aria-valuemax={400}
          aria-valuenow={workspace.sidebarWidth ?? 220}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
              return;
            event.preventDefault();
            setWorkspace((current) => ({
              ...current,
              sidebarWidth:
                event.key === 'Home'
                  ? 180
                  : event.key === 'End'
                    ? 400
                    : Math.max(
                        180,
                        Math.min(
                          400,
                          (current.sidebarWidth ?? 220) +
                            (event.key === 'ArrowLeft' ? -10 : 10),
                        ),
                      ),
            }));
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const width = Math.max(180, Math.min(400, event.clientX));
            setWorkspace((current) => ({ ...current, sidebarWidth: width }));
          }}
          onPointerUp={(event) =>
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        />
      </aside>

      <main className="main">
        <div className="tabstrip" role="tablist" aria-label="Open issue trees">
          <button
            className="icon-button sidebar-reveal"
            aria-label="Show sidebar"
            onClick={() =>
              setWorkspace((value) => ({ ...value, sidebarCollapsed: false }))
            }
          >
            <Menu size={17} />
          </button>
          {workspace.tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              data-tab-id={tab.id}
              title={`${tab.rootKey}: ${tab.summary ?? ''} · ${connections.find((item) => item.id === tab.connectionId)?.name ?? 'Unavailable site'}`}
              draggable
              onDragStart={(event) => {
                draggedTab.current = tab.id;
                event.dataTransfer.setData('application/x-canopy-tab', tab.id);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                draggedTab.current = null;
              }}
              onDragOver={(event) => {
                if (draggedTab.current) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                const source = draggedTab.current;
                if (source)
                  setWorkspace((current) =>
                    reorderTab(current, source, tab.id),
                  );
                draggedTab.current = null;
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  closeTab(tab.id);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setTabMenu({
                  id: tab.id,
                  x: Math.min(event.clientX, window.innerWidth - 220),
                  y: Math.min(event.clientY, window.innerHeight - 245),
                });
              }}
              aria-selected={tab.id === activeTab?.id}
              tabIndex={tab.id === activeTab?.id ? 0 : -1}
              className={cx('top-tab', tab.id === activeTab?.id && 'active')}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (
                  event.key === 'ContextMenu' ||
                  (event.shiftKey && event.key === 'F10')
                ) {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setTabMenu({
                    id: tab.id,
                    x: Math.min(rect.left, window.innerWidth - 220),
                    y: rect.bottom,
                  });
                  return;
                }
                if (
                  event.altKey &&
                  event.shiftKey &&
                  ['ArrowLeft', 'ArrowRight'].includes(event.key)
                ) {
                  event.preventDefault();
                  const index = workspace.tabs.findIndex(
                    (item) => item.id === tab.id,
                  );
                  const target =
                    workspace.tabs[
                      index + (event.key === 'ArrowLeft' ? -1 : 1)
                    ];
                  if (target)
                    setWorkspace((current) =>
                      reorderTab(current, tab.id, target.id),
                    );
                  return;
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  selectTab(tab.id);
                }
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  const direction = event.key === 'ArrowLeft' ? -1 : 1;
                  selectRelativeTab(direction);
                  const tabs = [
                    ...event.currentTarget.parentElement!.querySelectorAll<HTMLElement>(
                      '[role="tab"]',
                    ),
                  ];
                  const index = tabs.indexOf(event.currentTarget);
                  tabs[
                    (index + direction + tabs.length) % tabs.length
                  ]?.focus();
                }
              }}
            >
              <CircleDot size={14} />
              <span className="tab-label">
                <b>{tab.rootKey}</b>
                <small>{tab.summary ?? 'Loading…'}</small>
              </span>
              {refreshing.has(tab.id) && <Loader2 className="spin" size={12} />}
              <button
                aria-label={`Close ${tab.rootKey}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <button
            className="new-tab"
            aria-label="Open issue"
            onClick={() => setDialog('open')}
          >
            <Plus size={16} />
          </button>
          <div className="window-drag" />
        </div>

        {activeTab && (
          <>
            <header className="toolbar">
              <button
                className="icon-button"
                aria-label="Back"
                title="Back (Alt+←)"
                disabled={!history.back.length}
                onClick={() => navigateHistory('back')}
              >
                <ArrowLeft size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="Forward"
                title="Forward (Alt+→)"
                disabled={!history.forward.length}
                onClick={() => navigateHistory('forward')}
              >
                <ArrowRight size={16} />
              </button>
              <div className="crumb">
                <span>
                  {
                    connections.find(
                      (item) => item.id === activeTab.connectionId,
                    )?.name
                  }
                </span>
                <ChevronRight size={14} />
                <strong>{activeTab.rootKey}</strong>
              </div>
              <div className="toolbar-actions">
                <ViewSettings
                  view={view}
                  update={updateView}
                  useDefault={() =>
                    setWorkspace((current) =>
                      defaultRootView(current, activeTab),
                    )
                  }
                  reset={() => {
                    setEditor(null);
                    setDragKey(null);
                    setWorkspace((current) =>
                      resetRootView(current, activeTab),
                    );
                  }}
                />
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={activeTab.hideDone}
                    onChange={(event) =>
                      updateTab(activeTab.id, {
                        hideDone: event.target.checked,
                      })
                    }
                  />
                  <span>Hide done</span>
                </label>
                <span className="separator" />
                <button
                  className="tool-button"
                  disabled={filtering}
                  onClick={(event) =>
                    expandAll(false, event.altKey || event.detail > 1)
                  }
                  onDoubleClick={() => expandAll(false, true)}
                  title="Collapse all; double-click or Alt-click to include linked issues"
                >
                  <ChevronsDownUp size={15} />
                  <span>Collapse</span>
                </button>
                <button
                  className="tool-button"
                  disabled={filtering}
                  onClick={(event) =>
                    expandAll(true, event.altKey || event.detail > 1)
                  }
                  onDoubleClick={() => expandAll(true, true)}
                  title="Expand all; double-click or Alt-click to include linked issues"
                >
                  <ChevronsUpDown size={15} />
                  <span>Expand</span>
                </button>
                <button
                  className="icon-button"
                  disabled={refreshing.has(activeTab.id)}
                  onClick={() => void refreshTab(activeTab, true, true)}
                  title="Refresh"
                >
                  <RefreshCw
                    className={cx(refreshing.has(activeTab.id) && 'spin')}
                    size={16}
                  />
                </button>
                <button
                  className="icon-button"
                  onClick={() => setDialog('commands')}
                  title="More commands"
                >
                  <MoreHorizontal size={17} />
                </button>
              </div>
            </header>
            <div className="tree-navigation">
              <label className="tree-search">
                <Search size={14} />
                <input
                  ref={searchRef}
                  aria-label="Find in tree"
                  placeholder="Find key or title…"
                  value={query}
                  onChange={(event) =>
                    setQueries((current) => ({
                      ...current,
                      [activeTab.id]: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      setQueries((current) => ({
                        ...current,
                        [activeTab.id]: '',
                      }));
                      event.currentTarget.blur();
                    }
                  }}
                />
                {query && (
                  <button
                    aria-label="Clear tree search"
                    onClick={() =>
                      setQueries((current) => ({
                        ...current,
                        [activeTab.id]: '',
                      }))
                    }
                  >
                    <X size={12} />
                  </button>
                )}
              </label>
              <select
                aria-label="Filter assignee"
                value={activeTab.filters?.assignee ?? ''}
                title={identityErrors[activeTab.connectionId]}
                onChange={(event) =>
                  updateTab(activeTab.id, {
                    filters: {
                      ...activeTab.filters,
                      assignee:
                        (event.target.value as 'me' | 'unassigned') ||
                        undefined,
                    },
                  })
                }
              >
                <option value="">All assignees</option>
                <option
                  value="me"
                  disabled={!currentUsers[activeTab.connectionId]}
                >
                  Assigned to me
                </option>
                <option value="unassigned">Unassigned</option>
              </select>
              <select
                aria-label="Filter status"
                value={activeTab.filters?.status ?? ''}
                onChange={(event) =>
                  updateTab(activeTab.id, {
                    filters: {
                      ...activeTab.filters,
                      status: event.target.value || undefined,
                    },
                  })
                }
              >
                <option value="">All statuses</option>
                {activeTab.filters?.status &&
                  !snapshot?.issues.some(
                    (issue) => issue.status.id === activeTab.filters?.status,
                  ) && (
                    <option value={activeTab.filters.status}>
                      Status {activeTab.filters.status} (not in this tree)
                    </option>
                  )}
                {[
                  ...new Map(
                    snapshot?.issues.map((issue) => [
                      issue.status.id,
                      issue.status,
                    ]),
                  ).values(),
                ].map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter priority"
                value={activeTab.filters?.priority ?? ''}
                onChange={(event) =>
                  updateTab(activeTab.id, {
                    filters: {
                      ...activeTab.filters,
                      priority: event.target.value || undefined,
                    },
                  })
                }
              >
                <option value="">All priorities</option>
                <option value="__none__">No priority</option>
                {activeTab.filters?.priority &&
                  activeTab.filters.priority !== '__none__' &&
                  !snapshot?.issues.some(
                    (issue) =>
                      issue.priority?.id === activeTab.filters?.priority,
                  ) && (
                    <option value={activeTab.filters.priority}>
                      Priority {activeTab.filters.priority} (not in this tree)
                    </option>
                  )}
                {[
                  ...new Map(
                    snapshot?.issues
                      .filter((issue) => issue.priority)
                      .map((issue) => [issue.priority!.id, issue.priority!]),
                  ).values(),
                ].map((priority) => (
                  <option key={priority.id} value={priority.id}>
                    {priority.name}
                  </option>
                ))}
              </select>
              <details className="tree-view-menu">
                <summary>Tree actions</summary>
                <div>
                  <button disabled={filtering} onClick={() => expandDepth(1)}>
                    Expand immediate children
                  </button>
                  <button disabled={filtering} onClick={() => expandDepth(2)}>
                    Expand two levels
                  </button>
                  <button disabled={filtering} onClick={() => expandAll(true)}>
                    Expand all descendants
                  </button>
                  <button
                    disabled={filtering}
                    onClick={() => expandAll(true, true)}
                  >
                    Expand hierarchy and linked issues
                  </button>
                  <button
                    disabled={filtering}
                    onClick={() => expandAll(false, true)}
                  >
                    Collapse hierarchy and linked issues
                  </button>
                  <button
                    disabled={filtering || !activeTab.selectedKey}
                    onClick={() => expandDepth(Infinity, true)}
                  >
                    Expand selected branch
                  </button>
                  <button
                    disabled={filtering || !activeTab.selectedKey}
                    onClick={() => expandDepth(0, true)}
                  >
                    Collapse selected branch
                  </button>
                  <button
                    disabled={!activeTab.selectedKey}
                    onClick={() =>
                      updateTab(activeTab.id, {
                        focusKey: activeTab.selectedKey,
                      })
                    }
                  >
                    Focus selected subtree
                  </button>
                  <button
                    disabled={!activeTab.selectedKey}
                    onClick={revealSelection}
                  >
                    Reveal selection
                  </button>
                  <button
                    onClick={() => {
                      updateTab(activeTab.id, {
                        focusKey: undefined,
                        selectedKey: activeTab.rootKey,
                      });
                      scrollRef.current?.scrollTo({ top: 0 });
                    }}
                  >
                    Back to root
                  </button>
                </div>
              </details>
            </div>
            {identityErrors[activeTab.connectionId] && (
              <div className="identity-hint" role="status">
                {identityErrors[activeTab.connectionId]}{' '}
                <button onClick={() => setIdentityRetry((value) => value + 1)}>
                  Retry account lookup
                </button>
              </div>
            )}
            {filtering && (
              <div className="identity-hint">
                Matching paths are expanded automatically. Clear search and
                filters to restore your expansion.
              </div>
            )}
            {
              <nav className="tree-breadcrumb" aria-label="Issue ancestry">
                <button
                  onClick={() => {
                    updateTab(activeTab.id, { focusKey: undefined });
                    scrollRef.current?.scrollTo({ top: 0 });
                  }}
                >
                  {activeTab.rootKey}
                </button>
                {breadcrumb.slice(1).map((node) => (
                  <React.Fragment key={node.issue.key}>
                    <ChevronRight size={12} />
                    <button
                      title={node.issue.summary}
                      aria-current={
                        node.issue.key === activeTab.focusKey
                          ? 'location'
                          : undefined
                      }
                      onClick={() =>
                        updateTab(activeTab.id, {
                          focusKey: node.issue.key,
                          selectedKey: node.issue.key,
                        })
                      }
                    >
                      {node.issue.key}
                    </button>
                  </React.Fragment>
                ))}
                {activeTab.focusKey && <span>Focused subtree</span>}
              </nav>
            }
            {(errors[activeTab.id] ||
              errors.edit ||
              errors.workspace ||
              errors.app) && (
              <div className="error-banner" role="alert">
                <AlertCircle size={15} />
                <span>
                  {errors.edit ??
                    errors[activeTab.id] ??
                    errors.workspace ??
                    errors.app}
                </span>
                {errors[activeTab.id] && (
                  <button
                    onClick={() => void refreshTab(activeTab, true, true)}
                    disabled={
                      !online ||
                      refreshing.has(activeTab.id) ||
                      loading.has(activeTab.id)
                    }
                  >
                    Retry
                  </button>
                )}
                <button
                  onClick={() =>
                    setErrors((value) => {
                      const copy = { ...value };
                      delete copy.edit;
                      delete copy[activeTab.id];
                      delete copy.workspace;
                      delete copy.app;
                      return copy;
                    })
                  }
                >
                  <X size={14} />
                </button>
              </div>
            )}
            {undoState.label && (
              <div className="undo-banner" role="status">
                <span>Change saved</span>
                <button
                  disabled={undoState.busy}
                  onClick={() => void mutations.undo()}
                >
                  {undoState.label}
                </button>
                <small>⌘Z / Ctrl+Z</small>
              </div>
            )}
            {snapshot?.warnings.map((warning) => (
              <div className="warning-banner" key={warning}>
                <AlertCircle size={14} />
                {warning}
              </div>
            ))}
            {snapshot && (
              <div className="ranking-note" role="status">
                {view.sort.column !== 'rank'
                  ? 'Ranking is disabled while a column sort is active. Select Jira rank in View to reorder.'
                  : snapshot.ranking?.state !== 'supported'
                    ? (snapshot.ranking?.reason ??
                      'Ranking availability has not been verified. Refresh to try again.')
                    : null}
                {view.sort.column === 'priority' && !priorityOrder && (
                  <span>
                    {priorityError
                      ? ` Priority order could not be loaded: ${priorityError}`
                      : ' Loading Jira priority order…'}
                    {' Showing Jira rank until priority order is available.'}
                    {priorityError && (
                      <button
                        onClick={() =>
                          setPriorityErrors((current) => {
                            const next = { ...current };
                            delete next[priorityCacheKey];
                            return next;
                          })
                        }
                      >
                        Retry priority sort
                      </button>
                    )}
                  </span>
                )}
              </div>
            )}
            <div className="tree-with-preview">
              <div className="tree-content">
                <div
                  className="tree-scroll"
                  style={tableStyle(view) as React.CSSProperties}
                  ref={scrollRef}
                  onScroll={(event) => {
                    // Placeholder/layout scrolling must not replace a saved position
                    // before the restored tree has been rendered and positioned.
                    if (
                      !snapshot ||
                      pendingScrollRestore.current === activeTab.id
                    )
                      return;
                    updateTab(activeTab.id, {
                      scrollTop: event.currentTarget.scrollTop,
                    });
                  }}
                >
                  <TableHeader view={view} update={updateView} />
                  {loading.has(activeTab.id) && !snapshot ? (
                    <TreeSkeleton />
                  ) : errors[activeTab.id] && !snapshot ? (
                    <EmptyState
                      icon={AlertCircle}
                      title="This tree couldn’t be loaded"
                      detail={errors[activeTab.id]}
                      action="Try again"
                      onAction={() => void refreshTab(activeTab)}
                    />
                  ) : shownTree ? (
                    <div
                      role="tree"
                      aria-label={`${activeTab.rootKey} issue tree`}
                      className="issue-tree"
                    >
                      <TreeRows
                        node={shownTree}
                        currentUser={currentUsers[activeTab.connectionId]}
                        columns={view.columns}
                        rankableKeys={
                          new Set(
                            snapshot?.ranking?.state === 'supported'
                              ? snapshot.ranking.issueKeys
                              : [],
                          )
                        }
                        rankingEnabled={view.sort.column === 'rank'}
                        statusColors={statusColors}
                        depth={0}
                        expanded={expandedSet}
                        expansionLocked={filtering}
                        linkedExpanded={linkedSet}
                        onToggleLinks={(key) =>
                          updateTab(activeTab.id, {
                            linkedExpanded: linkedSet.has(key)
                              ? [...linkedSet].filter((item) => item !== key)
                              : [...linkedSet, key],
                          })
                        }
                        counts={counts}
                        revealedKey={
                          reveal?.tabId === activeTab.id
                            ? reveal.key
                            : undefined
                        }
                        onToggle={(key) =>
                          updateTab(activeTab.id, {
                            expanded: expandedSet.has(key)
                              ? activeTab.expanded.filter(
                                  (item) => item !== key,
                                )
                              : [...activeTab.expanded, key],
                          })
                        }
                        selectedKey={activeTab.selectedKey}
                        onSelect={(key) =>
                          updateTab(activeTab.id, { selectedKey: key })
                        }
                        onOpenTab={(key) =>
                          openTab(activeTab.connectionId, key)
                        }
                        onOpenExternal={(key) =>
                          void openExternal(activeTab.connectionId, key)
                        }
                        onCopyLink={(key) =>
                          void copyIssueLink(activeTab.connectionId, key)
                        }
                        onPreview={(key) =>
                          setPreviewKey((current) =>
                            current === key ? null : key,
                          )
                        }
                        menuKey={rowMenu?.issue.key}
                        onContextMenu={(issue, x, y, toggle) => {
                          updateTab(activeTab.id, { selectedKey: issue.key });
                          setRowMenu((current) =>
                            toggle && current?.issue.key === issue.key
                              ? null
                              : { issue, x, y },
                          );
                        }}
                        editor={editor}
                        beginEdit={beginEdit}
                        cancelEdit={() => setEditor(null)}
                        options={scopedOptions}
                        loadOptions={loadOptions}
                        changeAssigneeQuery={(key, query) => {
                          if (activeTab)
                            pickers.changeQuery(
                              activeTab.connectionId,
                              key,
                              query,
                            );
                        }}
                        updateIssue={updateIssue}
                        advanceEdit={advanceEdit}
                        saving={
                          new Set(
                            [...saving]
                              .filter((key) =>
                                key.startsWith(`${activeTab.connectionId}:`),
                              )
                              .map((key) =>
                                key.slice(activeTab.connectionId.length + 1),
                              ),
                          )
                        }
                        dragKey={dragKey}
                        setDragKey={setDragKey}
                        rankBefore={rankBefore}
                        keyboardRank={keyboardRank}
                        focusNeighbor={focusTreeNeighbor}
                      />
                    </div>
                  ) : tree && filtering ? (
                    <EmptyState
                      icon={Search}
                      title="No matching issues"
                      detail="Try another search or clear the filters."
                      action="Clear search and filters"
                      onAction={() => {
                        setQueries((current) => ({
                          ...current,
                          [activeTab.id]: '',
                        }));
                        updateTab(activeTab.id, { filters: {} });
                      }}
                    />
                  ) : tree && activeTab.hideDone ? (
                    <EmptyState
                      icon={Check}
                      title="All issues are done"
                      detail="Completed issues in this tree are currently hidden."
                      action="Show done issues"
                      onAction={() =>
                        updateTab(activeTab.id, { hideDone: false })
                      }
                    />
                  ) : (
                    <EmptyState
                      icon={Search}
                      title="No issue tree yet"
                      detail="Open an issue key or Jira URL to see its full hierarchy."
                      action="Open issue"
                      onAction={() => setDialog('open')}
                    />
                  )}
                </div>
                <footer className="statusbar">
                  {snapshot ? (
                    <>
                      <span>
                        {snapshot.issues.length} issue
                        {snapshot.issues.length === 1 ? '' : 's'}
                      </span>
                      <span
                        title={new Date(snapshot.fetchedAt).toLocaleString()}
                      >
                        Last updated{' '}
                        {new Date(snapshot.fetchedAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </>
                  ) : (
                    <span>Not updated yet</span>
                  )}
                  {(refreshing.has(activeTab.id) ||
                    loading.has(activeTab.id)) && (
                    <span>
                      <Loader2 className="spin" size={12} /> Checking for
                      changes
                    </span>
                  )}
                  <span className="status-spacer" />
                  <span role="status" aria-label="Connection status">
                    {!online
                      ? 'Offline'
                      : connectionErrors.has(activeTab.id)
                        ? 'Connection error'
                        : snapshot
                          ? 'Connected'
                          : 'Connecting'}
                  </span>
                  <span>
                    {foreground ? 'Auto-refresh 30s' : 'Background refresh'}
                  </span>
                </footer>
              </div>
              {previewKey && (
                <IssuePreview
                  connectionId={activeTab.connectionId}
                  issueKey={previewKey}
                  width={
                    Number.isFinite(workspace.previewWidth)
                      ? Math.max(300, Math.min(720, workspace.previewWidth!))
                      : 420
                  }
                  onWidth={(previewWidth) =>
                    setWorkspace((current) => ({ ...current, previewWidth }))
                  }
                  onClose={closePreview}
                  onPreview={setPreviewKey}
                  onOpenTab={(key) => openTab(activeTab.connectionId, key)}
                  onOpenExternal={(key) =>
                    void openExternal(activeTab.connectionId, key)
                  }
                />
              )}
            </div>
          </>
        )}
        {!activeTab &&
          (history.back.length > 0 || history.forward.length > 0) && (
            <header className="toolbar">
              <button
                className="icon-button"
                aria-label="Back"
                title="Back (Alt+←)"
                disabled={!history.back.length}
                onClick={() => navigateHistory('back')}
              >
                <ArrowLeft size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="Forward"
                title="Forward (Alt+→)"
                disabled={!history.forward.length}
                onClick={() => navigateHistory('forward')}
              >
                <ArrowRight size={16} />
              </button>
            </header>
          )}
        {!activeTab && (
          <Welcome
            onOpen={() => setDialog('open')}
            onConnect={() => setDialog('connect')}
            hasConnections={connections.length > 0}
            error={errors.app ?? errors.workspace}
          />
        )}
      </main>

      {tabMenu &&
        (() => {
          const tab = workspace.tabs.find((item) => item.id === tabMenu.id);
          if (!tab) return null;
          const pinned = workspace.pinnedRoots?.some((root) =>
            sameRoot(root, tab),
          );
          const action = (run: () => void) => {
            run();
            setTabMenu(null);
          };
          return (
            <div
              className="tab-context-menu"
              role="menu"
              aria-label={`Actions for ${tab.rootKey}`}
              style={{ left: tabMenu.x, top: tabMenu.y }}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (
                  !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
                )
                  return;
                event.preventDefault();
                const items = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    'button',
                  ),
                ];
                const index = items.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                items[
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (index +
                          (event.key === 'ArrowDown' ? 1 : -1) +
                          items.length) %
                        items.length
                ]?.focus();
              }}
            >
              <button
                autoFocus
                role="menuitem"
                onClick={() =>
                  closeTabIds(
                    workspace.tabs
                      .filter((item) => item.id !== tab.id)
                      .map((item) => item.id),
                  )
                }
              >
                Close others
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  closeTabIds(
                    workspace.tabs
                      .slice(
                        workspace.tabs.findIndex((item) => item.id === tab.id) +
                          1,
                      )
                      .map((item) => item.id),
                  )
                }
              >
                Close to the right
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  action(() =>
                    setWorkspace((current) => togglePinned(current, tab)),
                  )
                }
              >
                {pinned ? 'Unpin root' : 'Pin root'}
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  action(
                    () => void copyIssueLink(tab.connectionId, tab.rootKey),
                  )
                }
              >
                Copy root link
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  action(() => void openExternal(tab.connectionId, tab.rootKey))
                }
              >
                Open in Jira
              </button>
            </div>
          );
        })()}
      {rowMenu && activeTab && (
        <RowMenu
          issue={rowMenu.issue}
          position={rowMenu}
          onClose={closeRowMenu}
          onAction={(action) => {
            if (action === 'link')
              void copyIssueLink(activeTab.connectionId, rowMenu.issue.key);
            else if (action === 'open')
              void openExternal(activeTab.connectionId, rowMenu.issue.key);
            else
              void window.canopy
                .copyText(
                  action === 'key' ? rowMenu.issue.key : rowMenu.issue.summary,
                )
                .catch((error: unknown) =>
                  setErrors((current) => ({
                    ...current,
                    app: `Couldn’t copy ${action}: ${error instanceof Error ? error.message : String(error)}`,
                  })),
                );
          }}
        />
      )}
      {dialog === 'open' && (
        <OpenIssueDialog
          connections={connections}
          recentRoots={workspace.recentRoots ?? []}
          activeRoot={activeTab ?? undefined}
          onClose={() => setDialog(null)}
          onOpen={openTab}
        />
      )}
      {dialog === 'connect' && (
        <ConnectDialog
          onClose={() => setDialog(null)}
          onConnected={(value) => {
            setConnections(value);
            setErrors((current) => {
              const copy = { ...current };
              delete copy.app;
              return copy;
            });
            setDialog(null);
          }}
        />
      )}
      {dialog === 'commands' && (
        <CommandDialog
          commands={commands}
          shortcuts={workspace.shortcuts}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'shortcuts' && (
        <ShortcutsDialog
          shortcuts={workspace.shortcuts}
          onChange={(shortcuts) =>
            setWorkspace((value) => ({ ...value, shortcuts }))
          }
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function Connections({
  connections,
  setConnections,
  onConnect,
  onError,
}: {
  connections: Connection[];
  setConnections: (value: Connection[]) => void;
  onConnect: () => void;
  onError: (value: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const disconnect = async (id: string) => {
    setBusy(true);
    try {
      await window.canopy.disconnect(id);
      setConnections(connections.filter((item) => item.id !== id));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="connections">
      <div className="side-heading">
        <span>CONNECTIONS</span>
        <button
          className="icon-button"
          onClick={onConnect}
          disabled={busy}
          aria-label="Connect Jira site"
        >
          {busy ? <Loader2 className="spin" size={14} /> : <Plus size={15} />}
        </button>
      </div>
      {connections.map((connection) => (
        <div className="connection" key={connection.id}>
          <div className={cx('connection-dot', connection.provider)} />
          <span>
            <b>{connection.name}</b>
            <small>{connection.accountName ?? connection.url}</small>
          </span>
          <button
            className="icon-button disconnect"
            title={`Disconnect ${connection.name}`}
            onClick={() => void disconnect(connection.id)}
          >
            <LogOut size={14} />
          </button>
        </div>
      ))}
      {connections.length === 0 && (
        <button className="connect-quiet" onClick={onConnect}>
          <LogIn size={15} />
          Connect Jira
        </button>
      )}
    </section>
  );
}

type RowsProps = {
  currentUser?: Choice;
  columns: TableColumn[];
  rankableKeys: Set<string>;
  rankingEnabled: boolean;
  node: IssueNode;
  statusColors: ReadonlyMap<string, string>;
  depth: number;
  expanded: Set<string>;
  expansionLocked: boolean;
  linkedExpanded: Set<string>;
  onToggleLinks: (key: string) => void;
  counts: Map<string, ReturnType<typeof childCounts>>;
  revealedKey?: string;
  onToggle: (key: string) => void;
  selectedKey?: string;
  onSelect: (key: string) => void;
  onOpenTab: (key: string) => void;
  onOpenExternal: (key: string) => void;
  onCopyLink: (key: string) => void;
  onPreview: (key: string) => void;
  onContextMenu: (issue: Issue, x: number, y: number, toggle?: boolean) => void;
  menuKey?: string;
  editor: Editor;
  beginEdit: (key: string, field: EditField) => void;
  cancelEdit: () => void;
  changeAssigneeQuery: (key: string, query: string) => void;
  options: Record<string, PickerOptions>;
  loadOptions: (
    key: string,
    field: PickerField,
    query?: string,
    more?: boolean,
    refresh?: boolean,
  ) => Promise<void>;
  updateIssue: (key: string, patch: IssuePatch) => Promise<void>;
  advanceEdit: (key: string, field: EditField, direction: -1 | 1) => void;
  saving: Set<string>;
  dragKey: string | null;
  setDragKey: (key: string | null) => void;
  rankBefore: (key: string, beforeKey: string) => Promise<void>;
  keyboardRank: (node: IssueNode, direction: -1 | 1) => void;
  focusNeighbor: (key: string, direction: -1 | 1) => void;
};

function TreeRows(props: RowsProps) {
  const {
    node,
    depth,
    expanded,
    onToggle,
    selectedKey,
    onSelect,
    dragKey,
    setDragKey,
    rankBefore,
    keyboardRank,
    focusNeighbor,
  } = props;
  const { issue } = node;
  const open = expanded.has(issue.key);
  const hasChildren = node.children.length > 0;
  const linksOpen = props.linkedExpanded.has(issue.key);
  const count = props.counts.get(issue.key);
  const rankable = depth > 0 && props.rankableKeys.has(issue.key);
  const onTreeKey = (event: React.KeyboardEvent) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (
      (event.target as HTMLElement).closest('[data-tree-key]') !==
      event.currentTarget
    )
      return;
    if (
      (event.target as HTMLElement).closest(
        'input,button,select,[role="button"]',
      )
    )
      return;
    if (event.key === 'Escape') return;
    event.stopPropagation();
    if (
      event.key === 'ContextMenu' ||
      (event.shiftKey && event.key === 'F10')
    ) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      props.onContextMenu(issue, rect.left + 30, rect.top + 30);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusNeighbor(issue.key, 1);
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusNeighbor(issue.key, -1);
    }
    if (
      event.key === 'ArrowRight' &&
      hasChildren &&
      !open &&
      !props.expansionLocked
    ) {
      event.preventDefault();
      onToggle(issue.key);
    }
    if (event.key === 'ArrowLeft' && open && !props.expansionLocked) {
      event.preventDefault();
      onToggle(issue.key);
    }
    if (event.key === 'F2' || event.key === 'Enter') {
      event.preventDefault();
      props.beginEdit(issue.key, 'summary');
    }
    if (
      event.key === ' ' &&
      !event.shiftKey &&
      event.target === event.currentTarget
    ) {
      event.preventDefault();
      props.onPreview(issue.key);
    }
  };
  const cells: Record<TableColumn, React.ReactNode> = {
    issue: (
      <div
        className="issue-cell"
        style={{ '--depth': depth } as React.CSSProperties}
      >
        {rankable && (
          <button
            className="grab"
            draggable={props.rankingEnabled}
            disabled={!props.rankingEnabled}
            aria-label={`Reorder ${issue.key}. Use Alt plus arrow keys to move.`}
            title={
              !props.rankingEnabled
                ? 'Select Jira rank in View to reorder'
                : 'Drag to reorder; Alt+↑/↓ also works'
            }
            onDragStart={() => setDragKey(issue.key)}
            onDragEnd={() => setDragKey(null)}
            onKeyDown={(event) => {
              if (!props.rankingEnabled || !event.altKey) return;
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                keyboardRank(node, -1);
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                keyboardRank(node, 1);
              }
            }}
          >
            <GripVertical size={14} />
          </button>
        )}
        <button
          className={cx('disclosure', !hasChildren && 'placeholder')}
          aria-label={open ? `Collapse ${issue.key}` : `Expand ${issue.key}`}
          tabIndex={hasChildren ? 0 : -1}
          disabled={props.expansionLocked}
          title={
            props.expansionLocked
              ? 'Matching paths expand automatically'
              : undefined
          }
          onClick={() =>
            hasChildren && !props.expansionLocked && onToggle(issue.key)
          }
        >
          {hasChildren &&
            (open ? <ChevronDown size={15} /> : <ChevronRight size={15} />)}
        </button>
        <span
          className={cx(
            'type-icon',
            `type-${issue.type.toLowerCase().replace(/\s/g, '-')}`,
          )}
        >
          {issue.type.slice(0, 1).toUpperCase()}
        </span>
        <div className="issue-title">
          <button
            className="key"
            onClick={() => props.onOpenExternal(issue.key)}
            title="Open in Jira"
          >
            {issue.key}
          </button>
          <button
            className="copy-key"
            onClick={() => props.onCopyLink(issue.key)}
            title={`Copy link to ${issue.key}`}
            aria-label={`Copy link to ${issue.key}`}
          >
            <Copy size={11} />
          </button>
          {props.editor?.key === issue.key &&
          props.editor.field === 'summary' ? (
            <SummaryEditor
              issue={issue}
              save={props.updateIssue}
              cancel={props.cancelEdit}
            />
          ) : (
            <button
              className="summary"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  props.beginEdit(issue.key, 'summary');
                }
              }}
              onDoubleClick={() => props.beginEdit(issue.key, 'summary')}
              onClick={() => onSelect(issue.key)}
              title={`${issue.summary} — Double-click to edit`}
              aria-label={issue.summary}
            >
              {issue.summary}
            </button>
          )}
        </div>
        {!open && count && count.total > 0 && (
          <span
            className="child-count"
            title={`${count.open} open / ${count.total} total direct children; ${count.descendants} total descendants`}
          >
            {count.open}/{count.total} children
          </span>
        )}
        {issue.links.length > 0 && (
          <button
            className={cx('link-count', linksOpen && 'active')}
            onClick={() => props.onToggleLinks(issue.key)}
            aria-expanded={linksOpen}
            title={`${issue.links.length} linked issue${issue.links.length === 1 ? '' : 's'}`}
          >
            <Link2 size={12} />
            {issue.links.length}
          </button>
        )}
      </div>
    ),
    priority: (
      <FieldCell
        label={`Edit priority for ${issue.key}`}
        active={
          props.editor?.key === issue.key && props.editor.field === 'priority'
        }
        onEdit={() => props.beginEdit(issue.key, 'priority')}
      >
        <ChoiceEditor
          active={
            props.editor?.key === issue.key && props.editor.field === 'priority'
          }
          value={issue.priority}
          choices={props.options[issue.key]?.priorities}
          state={props.options[issue.key]?.priority}
          retry={() =>
            void props.loadOptions(issue.key, 'priority', '', false, true)
          }
          className={`priority ${priorityTone(issue.priority?.name)}`}
          empty="No priority"
          onSave={(id) => void props.updateIssue(issue.key, { priorityId: id })}
          onCancel={props.cancelEdit}
        />
      </FieldCell>
    ),
    assignee: (
      <FieldCell
        label={`Edit assignee for ${issue.key}`}
        active={
          props.editor?.key === issue.key && props.editor.field === 'assignee'
        }
        onEdit={() => props.beginEdit(issue.key, 'assignee')}
      >
        <AssigneeEditor
          currentUser={props.currentUser}
          active={
            props.editor?.key === issue.key && props.editor.field === 'assignee'
          }
          issue={issue}
          choices={props.options[issue.key]?.assignees}
          resultQuery={props.options[issue.key]?.assigneeResultQuery}
          state={props.options[issue.key]?.assignee}
          hasMore={props.options[issue.key]?.nextStartAt !== undefined}
          changeQuery={(query) => props.changeAssigneeQuery(issue.key, query)}
          search={(query, more, refresh) =>
            props.loadOptions(issue.key, 'assignee', query, more, refresh)
          }
          save={(id) => void props.updateIssue(issue.key, { assigneeId: id })}
          cancel={props.cancelEdit}
        />
      </FieldCell>
    ),
    status: (
      <FieldCell
        label={`Edit status for ${issue.key}`}
        active={
          props.editor?.key === issue.key && props.editor.field === 'status'
        }
        onEdit={() => props.beginEdit(issue.key, 'status')}
      >
        <StatusEditor
          color={props.statusColors.get(issue.status.id)}
          active={
            props.editor?.key === issue.key && props.editor.field === 'status'
          }
          issue={issue}
          choices={props.options[issue.key]?.transitions}
          state={props.options[issue.key]?.status}
          retry={() =>
            void props.loadOptions(issue.key, 'status', '', false, true)
          }
          save={(id) => void props.updateIssue(issue.key, { transitionId: id })}
          cancel={props.cancelEdit}
        />
      </FieldCell>
    ),
  };
  return (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? open : undefined}
      aria-label={`${issue.key}: ${issue.summary}`}
      aria-selected={selectedKey === issue.key}
      data-tree-key={issue.key}
      tabIndex={
        selectedKey === issue.key || (!selectedKey && depth === 0) ? 0 : -1
      }
      onFocus={(event) => {
        event.stopPropagation();
        onSelect(issue.key);
      }}
      onKeyDown={onTreeKey}
      onKeyDownCapture={(event) => {
        if (
          (event.target as HTMLElement).closest('[data-tree-key]') !==
            event.currentTarget ||
          props.editor?.key !== issue.key
        )
          return;
        if (event.key === 'Escape' && props.editor.field !== 'summary') {
          event.preventDefault();
          event.stopPropagation();
          props.cancelEdit();
          event.currentTarget.focus();
        }
        if (event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          const field = props.editor.field;
          (event.target as HTMLElement).blur();
          props.advanceEdit(issue.key, field, event.shiftKey ? -1 : 1);
        }
      }}
    >
      <div
        className={cx(
          'issue-row',
          selectedKey === issue.key && 'selected',
          props.revealedKey === issue.key && 'revealed',
          props.rankingEnabled &&
            dragKey &&
            dragKey !== issue.key &&
            'drop-ready',
        )}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onContextMenu(issue, event.clientX, event.clientY);
        }}
        onDragOver={(event) => {
          if (props.rankingEnabled && dragKey && dragKey !== issue.key)
            event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (props.rankingEnabled && dragKey)
            void rankBefore(dragKey, issue.key);
          setDragKey(null);
        }}
      >
        {props.columns.map((column) => (
          <React.Fragment key={column}>{cells[column]}</React.Fragment>
        ))}
        <div className="row-actions">
          <button
            className="icon-button row-menu-trigger"
            data-row-menu-trigger
            aria-expanded={props.menuKey === issue.key}
            aria-label={`Actions for ${issue.key}`}
            aria-haspopup="menu"
            title={`Actions for ${issue.key}`}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              props.onContextMenu(issue, rect.left, rect.bottom, true);
            }}
          >
            <MoreHorizontal size={14} />
          </button>
          {props.saving.has(issue.key) ? (
            <Loader2
              className="spin"
              size={14}
              aria-label={`Saving ${issue.key}`}
            />
          ) : (
            <button
              className="icon-button"
              title="Open in Jira"
              onClick={() => props.onOpenExternal(issue.key)}
            >
              <ExternalLink size={14} />
            </button>
          )}
        </div>
      </div>
      {linksOpen && (
        <LinkedIssues
          issue={issue}
          depth={depth}
          openTab={props.onOpenTab}
          openExternal={props.onOpenExternal}
        />
      )}
      {hasChildren && open && (
        <div
          role="group"
          className="tree-branch"
          style={{ '--branch-depth': depth } as React.CSSProperties}
        >
          {node.children.map((child) => (
            <TreeRows
              key={child.issue.key}
              {...props}
              node={child}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FieldCell({
  active,
  onEdit,
  label,
  children,
}: {
  active: boolean;
  onEdit: () => void;
  label: string;
  children: React.ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  const wasActive = useRef(false);
  useLayoutEffect(() => {
    if (
      active &&
      (!wasActive.current || document.activeElement === document.body) &&
      !element.current?.contains(document.activeElement)
    )
      element.current?.focus();
    wasActive.current = active;
  });
  return (
    <div
      ref={element}
      className={cx('field-cell', active && 'editing')}
      role={active ? undefined : 'button'}
      tabIndex={active ? -1 : 0}
      aria-label={active ? undefined : label}
      onClick={() => !active && onEdit()}
      onKeyDown={(event) => {
        if (
          active &&
          event.target === event.currentTarget &&
          ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
        if (!active && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onEdit();
        }
      }}
    >
      {children}
    </div>
  );
}

function SummaryEditor({
  issue,
  save,
  cancel,
}: {
  issue: Issue;
  save: (key: string, patch: IssuePatch) => Promise<void>;
  cancel: () => void;
}) {
  const [value, setValue] = useState(issue.summary);
  const committed = useRef(false);
  const submit = () => {
    if (committed.current) return;
    committed.current = true;
    const summary = value.trim();
    if (summary && summary !== issue.summary)
      void save(issue.key, { summary }).finally(() => {
        committed.current = false;
      });
    else cancel();
  };
  return (
    <input
      autoFocus
      className="summary-input"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={submit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && value.trim()) submit();
        if (event.key === 'Escape') {
          committed.current = true;
          cancel();
        }
      }}
      aria-label={`Summary for ${issue.key}`}
    />
  );
}

function PickerFeedback({
  state,
  retry,
}: {
  state?: FieldLoad;
  retry: () => void;
}) {
  return (
    <>
      {state?.loading && (
        <span className="choice-loading" role="status">
          <Loader2 className="spin" size={13} />
          {state.validating ? 'Checking assignment…' : 'Loading…'}
        </span>
      )}
      {state?.error && (
        <div className="picker-error" role="alert">
          <span>{state.error}</span>
          <button onClick={retry}>Retry</button>
        </div>
      )}
    </>
  );
}
function ChoiceEditor({
  active,
  value,
  choices,
  state,
  retry,
  className,
  empty,
  onSave,
  onCancel,
}: {
  active: boolean;
  value: Choice | null;
  choices?: Choice[];
  state?: FieldLoad;
  retry: () => void;
  className: string;
  empty: string;
  onSave: (id: string) => void;
  onCancel: () => void;
}) {
  if (!active) return <span className={className}>{value?.name ?? empty}</span>;
  return (
    <div className="priority-editor">
      <PickerFeedback state={state} retry={retry} />
      {!state?.loading && !state?.error && choices?.length === 0 && (
        <span className="no-choices">No editable priorities available</span>
      )}
      {choices && !state?.error && !state?.loading && choices.length > 0 && (
        <select
          autoFocus
          value={value?.id ?? ''}
          onChange={(event) => onSave(event.target.value)}
          onBlur={onCancel}
          aria-label="Choose value"
        >
          <option value="" disabled>
            {empty}
          </option>
          {choices.map((choice) => (
            <option value={choice.id} key={choice.id}>
              {choice.name}
            </option>
          ))}
        </select>
      )}
      {(state?.error || choices?.length === 0) && (
        <button onClick={onCancel}>Cancel</button>
      )}
    </div>
  );
}

function navigateChoices(event: React.KeyboardEvent, selector: string) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const choices = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(selector),
  ];
  if (!choices.length) return;
  event.preventDefault();
  event.stopPropagation();
  const current = choices.indexOf(event.target as HTMLElement);
  const next =
    current < 0
      ? event.key === 'ArrowDown'
        ? 0
        : choices.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) %
        choices.length;
  choices[next].focus();
}

function AssigneeEditor({
  currentUser,
  active,
  issue,
  choices,
  resultQuery,
  state,
  hasMore,
  search,
  changeQuery,
  save,
  cancel,
}: {
  currentUser?: Choice;
  active: boolean;
  issue: Issue;
  choices?: Choice[];
  resultQuery?: string;
  state?: FieldLoad;
  hasMore: boolean;
  changeQuery: (query: string) => void;
  search: (query: string, more?: boolean, refresh?: boolean) => Promise<void>;
  save: (id: string | null) => void;
  cancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const previousQuery = useRef('');
  const queryChanged = useRef(false);
  useEffect(() => {
    if (!active) {
      setQuery('');
      previousQuery.current = '';
      queryChanged.current = false;
    }
  }, [active]);
  useEffect(() => {
    if (!active || !queryChanged.current) return;
    if (query === previousQuery.current) {
      queryChanged.current = false;
      void search(query);
      return;
    }
    const timer = window.setTimeout(() => {
      queryChanged.current = false;
      previousQuery.current = query;
      void search(query);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [active, query]);
  if (!active)
    return (
      <span className="assignee">
        <AssigneeAvatar assignee={issue.assignee} />
        <span>{issue.assignee?.name ?? 'Unassigned'}</span>
      </span>
    );
  const visible =
    resultQuery === query
      ? choices
      : choices?.filter((choice) =>
          choice.name.toLowerCase().includes(query.trim().toLowerCase()),
        );
  const more = () => {
    if (hasMore && !state?.loading && !state?.error) void search(query, true);
  };
  return (
    <div
      className="popover assignee-popover"
      onKeyDown={(event) =>
        navigateChoices(event, 'input, button:not(:disabled)')
      }
    >
      <input
        autoFocus
        value={query}
        onChange={(event) => {
          queryChanged.current = true;
          setQuery(event.target.value);
          changeQuery(event.target.value);
        }}
        onKeyDown={(event) => event.key === 'Escape' && cancel()}
        placeholder="Search people…"
        aria-label="Search assignees"
      />
      <button
        disabled={
          !currentUser ||
          issue.assignee?.id === currentUser.id ||
          state?.validating
        }
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => currentUser && save(currentUser.id)}
      >
        <AssigneeAvatar assignee={currentUser ?? null} />
        {currentUser && issue.assignee?.id === currentUser.id ? (
          <>
            Assigned to me <Check size={13} />
          </>
        ) : (
          'Assign to me'
        )}
      </button>
      <div
        className="choice-list"
        onScroll={(event) => {
          const list = event.currentTarget;
          if (list.scrollTop + list.clientHeight >= list.scrollHeight - 8)
            more();
        }}
      >
        <button
          disabled={state?.validating}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => save(null)}
        >
          <AssigneeAvatar assignee={null} />
          Unassigned
        </button>
        {visible?.map((choice) => (
          <button
            key={choice.id}
            disabled={state?.validating}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => save(choice.id)}
          >
            <AssigneeAvatar assignee={choice} />
            {choice.name}
            {issue.assignee?.id === choice.id && <Check size={13} />}
          </button>
        ))}
        {!state?.loading && !state?.error && visible?.length === 0 && (
          <span className="no-choices">No people found in these results</span>
        )}
        <PickerFeedback
          state={state}
          retry={() => void search(query, false, true)}
        />
        {hasMore && (
          <button
            disabled={state?.loading || Boolean(state?.error)}
            onClick={more}
          >
            Load more people
          </button>
        )}
      </div>
      <p className="picker-note">
        Recent people are suggestions; Jira checks assignment for this issue
        when selected. Search covers only Jira’s first 1,000 users and may be
        incomplete.
      </p>
      <button className="cancel-choice" onClick={cancel}>
        Cancel
      </button>
    </div>
  );
}

function StatusEditor({
  state,
  retry,
  color,
  active,
  issue,
  choices,
  save,
  cancel,
}: {
  color?: string;
  active: boolean;
  issue: Issue;
  choices?: EditOptions['transitions'];
  state?: FieldLoad;
  retry: () => void;
  save: (id: string) => void;
  cancel: () => void;
}) {
  if (!active)
    return (
      <span className="status" style={{ backgroundColor: color }}>
        {issue.status.name}
      </span>
    );
  return (
    <div
      className="popover status-popover"
      role="menu"
      onKeyDown={(event) =>
        navigateChoices(event, '[role="menuitem"]:not(:disabled)')
      }
    >
      <PickerFeedback state={state} retry={retry} />
      {!state?.loading && !state?.error && choices?.length === 0 && (
        <span className="no-choices">No transitions available</span>
      )}
      {!state?.error &&
        !state?.loading &&
        choices?.map((choice) => (
          <button
            role="menuitem"
            autoFocus={
              choice === choices?.find((value) => !value.requiresFields)
            }
            disabled={choice.requiresFields}
            title={
              choice.requiresFields
                ? 'This transition requires fields that Canopy does not edit yet.'
                : undefined
            }
            key={choice.id}
            onClick={() => save(choice.id)}
          >
            {choice.name}
            {choice.requiresFields && <small>Requires fields</small>}
          </button>
        ))}
      <button className="cancel-choice" onClick={cancel}>
        Cancel
      </button>
    </div>
  );
}

function LinkedIssues({
  issue,
  depth,
  openTab,
  openExternal,
}: {
  issue: Issue;
  depth: number;
  openTab: (key: string) => void;
  openExternal: (key: string) => void;
}) {
  const groups = issue.links.reduce<Record<string, typeof issue.links>>(
    (all, link) => {
      (all[link.relationship] ??= []).push(link);
      return all;
    },
    {},
  );
  return (
    <div
      className="linked-panel"
      style={{ '--depth': depth } as React.CSSProperties}
    >
      <div className="linked-rail" />
      <div className="linked-content">
        <span className="preview-hint">
          Linked issue references · separate from hierarchy children
        </span>
        {Object.entries(groups).map(([relationship, links]) => (
          <div className="link-group" key={relationship}>
            <span className="relationship">{relationship}</span>
            {(links ?? []).map((link) => (
              <div className="linked-row" key={`${relationship}-${link.key}`}>
                <Link2 size={12} />
                <button className="key" onClick={() => openExternal(link.key)}>
                  {link.key}
                </button>
                <span title={link.summary}>{link.summary}</span>
                <button
                  className="open-linked"
                  onClick={() => openTab(link.key)}
                  title="Open tree in new tab"
                >
                  <Plus size={13} />
                  Open tree
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectDialog({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: (connections: Connection[]) => void;
}) {
  const [siteUrl, setSiteUrl] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [scoped, setScoped] = useState(true);
  const [busy, setBusy] = useState<'token' | 'oauth' | null>(null);
  const [error, setError] = useState('');
  const clearError = () => setError('');
  const connectToken = async () => {
    if (!siteUrl.trim() || !email.trim() || !token) {
      setError('Enter your Jira site, Atlassian email, and API token.');
      return;
    }
    setBusy('token');
    setError('');
    try {
      const value = await window.canopy.connect({
        siteUrl: siteUrl.trim(),
        email: email.trim(),
        token,
        scoped,
      });
      onConnected(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };
  const connectOauth = async () => {
    setBusy('oauth');
    setError('');
    try {
      onConnected(await window.canopy.connect());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog title="Connect Jira" onClose={onClose} wide>
      <div className="connect-dialog">
        <p className="connect-lead">
          Use an Atlassian API token for a direct connection to your Jira Cloud
          site.
        </p>
        <label>
          <span>Jira site URL</span>
          <input
            autoFocus
            inputMode="url"
            autoComplete="url"
            placeholder="https://your-team.atlassian.net"
            value={siteUrl}
            onChange={(event) => {
              setSiteUrl(event.target.value);
              clearError();
            }}
          />
          <small>The address you use to open Jira.</small>
        </label>
        <label>
          <span>Atlassian email</span>
          <input
            type="email"
            autoComplete="username"
            placeholder="you@company.com"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              clearError();
            }}
          />
          <small>
            The email for the Atlassian account that created the token.
          </small>
        </label>
        <label>
          <span>API token</span>
          <input
            type="password"
            autoComplete="off"
            placeholder="Paste your token"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              clearError();
            }}
          />
          <small>
            Verified before saving, then stored in your operating system
            keychain.
          </small>
        </label>
        <fieldset>
          <legend>Token type</legend>
          <label className="radio">
            <input
              type="radio"
              name="token-type"
              checked={scoped}
              onChange={() => {
                setScoped(true);
                clearError();
              }}
            />
            <span>
              <b>Scoped token</b>
              <small>Recommended for new tokens</small>
            </span>
          </label>
          <label className="radio">
            <input
              type="radio"
              name="token-type"
              checked={!scoped}
              onChange={() => {
                setScoped(false);
                clearError();
              }}
            />
            <span>
              <b>Classic token</b>
              <small>Use for an existing unscoped token</small>
            </span>
          </label>
        </fieldset>
        {error && (
          <p className="dialog-error" role="alert">
            <AlertCircle size={14} />
            {error}
          </p>
        )}
        <div className="connect-actions">
          <button
            className="primary"
            disabled={
              Boolean(busy) || !siteUrl.trim() || !email.trim() || !token
            }
            onClick={() => void connectToken()}
          >
            {busy === 'token' ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <LogIn size={15} />
            )}
            Connect with token
          </button>
          <span>or</span>
          <button
            className="secondary"
            disabled={Boolean(busy)}
            onClick={() => void connectOauth()}
          >
            {busy === 'oauth' ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <ExternalLink size={14} />
            )}
            Sign in with browser
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function OpenIssueDialog({
  connections,
  recentRoots,
  activeRoot,
  onClose,
  onOpen,
}: {
  connections: Connection[];
  recentRoots: RootReference[];
  activeRoot?: RootReference;
  onClose: () => void;
  onOpen: (connectionId: string, key: string) => void;
}) {
  const [connectionId, setConnectionId] = useState(
    activeRoot && connections.some(({ id }) => id === activeRoot.connectionId)
      ? activeRoot.connectionId
      : (connections[0]?.id ?? ''),
  );
  const [query, setQuery] = useState('');
  const [searchState, setSearchState] = useState<SearchState>({
    issues: [],
    loading: false,
    searched: false,
    error: '',
  });
  const [selectedKey, setSelectedKey] = useState<string>();
  const search = useMemo(
    () =>
      new IssueSearch(window.canopy, (state) => {
        setSearchState(state);
        if (state.issues.length)
          setSelectedKey((key) => key ?? state.issues[0].key);
      }),
    [],
  );
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const directKey = parseIssueKey(query);
  const project = (
    activeRoot?.connectionId === connectionId
      ? activeRoot
      : recentRoots.find((root) => root.connectionId === connectionId)
  )?.rootKey.split('-')[0];
  const recent = recentRoots
    .filter((root) => root.connectionId === connectionId)
    .slice(0, 20);
  const options = !query.trim()
    ? recent.map((root) => ({
        key: root.rootKey,
        summary: root.summary ?? '',
        type: '',
      }))
    : searchState.issues;
  const selected =
    options.find((issue) => issue.key === selectedKey) ?? options[0];
  const busy = searchState.loading;
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    setSelectedKey(undefined);
    setError('');
    search.start(
      connectionId,
      query.trim(),
      project,
      Boolean(connectionId && query.trim().length >= 2 && !directKey),
    );
    return () => search.cancel();
  }, [connectionId, query, project, directKey, search]);
  useEffect(() => {
    if (selected)
      document
        .getElementById(`issue-option-${selected.key}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [selected?.key]);
  const submit = () => {
    const key = directKey ?? selected?.key;
    if (!connectionId) setError('Choose a connection first.');
    else if (key) onOpen(connectionId, key);
  };
  return (
    <Dialog title="Open issue tree" onClose={onClose}>
      <div className="open-form">
        {connections.length > 1 && (
          <label>
            <span>Connection</span>
            <select
              value={connectionId}
              onChange={(event) => {
                setConnectionId(event.target.value);
                search.start(event.target.value, '', undefined, false);
                setError('');
              }}
            >
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="searchbox">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              search.start(connectionId, '', project, false);
              setQuery(event.target.value);
              setError('');
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
              if (
                (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
                options.length
              ) {
                event.preventDefault();
                const index = Math.max(
                  0,
                  options.findIndex((issue) => issue.key === selected?.key),
                );
                setSelectedKey(
                  options[
                    Math.max(
                      0,
                      Math.min(
                        options.length - 1,
                        index + (event.key === 'ArrowDown' ? 1 : -1),
                      ),
                    )
                  ].key,
                );
              }
            }}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={options.length > 0}
            aria-controls="issue-search-options"
            aria-activedescendant={
              selected ? `issue-option-${selected.key}` : undefined
            }
            placeholder="Issue key, Jira URL, or summary"
            aria-label="Issue key, Jira URL, or summary"
          />
          {busy && <Loader2 className="spin" size={14} />}
        </div>
        {connections.length === 0 && (
          <p className="dialog-note">
            <AlertCircle size={14} />
            Connect a Jira site from the sidebar first.
          </p>
        )}
        {(error || searchState.error) && (
          <p className="dialog-error" role="alert">
            {error || searchState.error}
          </p>
        )}
        {searchState.error && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              void search.load().finally(() => inputRef.current?.focus());
            }}
          >
            Retry search
          </button>
        )}
        {busy && (
          <p className="dialog-note" role="status">
            {options.length ? 'Loading more matches…' : 'Searching Jira…'}
          </p>
        )}
        {!busy &&
          !searchState.error &&
          searchState.searched &&
          !options.length && (
            <p className="dialog-note" role="status">
              {searchState.nextPageToken
                ? 'No matches on this page. Load more to continue searching.'
                : 'No matching issues. Try another summary or enter an issue key.'}
            </p>
          )}
        {!query.trim() && options.length > 0 && (
          <p className="dialog-note">Recent roots</p>
        )}
        <div
          className="search-results"
          id="issue-search-options"
          role="listbox"
          aria-label="Issue results"
        >
          {options.map((issue) => (
            <button
              key={issue.key}
              id={`issue-option-${issue.key}`}
              role="option"
              aria-selected={selected?.key === issue.key}
              tabIndex={-1}
              title={issue.summary}
              onMouseMove={() => setSelectedKey(issue.key)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onOpen(connectionId, issue.key)}
            >
              <span className="type-icon">
                {issue.type.slice(0, 1) || <CircleDot size={14} />}
              </span>
              <span>
                <b>{issue.key}</b>
                {issue.summary}
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
        {query.trim() && searchState.issues.length > 0 && (
          <p className="dialog-note" role="status">
            {searchState.nextPageToken
              ? `Ranked among ${searchState.issues.length} loaded matches; more matches are available. Later pages may contain better matches.`
              : `${searchState.issues.length} matches loaded.`}
          </p>
        )}
        {searchState.nextPageToken && !searchState.error && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              void search.load().finally(() => inputRef.current?.focus());
            }}
          >
            Load more
          </button>
        )}
        <div className="dialog-footer">
          <span>
            <kbd>↵</kbd> open
          </span>
          <button
            className="primary"
            disabled={!connectionId || (!directKey && !selected)}
            onClick={submit}
          >
            Open tree
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function CommandDialog({
  commands,
  shortcuts,
  onClose,
}: {
  commands: Array<{
    id: string;
    label: string;
    icon: React.ComponentType<{ size?: number }>;
    run: () => void;
  }>;
  shortcuts: Record<string, string>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const shown = commands.filter((command) =>
    command.label.toLowerCase().includes(query.toLowerCase()),
  );
  const run = (command: (typeof commands)[number]) => {
    command.run();
    if (command.id !== 'shortcuts' && command.id !== 'quickOpen') onClose();
  };
  return (
    <Dialog title="Command palette" onClose={onClose} compact>
      <div className="command-search">
        <ChevronRight size={16} />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && shown[0]) run(shown[0]);
          }}
          placeholder="Type a command"
          aria-label="Type a command"
        />
      </div>
      <div className="command-list">
        {shown.map((command) => (
          <button key={command.id} onClick={() => run(command)}>
            <command.icon size={15} />
            <span>{command.label}</span>
            <kbd>{shortcutDisplay(shortcuts[command.id])}</kbd>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

function shortcutDisplay(shortcut = '') {
  if (!/mac/i.test(navigator.platform)) return shortcut.replaceAll('+', ' + ');
  return shortcut
    .replace('Meta', '⌘')
    .replace('Ctrl', '⌃')
    .replace('Alt', '⌥')
    .replace('Shift', '⇧')
    .replaceAll('+', '');
}

function ShortcutsDialog({
  shortcuts,
  onChange,
  onClose,
}: {
  shortcuts: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(shortcuts);
  const [recording, setRecording] = useState<string | null>(null);
  const collisions = shortcutCollisions(draft);
  const conflicts = new Set([...collisions.values()].flat());
  useEffect(() => {
    if (!recording) return;
    const capture = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(null);
        return;
      }
      const shortcut = eventShortcut(event);
      if (!shortcut || ['Meta', 'Ctrl', 'Alt', 'Shift'].includes(shortcut))
        return;
      setDraft((value) => ({ ...value, [recording]: shortcut }));
      setRecording(null);
    };
    window.addEventListener('keydown', capture, true);
    return () => window.removeEventListener('keydown', capture, true);
  }, [recording]);
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} wide>
      <div className="shortcut-intro">
        Click a shortcut, then press the new key combination. Conflicting
        shortcuts must be resolved before saving.
      </div>
      <div className="shortcut-head">
        <span>Command</span>
        <span>Shortcut</span>
      </div>
      <div className="shortcut-list">
        {Object.entries(SHORTCUT_LABELS).map(([id, label]) => (
          <div
            className={cx('shortcut-row', conflicts.has(id) && 'conflict')}
            key={id}
          >
            <span>{label}</span>
            <button
              className={cx(recording === id && 'recording')}
              onClick={() => setRecording(id)}
            >
              {recording === id
                ? 'Press keys…'
                : shortcutDisplay(draft[id]) || 'Unassigned'}
            </button>
            {conflicts.has(id) && (
              <small>
                <AlertCircle size={12} />
                Already assigned
              </small>
            )}
          </div>
        ))}
      </div>
      <div className="dialog-footer">
        <button
          className="secondary"
          onClick={() => setDraft(defaultShortcuts())}
        >
          Restore defaults
        </button>
        <span className="footer-spacer" />
        <button className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={collisions.size > 0}
          onClick={() => {
            onChange(draft);
            onClose();
          }}
        >
          Save
        </button>
      </div>
    </Dialog>
  );
}

function Dialog({
  title,
  onClose,
  children,
  compact,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  compact?: boolean;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const panel = panelRef.current;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = [
        ...panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [onClose]);
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        className={cx('dialog', compact && 'compact', wide && 'wide')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <header>
          <h2 id="dialog-title">{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={16} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function TreeSkeleton() {
  return (
    <div className="skeleton" aria-label="Loading issue tree">
      {[0, 1, 2, 3, 4, 5].map((item) => (
        <div key={item} style={{ marginLeft: `${(item % 3) * 26}px` }}>
          <span />
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}
function EmptyState({
  icon: Icon,
  title,
  detail,
  action,
  onAction,
}: {
  icon: React.ComponentType<{ size?: number }>;
  title: string;
  detail: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={23} />
      </div>
      <h2>{title}</h2>
      <p>{detail}</p>
      <button className="primary" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}
function Welcome({
  onOpen,
  onConnect,
  hasConnections,
  error,
}: {
  onOpen: () => void;
  onConnect: () => void;
  hasConnections: boolean;
  error?: string;
}) {
  return (
    <div className="welcome">
      <div className="welcome-art">
        <div className="branch branch-one">
          <i />
          <i />
          <i />
        </div>
        <div className="branch branch-two">
          <i />
          <i />
        </div>
      </div>
      <div className="welcome-copy">
        <div className="eyebrow">ISSUES, IN CONTEXT</div>
        <h1>See the whole tree.</h1>
        <p>
          Explore epics, stories, tasks, and subtasks together. Make quick
          changes without losing your place.
        </p>
        {error && (
          <div className="welcome-error">
            <AlertCircle size={15} />
            {error}
          </div>
        )}
        <div className="welcome-actions">
          <button
            className="primary"
            onClick={hasConnections ? onOpen : onConnect}
          >
            {hasConnections ? <Search size={16} /> : <LogIn size={16} />}
            {hasConnections ? 'Open an issue' : 'Connect Jira'}
          </button>
          {hasConnections && (
            <button className="secondary" onClick={onConnect}>
              <Plus size={15} />
              Add connection
            </button>
          )}
        </div>
        <span className="welcome-hint">
          Tip: Press <kbd>{shortcutDisplay(PLATFORM_SHORTCUTS.quickOpen)}</kbd>{' '}
          to open an issue from anywhere.
        </span>
      </div>
    </div>
  );
}
