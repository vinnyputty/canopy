import React, {
  useCallback,
  useEffect,
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
  reconcileSnapshot,
  SHORTCUT_LABELS,
  shortcutCollisions,
  visibleTree,
  type IssueNode,
} from './tree';
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

type EditField = 'summary' | 'priority' | 'assignee' | 'status';
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
  const [connections, setConnections] = useState<Connection[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, TreeSnapshot>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  const [dialog, setDialog] = useState<
    'open' | 'commands' | 'shortcuts' | 'connect' | null
  >(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [options, setOptions] = useState<Record<string, EditOptions>>({});
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const attemptedLoads = useRef(new Set<string>());
  const inflightRefreshes = useRef(new Set<string>());
  const refreshSequences = useRef<Record<string, number>>({});
  const mutationEpoch = useRef(0);
  const optionSequences = useRef<Record<string, number>>({});
  const tabsRef = useRef<TabState[]>([]);
  const pendingScrollRestore = useRef<string | null>(null);
  const activeTab =
    workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? null;
  const snapshot = activeTab ? snapshots[activeTab.id] : undefined;
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
    pendingScrollRestore.current = activeTab?.id ?? null;
  }, [activeTab?.id]);

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

  const refreshTab = useCallback(async (tab: TabState, quiet = false) => {
    if (inflightRefreshes.current.has(tab.id)) return;
    inflightRefreshes.current.add(tab.id);
    const sequence = (refreshSequences.current[tab.id] ?? 0) + 1;
    refreshSequences.current[tab.id] = sequence;
    const epoch = mutationEpoch.current;
    const setter = quiet ? setRefreshing : setLoading;
    setter((current) => new Set(current).add(tab.id));
    try {
      const next = await window.canopy.tree(tab.connectionId, tab.rootKey);
      if (
        refreshSequences.current[tab.id] === sequence &&
        mutationEpoch.current === epoch
      ) {
        setSnapshots((current) => ({
          ...current,
          [tab.id]: reconcileSnapshot(current[tab.id], next),
        }));
      }
      setErrors((current) => {
        const copy = { ...current };
        delete copy[tab.id];
        return copy;
      });
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [tab.id]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      inflightRefreshes.current.delete(tab.id);
      setter((current) => {
        const copy = new Set(current);
        copy.delete(tab.id);
        return copy;
      });
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    for (const tab of workspace.tabs) {
      if (!snapshots[tab.id] && !attemptedLoads.current.has(tab.id)) {
        attemptedLoads.current.add(tab.id);
        void refreshTab(tab);
      }
    }
  }, [ready, workspace.tabs, snapshots, refreshTab]);

  useEffect(() => {
    if (!ready) return;
    const refresh = () =>
      tabsRef.current.forEach((tab) => void refreshTab(tab, true));
    const timer = window.setInterval(refresh, 30_000);
    const onFocus = refresh;
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [ready, refreshTab]);

  useEffect(() => {
    if (
      !activeTab ||
      !snapshot ||
      !scrollRef.current ||
      pendingScrollRestore.current !== activeTab.id
    )
      return;
    scrollRef.current.scrollTop = activeTab.scrollTop;
    pendingScrollRestore.current = null;
  }, [activeTab, Boolean(snapshot)]);

  const updateTab = useCallback((tabId: string, patch: Partial<TabState>) => {
    setWorkspace((current) => ({
      ...current,
      tabs: current.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, ...patch } : tab,
      ),
    }));
  }, []);

  const navigate = useCallback((tab: TabState, restoring = false) => {
    const current = workspaceRef.current;
    const from = current.tabs.find((item) => item.id === current.activeTabId);
    if (!restoring) setHistory(visit(historyRef.current, from, tab));
    pendingScrollRestore.current =
      current.tabs.find((item) => sameRoot(item, tab))?.id ?? tab.id;
    setWorkspace((value) => activateTab(value, tab));
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
          hideDone: true,
          scrollTop: 0,
        },
      );
      setDialog(null);
    },
    [navigate],
  );

  const closeTabIds = useCallback((ids: string[]) => {
    setWorkspace((current) => closeTabs(current, ids));
    setTabMenu(null);
  }, []);
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
    (expanded: boolean) => {
      if (!activeTab || !snapshot) return;
      updateTab(activeTab.id, {
        expanded: expanded ? snapshot.issues.map((issue) => issue.key) : [],
      });
    },
    [activeTab, snapshot, updateTab],
  );

  const commands = useMemo(
    () => [
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
        run: () => activeTab && void refreshTab(activeTab, true),
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
    async (key: string, query?: string) => {
      if (!activeTab) return;
      const connectionId = activeTab.connectionId;
      const scopedKey = `${connectionId}:${key}`;
      const sequence = (optionSequences.current[scopedKey] ?? 0) + 1;
      optionSequences.current[scopedKey] = sequence;
      try {
        const next = await window.canopy.editOptions(connectionId, key, query);
        if (optionSequences.current[scopedKey] !== sequence) return;
        setOptions((current) => ({
          ...current,
          [scopedKey]: next,
        }));
      } catch (error) {
        setErrors((current) => ({
          ...current,
          edit: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [activeTab],
  );

  const beginEdit = useCallback(
    (key: string, field: EditField) => {
      if (!activeTab) return;
      setEditor({ connectionId: activeTab.connectionId, key, field });
      if (!options[`${activeTab.connectionId}:${key}`]) void loadOptions(key);
    },
    [activeTab, loadOptions, options],
  );

  const updateIssue = useCallback(
    async (key: string, patch: IssuePatch) => {
      if (!activeTab) return;
      mutationEpoch.current += 1;
      setSaving((current) => new Set(current).add(key));
      try {
        const next = await window.canopy.update(
          activeTab.connectionId,
          key,
          patch,
        );
        setSnapshots((current) => {
          const copy = { ...current };
          for (const tab of workspace.tabs) {
            if (tab.connectionId !== activeTab.connectionId || !copy[tab.id])
              continue;
            copy[tab.id] = {
              ...copy[tab.id],
              issues: copy[tab.id].issues.map((issue) =>
                issue.key === key ? next : issue,
              ),
            };
          }
          return copy;
        });
        setEditor(null);
        void loadOptions(key);
        setErrors((current) => {
          const copy = { ...current };
          delete copy.edit;
          return copy;
        });
      } catch (error) {
        setErrors((current) => ({
          ...current,
          edit: `Couldn’t update ${key}: ${error instanceof Error ? error.message : String(error)}`,
        }));
      } finally {
        mutationEpoch.current += 1;
        setSaving((current) => {
          const copy = new Set(current);
          copy.delete(key);
          return copy;
        });
      }
    },
    [activeTab, workspace.tabs, loadOptions],
  );

  const rankBefore = useCallback(
    async (key: string, beforeKey: string) => {
      if (!activeTab || !snapshot || key === beforeKey) return;
      const moving = snapshot.issues.find((issue) => issue.key === key);
      const target = snapshot.issues.find((issue) => issue.key === beforeKey);
      if (!moving || !target || moving.parentKey !== target.parentKey) {
        setErrors((current) => ({
          ...current,
          edit: 'Issues can only be reordered among siblings.',
        }));
        return;
      }
      mutationEpoch.current += 1;
      setSaving((current) => new Set(current).add(key));
      try {
        await window.canopy.rank(activeTab.connectionId, key, beforeKey);
        setSnapshots((current) => {
          const currentSnapshot = current[activeTab.id];
          if (!currentSnapshot) return current;
          const issues = [...currentSnapshot.issues];
          const movingIndex = issues.findIndex((issue) => issue.key === key);
          if (movingIndex < 0) return current;
          const [movingIssue] = issues.splice(movingIndex, 1);
          const targetIndex = issues.findIndex(
            (issue) => issue.key === beforeKey,
          );
          if (targetIndex < 0) return current;
          issues.splice(targetIndex, 0, movingIssue);
          return { ...current, [activeTab.id]: { ...currentSnapshot, issues } };
        });
      } catch (error) {
        setErrors((current) => ({
          ...current,
          edit: `Couldn’t reorder ${key}: ${error instanceof Error ? error.message : String(error)}`,
        }));
      } finally {
        mutationEpoch.current += 1;
        setSaving((current) => {
          const copy = new Set(current);
          copy.delete(key);
          return copy;
        });
      }
    },
    [activeTab, snapshot],
  );

  const keyboardRank = useCallback(
    (node: IssueNode, direction: -1 | 1) => {
      if (!snapshot) return;
      const siblings = snapshot.issues.filter(
        (issue) => issue.parentKey === node.issue.parentKey,
      );
      const index = siblings.findIndex((issue) => issue.key === node.issue.key);
      if (direction < 0 && index > 0)
        void rankBefore(node.issue.key, siblings[index - 1].key);
      if (direction > 0 && index >= 0 && index < siblings.length - 1)
        void rankBefore(siblings[index + 1].key, node.issue.key);
    },
    [snapshot, rankBefore],
  );

  const tree = useMemo(
    () => (snapshot ? buildIssueTree(snapshot.issues, snapshot.rootKey) : null),
    [snapshot],
  );
  const shownTree = useMemo(
    () => (tree && activeTab ? visibleTree(tree, activeTab.hideDone) : tree),
    [tree, activeTab?.hideDone],
  );
  const expandedSet = useMemo(
    () => new Set(activeTab?.expanded ?? []),
    [activeTab?.expanded],
  );
  const flat = useMemo(
    () => flattenVisible(shownTree, expandedSet),
    [shownTree, expandedSet],
  );

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
                  onClick={() => expandAll(false)}
                  title="Collapse all"
                >
                  <ChevronsDownUp size={15} />
                  <span>Collapse</span>
                </button>
                <button
                  className="tool-button"
                  onClick={() => expandAll(true)}
                  title="Expand all"
                >
                  <ChevronsUpDown size={15} />
                  <span>Expand</span>
                </button>
                <button
                  className="icon-button"
                  disabled={refreshing.has(activeTab.id)}
                  onClick={() => void refreshTab(activeTab, true)}
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
            {snapshot?.warnings.map((warning) => (
              <div className="warning-banner" key={warning}>
                <AlertCircle size={14} />
                {warning}
              </div>
            ))}
            <div className="column-head">
              <span className="issue-column">Issue</span>
              <span>Priority</span>
              <span>Assignee</span>
              <span>Status</span>
              <span className="row-actions-head" />
            </div>
            <div
              className="tree-scroll"
              ref={scrollRef}
              onScroll={(event) =>
                updateTab(activeTab.id, {
                  scrollTop: event.currentTarget.scrollTop,
                })
              }
            >
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
                    statusColors={statusColors}
                    depth={0}
                    expanded={expandedSet}
                    linkedExpanded={new Set(activeTab.linkedExpanded ?? [])}
                    onToggleLinks={(key) =>
                      updateTab(activeTab.id, {
                        linkedExpanded: activeTab.linkedExpanded?.includes(key)
                          ? activeTab.linkedExpanded.filter(
                              (item) => item !== key,
                            )
                          : [...(activeTab.linkedExpanded ?? []), key],
                      })
                    }
                    onToggle={(key) =>
                      updateTab(activeTab.id, {
                        expanded: expandedSet.has(key)
                          ? activeTab.expanded.filter((item) => item !== key)
                          : [...activeTab.expanded, key],
                      })
                    }
                    selectedKey={activeTab.selectedKey}
                    onSelect={(key) =>
                      updateTab(activeTab.id, { selectedKey: key })
                    }
                    onOpenTab={(key) => openTab(activeTab.connectionId, key)}
                    onOpenExternal={(key) =>
                      void openExternal(activeTab.connectionId, key)
                    }
                    onCopyLink={(key) =>
                      void copyIssueLink(activeTab.connectionId, key)
                    }
                    editor={editor}
                    beginEdit={beginEdit}
                    cancelEdit={() => setEditor(null)}
                    options={scopedOptions}
                    loadOptions={loadOptions}
                    updateIssue={updateIssue}
                    saving={saving}
                    dragKey={dragKey}
                    setDragKey={setDragKey}
                    rankBefore={rankBefore}
                    keyboardRank={keyboardRank}
                    focusNeighbor={focusTreeNeighbor}
                  />
                </div>
              ) : tree && activeTab.hideDone ? (
                <EmptyState
                  icon={Check}
                  title="All issues are done"
                  detail="Completed issues in this tree are currently hidden."
                  action="Show done issues"
                  onAction={() => updateTab(activeTab.id, { hideDone: false })}
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
            {snapshot && (
              <footer className="statusbar">
                <span>
                  {snapshot.issues.length} issue
                  {snapshot.issues.length === 1 ? '' : 's'}
                </span>
                <span>
                  Updated{' '}
                  {new Date(snapshot.fetchedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                {refreshing.has(activeTab.id) && (
                  <span>
                    <Loader2 className="spin" size={12} /> Checking for changes
                  </span>
                )}
                <span className="status-spacer" />
                <span>Auto-refresh 30s</span>
              </footer>
            )}
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
      {dialog === 'open' && (
        <OpenIssueDialog
          connections={connections}
          recentRoots={workspace.recentRoots ?? []}
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
  node: IssueNode;
  statusColors: ReadonlyMap<string, string>;
  depth: number;
  expanded: Set<string>;
  linkedExpanded: Set<string>;
  onToggleLinks: (key: string) => void;
  onToggle: (key: string) => void;
  selectedKey?: string;
  onSelect: (key: string) => void;
  onOpenTab: (key: string) => void;
  onOpenExternal: (key: string) => void;
  onCopyLink: (key: string) => void;
  editor: Editor;
  beginEdit: (key: string, field: EditField) => void;
  cancelEdit: () => void;
  options: Record<string, EditOptions>;
  loadOptions: (key: string, query?: string) => Promise<void>;
  updateIssue: (key: string, patch: IssuePatch) => Promise<void>;
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
  const onTreeKey = (event: React.KeyboardEvent) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (
      (event.target as HTMLElement).closest(
        'input,button,select,[role="button"]',
      )
    )
      return;
    event.stopPropagation();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusNeighbor(issue.key, 1);
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusNeighbor(issue.key, -1);
    }
    if (event.key === 'ArrowRight' && hasChildren && !open) {
      event.preventDefault();
      onToggle(issue.key);
    }
    if (event.key === 'ArrowLeft' && open) {
      event.preventDefault();
      onToggle(issue.key);
    }
    if (event.key === 'F2') {
      event.preventDefault();
      props.beginEdit(issue.key, 'summary');
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(issue.key);
    }
  };
  return (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? open : undefined}
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
    >
      <div
        className={cx(
          'issue-row',
          selectedKey === issue.key && 'selected',
          dragKey && dragKey !== issue.key && 'drop-ready',
        )}
        onDragOver={(event) => {
          if (dragKey && dragKey !== issue.key) event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (dragKey) void rankBefore(dragKey, issue.key);
          setDragKey(null);
        }}
      >
        <div
          className="issue-cell"
          style={{ '--depth': depth } as React.CSSProperties}
        >
          <button
            className="grab"
            draggable={depth > 0}
            disabled={depth === 0}
            aria-label={
              depth === 0
                ? `${issue.key} is the tree root`
                : `Reorder ${issue.key}. Use Alt plus arrow keys to move.`
            }
            title={
              depth === 0
                ? 'The root issue cannot be reordered'
                : 'Drag to reorder; Alt+↑/↓ also works'
            }
            onDragStart={() => setDragKey(issue.key)}
            onDragEnd={() => setDragKey(null)}
            onKeyDown={(event) => {
              if (!event.altKey) return;
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
          <button
            className={cx('disclosure', !hasChildren && 'placeholder')}
            aria-label={open ? `Collapse ${issue.key}` : `Expand ${issue.key}`}
            tabIndex={hasChildren ? 0 : -1}
            onClick={() => hasChildren && onToggle(issue.key)}
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
                onDoubleClick={() => props.beginEdit(issue.key, 'summary')}
                onClick={() => onSelect(issue.key)}
                title="Double-click to edit"
              >
                {issue.summary}
              </button>
            )}
          </div>
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
        <FieldCell
          label={`Edit priority for ${issue.key}`}
          active={
            props.editor?.key === issue.key && props.editor.field === 'priority'
          }
          onEdit={() => props.beginEdit(issue.key, 'priority')}
        >
          <ChoiceEditor
            active={
              props.editor?.key === issue.key &&
              props.editor.field === 'priority'
            }
            value={issue.priority}
            choices={props.options[issue.key]?.priorities}
            className={`priority ${priorityTone(issue.priority?.name)}`}
            empty="No priority"
            onSave={(id) =>
              void props.updateIssue(issue.key, { priorityId: id })
            }
            onCancel={props.cancelEdit}
          />
        </FieldCell>
        <FieldCell
          label={`Edit assignee for ${issue.key}`}
          active={
            props.editor?.key === issue.key && props.editor.field === 'assignee'
          }
          onEdit={() => props.beginEdit(issue.key, 'assignee')}
        >
          <AssigneeEditor
            active={
              props.editor?.key === issue.key &&
              props.editor.field === 'assignee'
            }
            issue={issue}
            choices={props.options[issue.key]?.assignees}
            search={(query) => props.loadOptions(issue.key, query)}
            save={(id) => void props.updateIssue(issue.key, { assigneeId: id })}
            cancel={props.cancelEdit}
          />
        </FieldCell>
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
            save={(id) =>
              void props.updateIssue(issue.key, { transitionId: id })
            }
            cancel={props.cancelEdit}
          />
        </FieldCell>
        <div className="row-actions">
          {props.saving.has(issue.key) ? (
            <Loader2 className="spin" size={14} />
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
        <div role="group">
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
  return (
    <div
      className={cx('field-cell', active && 'editing')}
      role={active ? undefined : 'button'}
      tabIndex={active ? -1 : 0}
      aria-label={active ? undefined : label}
      onClick={() => !active && onEdit()}
      onKeyDown={(event) => {
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

function ChoiceEditor({
  active,
  value,
  choices,
  className,
  empty,
  onSave,
  onCancel,
}: {
  active: boolean;
  value: Choice | null;
  choices?: Choice[];
  className: string;
  empty: string;
  onSave: (id: string) => void;
  onCancel: () => void;
}) {
  if (!active) return <span className={className}>{value?.name ?? empty}</span>;
  if (!choices) return <Loader2 className="spin" size={14} />;
  return (
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
  );
}

function AssigneeEditor({
  active,
  issue,
  choices,
  search,
  save,
  cancel,
}: {
  active: boolean;
  issue: Issue;
  choices?: Choice[];
  search: (query: string) => Promise<void>;
  save: (id: string | null) => void;
  cancel: () => void;
}) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => void search(query), 220);
    return () => window.clearTimeout(timer);
  }, [active, query]);
  if (!active)
    return (
      <span className="assignee">
        <AssigneeAvatar assignee={issue.assignee} />
        <span>{issue.assignee?.name ?? 'Unassigned'}</span>
      </span>
    );
  return (
    <div className="popover assignee-popover">
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && cancel()}
        placeholder="Search people…"
        aria-label="Search assignees"
      />
      <div className="choice-list">
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => save(null)}
        >
          <AssigneeAvatar assignee={null} />
          Unassigned
        </button>
        {choices?.map((choice) => (
          <button
            key={choice.id}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => save(choice.id)}
          >
            <AssigneeAvatar assignee={choice} />
            {choice.name}
            {issue.assignee?.id === choice.id && <Check size={13} />}
          </button>
        ))}
        {!choices && (
          <span className="choice-loading">
            <Loader2 className="spin" size={13} />
            Loading…
          </span>
        )}
      </div>
    </div>
  );
}

function StatusEditor({
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
  save: (id: string) => void;
  cancel: () => void;
}) {
  if (!active)
    return (
      <span className="status" style={{ backgroundColor: color }}>
        {issue.status.name}
      </span>
    );
  if (!choices) return <Loader2 className="spin" size={14} />;
  return (
    <div className="popover status-popover" role="menu">
      {choices.length === 0 && (
        <span className="no-choices">No transitions available</span>
      )}
      {choices.map((choice) => (
        <button
          role="menuitem"
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
        {Object.entries(groups).map(([relationship, links]) => (
          <div className="link-group" key={relationship}>
            <span className="relationship">{relationship}</span>
            {(links ?? []).map((link) => (
              <div className="linked-row" key={`${relationship}-${link.key}`}>
                <Link2 size={12} />
                <button className="key" onClick={() => openExternal(link.key)}>
                  {link.key}
                </button>
                <span>{link.summary}</span>
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
  onClose,
  onOpen,
}: {
  connections: Connection[];
  recentRoots: RootReference[];
  onClose: () => void;
  onOpen: (connectionId: string, key: string) => void;
}) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    setResults([]);
    setError('');
    if (!connectionId || query.trim().length < 2 || parseIssueKey(query)) {
      setBusy(false);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      setBusy(true);
      window.canopy
        .search(connectionId, query.trim())
        .then((value) => live && setResults(value))
        .catch(
          (reason) =>
            live &&
            setError(reason instanceof Error ? reason.message : String(reason)),
        )
        .finally(() => live && setBusy(false));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [connectionId, query]);
  const submit = () => {
    const key = parseIssueKey(query);
    if (!connectionId) setError('Choose a connection first.');
    else if (!key)
      setError('Enter an issue key, Jira URL, or select a search result.');
    else onOpen(connectionId, key);
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
                setResults([]);
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
              setQuery(event.target.value);
              setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
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
        {error && <p className="dialog-error">{error}</p>}
        <div className="search-results">
          {!query.trim() &&
            recentRoots.some((root) => root.connectionId === connectionId) && (
              <>
                <p className="dialog-note">Recent roots</p>
                {recentRoots
                  .filter((root) => root.connectionId === connectionId)
                  .map((root) => (
                    <button
                      key={root.rootKey}
                      title={root.summary}
                      onClick={() => onOpen(root.connectionId, root.rootKey)}
                    >
                      <CircleDot size={14} />
                      <span>
                        <b>{root.rootKey}</b>
                        {root.summary}
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
              </>
            )}
          {results.map((issue) => (
            <button
              key={issue.key}
              onClick={() => onOpen(connectionId, issue.key)}
            >
              <span className="type-icon">{issue.type.slice(0, 1)}</span>
              <span>
                <b>{issue.key}</b>
                {issue.summary}
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
        <div className="dialog-footer">
          <span>
            <kbd>↵</kbd> open
          </span>
          <button
            className="primary"
            disabled={!connectionId || !parseIssueKey(query)}
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
