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
  IssuePreview as IssuePreviewData,
  IssuePatch,
  RootReference,
  RootView,
  SavedIssueView,
  SeenIssue,
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
  parseGithubRepository,
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
import { nextTasks, type NextTaskCriterion } from './next-tasks';
import {
  boundRoots,
  markIssueSeen,
  markRootSeen,
  reconcileOwnEdit,
  seedOrExtend,
  seenRootKey,
  unseenChanges,
} from './seen';
import { RowMenu } from './RowMenu';
import { issueKeyAndSummary, issueWorkBrief } from './copy-issue';
import { BulkTriage, type BulkOperation } from './BulkTriage';
import { copySelectedIssues } from './bulk-triage';
import { CreateChildDialog } from './CreateChildDialog';
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
import { RefreshSchedule, RootRefreshGate } from './refresh';
import {
  configuredRoots,
  sourceTabId,
  starterViews,
  viewResults,
  viewSources,
} from './saved-views';
import { SavedViewsPanel } from './SavedViewsPanel';
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
  palette: 'default',
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
function refreshRootKey(tab: Pick<TabState, 'connectionId' | 'rootKey'>) {
  return JSON.stringify([tab.connectionId, tab.rootKey.toLowerCase()]);
}
export function App() {
  const [workspace, setWorkspace] = useState<Workspace>(EMPTY_WORKSPACE);
  const [selectedViewIssue, setSelectedViewIssue] = useState<string | null>(
    null,
  );
  const [connections, storeConnections] = useState<Connection[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, TreeSnapshot>>({});
  const [confirmedSnapshots, setConfirmedSnapshots] = useState<
    Record<string, TreeSnapshot>
  >({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [tour, setTour] = useState<{
    phase: 'playing' | 'paused' | 'stopped' | 'complete' | 'failed';
    step: number;
    caption: string;
  } | null>(null);
  const tourStarted = useRef(false);
  const stopTourRef = useRef<(() => void) | null>(null);
  const seekTourRef = useRef<((step: number, paused?: boolean) => void) | null>(
    null,
  );
  const toggleTourPauseRef = useRef<(() => void) | null>(null);
  const tourProgressRef = useRef<HTMLProgressElement>(null);
  const tourEditor = useRef(false);
  const [dialog, setDialog] = useState<
    'open' | 'commands' | 'shortcuts' | 'appearance' | 'connect' | null
  >(null);
  const [appearancePreview, setAppearancePreview] = useState<{
    theme: Workspace['theme'];
    palette: NonNullable<Workspace['palette']>;
  } | null>(null);
  useLayoutEffect(() => {
    if (dialog !== 'appearance') setAppearancePreview(null);
  }, [dialog]);
  const [workBrief, setWorkBrief] = useState<{
    connectionId: string;
    issueKey: string;
    provider: Connection['provider'];
    knownIssues: Issue[];
    preview?: IssuePreviewData;
  } | null>(null);
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
  const workspaceSaveTimer = useRef<number | null>(null);
  const pendingWorkspaceSave = useRef<Promise<void>>(Promise.resolve());
  const appearanceSaving = useRef(false);
  const connectionsRef = useRef(connections);
  const draggedTab = useRef<string | null>(null);
  workspaceRef.current = workspace;
  connectionsRef.current = connections;
  historyRef.current = history;
  const [queries, setQueries] = useState<Record<string, string>>({});
  const [nextTaskViews, setNextTaskViews] = useState<Record<string, boolean>>(
    {},
  );
  const [nextTaskCriteria, setNextTaskCriteria] = useState<
    Record<string, NextTaskCriterion>
  >({});
  const [nextTaskMine, setNextTaskMine] = useState<Record<string, boolean>>({});
  const [reveal, setReveal] = useState<{
    tabId: string;
    key: string;
    preserveScroll?: boolean;
  } | null>(null);
  const focusedReveal = useRef<typeof reveal>(null);
  const navigationReveal = useRef<{ tabId: string; key: string } | null>(null);
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
    trigger?: boolean;
  } | null>(null);
  const [multiSelection, setMultiSelection] = useState<{
    tabId: string;
    keys: string[];
    anchor: string;
  } | null>(null);
  const [bulkOperations, setBulkOperations] = useState<
    Record<string, BulkOperation>
  >({});
  const suppressTreeFocus = useRef(false);
  const [childParent, setChildParent] = useState<{
    issue: Issue;
    connectionId: string;
    tabId: string;
  } | null>(null);
  const restoreTreeFocus = useCallback((key?: string) => {
    const row = key
      ? document.querySelector<HTMLElement>(`[data-tree-key="${key}"]`)
      : null;
    row?.focus({ preventScroll: true });
  }, []);
  const closeRowMenu = useCallback(
    (restore = true) => {
      if (restore) {
        const key = rowMenu?.issue.key;
        const trigger = key
          ? document.querySelector<HTMLElement>(
              `[data-tree-key="${key}"] [data-row-menu-trigger]`,
            )
          : null;
        if (rowMenu?.trigger && trigger) trigger.focus({ preventScroll: true });
        else restoreTreeFocus(key);
      }
      setRowMenu(null);
    },
    [restoreTreeFocus, rowMenu],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const displayedTrees = useRef(new Map<string, IssueNode | null>());
  const attemptedLoads = useRef(new Set<string>());
  const previousVirtualTabs = useRef(new Map<string, TabState>());
  const refreshSchedule = useRef(new RefreshSchedule());
  const rootRefreshes = useRef(new RootRefreshGate<TreeSnapshot>());
  const snapshotsRef = useRef(snapshots);
  snapshotsRef.current = snapshots;
  const workflowReturn = useRef<{
    tabId: string;
    connectionId: string;
    key: string;
    left: boolean;
    returned: boolean;
    opened: boolean;
  } | null>(null);
  const cooldowns = useRef<Record<string, number>>({});
  const [cooldownTimes, setCooldownTimes] = useState<Record<string, number>>(
    {},
  );
  const [syncNow, setSyncNow] = useState(Date.now());
  const deferredRefreshes = useRef(new Set<string>());
  const forcedRefreshes = useRef(new Set<string>());
  const runningExplicitRefreshes = useRef(new Map<string, number>());
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
          setConfirmedSnapshots(view.confirmedSnapshots);
          setSaving(view.saving);
          setUndoState({ label: view.undoLabel, busy: view.undoBusy });
        },
        (message) => setErrors((current) => ({ ...current, edit: message })),
        (connectionId, issue, fields) =>
          setWorkspace((current) => ({
            ...current,
            seenRoots: reconcileOwnEdit(
              current.seenRoots ?? {},
              connectionId,
              issue,
              fields.map((field) => field[0].toUpperCase() + field.slice(1)),
            ),
          })),
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
  const activeViewSourceIdsRef = useRef<string[]>([]);
  refreshBlocked.current = (connectionId) =>
    editorRef.current?.connectionId === connectionId ||
    mutations.pending(connectionId);
  const activeTab =
    workspace.tabs.find((tab) => tab.id === workspace.activeTabId) ?? null;
  const activeSavedView = workspace.savedViews?.find(
    (item) => item.id === workspace.activeSavedViewId,
  );
  const availableRoots = useMemo(
    () => configuredRoots(workspace, connections),
    [workspace.tabs, workspace.pinnedRoots, workspace.recentRoots, connections],
  );
  const savedSources = useMemo(
    () => (activeSavedView ? viewSources(activeSavedView, availableRoots) : []),
    [activeSavedView, availableRoots],
  );
  const sourceTabs = useMemo<TabState[]>(
    () =>
      savedSources.map((source) => ({
        ...source,
        expanded: [source.rootKey],
        hideDone: false,
        scrollTop: 0,
      })),
    [savedSources],
  );
  activeIdRef.current = workspace.activeSavedViewId
    ? (sourceTabs[0]?.id ?? null)
    : workspace.activeTabId;
  const allRefreshTabs = useMemo(
    () => [
      ...workspace.tabs,
      ...sourceTabs.filter(
        (source) => !workspace.tabs.some((tab) => sameRoot(source, tab)),
      ),
    ],
    [workspace.tabs, sourceTabs],
  );
  activeViewSourceIdsRef.current = activeSavedView
    ? allRefreshTabs
        .filter((tab) => savedSources.some((source) => sameRoot(source, tab)))
        .map((tab) => tab.id)
    : [];
  const sourceTabKeys = JSON.stringify(
    workspace.tabs.map(({ id, connectionId, rootKey }) => [
      id,
      connectionId,
      rootKey,
    ]),
  );
  const viewSnapshots = useMemo(
    () =>
      Object.fromEntries(
        savedSources.map((source) => [
          source.id,
          snapshots[sourceTabId(source, workspace.tabs)],
        ]),
      ),
    [savedSources, snapshots, sourceTabKeys],
  );
  const savedResults = useMemo(
    () =>
      activeSavedView
        ? viewResults(
            activeSavedView,
            savedSources,
            viewSnapshots,
            currentUsers,
          )
        : [],
    [activeSavedView, savedSources, viewSnapshots, currentUsers],
  );
  const snapshot = activeTab ? snapshots[activeTab.id] : undefined;
  const nextTaskOpen = activeTab ? Boolean(nextTaskViews[activeTab.id]) : false;
  const nextTaskCriterion = activeTab
    ? (nextTaskCriteria[activeTab.id] ?? 'rank')
    : 'rank';
  const confirmedSnapshot = activeTab
    ? confirmedSnapshots[activeTab.id]
    : undefined;
  const activeSeenRoot = activeTab
    ? workspace.seenRoots?.[
        seenRootKey(activeTab.connectionId, activeTab.rootKey)
      ]
    : undefined;
  const unreadCount =
    confirmedSnapshot?.issues.filter((issue) => {
      const changes = unseenChanges(activeSeenRoot?.issues[issue.key], issue);
      return changes.fields.length > 0 || changes.comments > 0;
    }).length ?? 0;
  const markSeen = (issue: Issue) => {
    if (!activeTab) return;
    const rootKey = seenRootKey(activeTab.connectionId, activeTab.rootKey);
    setWorkspace((current) => {
      const root = current.seenRoots?.[rootKey];
      if (!root) return current;
      return {
        ...current,
        seenRoots: boundRoots({
          ...current.seenRoots,
          [rootKey]: markIssueSeen(root, issue, Date.now()),
        }),
      };
    });
  };
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
            [id]: `Couldn’t identify your account: ${String(error)}. Check your connection, then retry.`,
          }));
      });
    return () => {
      live = false;
    };
  }, [activeTab?.connectionId, identityRetry]);
  useEffect(() => {
    const requested = navigationReveal.current;
    navigationReveal.current = null;
    setReveal((current) => {
      const preserve =
        current &&
        current.tabId === activeTab?.id &&
        current.key === activeTab?.selectedKey &&
        requested?.tabId === current.tabId &&
        requested.key === current.key;
      return preserve ? current : null;
    });
  }, [activeTab?.id, query, activeTab?.filters, activeTab?.hideDone]);
  useEffect(() => {
    setReveal((current) =>
      current?.key === activeTab?.selectedKey ? current : null,
    );
  }, [activeTab?.selectedKey]);
  const activeConnection = connections.find(
    (item) => item.id === activeTab?.connectionId,
  );
  const storedView = activeTab ? rootView(workspace, activeTab) : DEFAULT_VIEW;
  const view =
    activeConnection?.provider === 'github'
      ? {
          ...storedView,
          columns: storedView.columns.filter((column) => column !== 'priority'),
          sort:
            storedView.sort.column === 'priority'
              ? { column: 'rank' as const, direction: 'asc' as const }
              : storedView.sort,
        }
      : storedView;
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
  const retryPriorityOrder = () =>
    setPriorityErrors((current) => {
      const next = { ...current };
      delete next[priorityCacheKey];
      return next;
    });
  useEffect(() => {
    if (
      !activeTab ||
      !snapshot ||
      (view.sort.column !== 'priority' &&
        !(nextTaskOpen && nextTaskCriterion === 'priority')) ||
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
    nextTaskOpen,
    nextTaskCriterion,
    priorityCacheKey,
    priorityOrder,
    priorityError,
  ]);
  const updateView = useCallback(
    (patch: Partial<RootView>) => {
      if (!activeTab) return;
      setWorkspace((current) => setRootView(current, activeTab, patch));
      if (patch.assumeMatchingStatusTransitions && snapshot)
        void pickers.prime(
          activeTab.connectionId,
          activeTab.rootKey,
          snapshot.issues,
        );
      if (patch.assumeMatchingStatusTransitions === false && snapshot)
        pickers.clearStatusChoices(activeTab.connectionId, snapshot.issues);
      setDragKey(null);
      setEditor(null);
    },
    [activeTab, snapshot, pickers],
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
    tabsRef.current = allRefreshTabs;
  }, [allRefreshTabs]);
  useEffect(() => {
    if (activeSavedView?.filters.assignee !== 'me') return;
    let live = true;
    const generation = identityGeneration.current;
    for (const id of new Set(
      savedSources.map((source) => source.connectionId),
    )) {
      if (currentUsers[id]) continue;
      void window.canopy
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
              [id]: `Couldn’t identify your account: ${String(error)}`,
            }));
        });
    }
    return () => {
      live = false;
    };
  }, [
    activeSavedView?.id,
    activeSavedView?.filters.assignee,
    savedSources,
    currentUsers,
    identityRetry,
  ]);
  useEffect(() => {
    setEditor(null);
    setDragKey(null);
    setPreviewKey(null);
    setRowMenu(null);
    pendingScrollRestore.current = activeTab?.id ?? null;
  }, [activeTab?.id]);

  useEffect(() => {
    if (activeTab?.selectedKey)
      setPreviewKey((current) =>
        current &&
        !(
          activeConnection?.provider === 'github' &&
          activeTab.selectedKey === activeTab.rootKey &&
          !activeTab.rootKey.includes('#')
        )
          ? activeTab.selectedKey!
          : null,
      );
  }, [activeTab?.selectedKey, activeTab?.rootKey, activeConnection?.provider]);
  const closePreview = useCallback(() => {
    setPreviewKey(null);
    restoreTreeFocus(activeTab?.selectedKey ?? activeTab?.rootKey);
  }, [activeTab?.selectedKey, activeTab?.rootKey, restoreTreeFocus]);
  useEffect(() => {
    if (
      !previewKey ||
      dialog ||
      workBrief ||
      childParent ||
      editor ||
      rowMenu ||
      tabMenu
    )
      return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        closePreview();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [
    previewKey,
    dialog,
    workBrief,
    childParent,
    editor,
    rowMenu,
    tabMenu,
    closePreview,
  ]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      document
        .querySelectorAll<HTMLDetailsElement>(
          '.view-settings[open], .tree-view-menu[open]',
        )
        .forEach((menu) => {
          if (!menu.contains(event.target as Node)) menu.open = false;
        });
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([
      window.canopy.connections(),
      window.canopy.loadWorkspace(),
      window.canopy.demoMode(),
    ])
      .then(([nextConnections, saved, isDemo]) => {
        if (!live) return;
        setDemoMode(isDemo);
        document.title = isDemo ? 'Canopy — Demo' : 'Canopy';
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
                  savedViews:
                    saved.savedViews ??
                    starterViews().map((view) => ({
                      ...view,
                      connectionIds: nextConnections.map(
                        (connection) => connection.id,
                      ),
                    })),
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
              : {
                  ...EMPTY_WORKSPACE,
                  savedViews: starterViews().map((view) => ({
                    ...view,
                    connectionIds: nextConnections.map(
                      (connection) => connection.id,
                    ),
                  })),
                },
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
    document.documentElement.dataset.theme =
      appearancePreview?.theme ?? workspace.theme;
    document.documentElement.dataset.palette =
      appearancePreview?.palette ?? workspace.palette ?? 'default';
  }, [workspace.theme, workspace.palette, appearancePreview]);

  const saveWorkspace = useCallback((value: Workspace) => {
    const save = pendingWorkspaceSave.current
      .catch(() => {})
      .then(() => window.canopy.saveWorkspace(value));
    pendingWorkspaceSave.current = save;
    return save;
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      workspaceSaveTimer.current = null;
      void saveWorkspace(workspace).catch((error) => {
        setErrors((value) => ({
          ...value,
          workspace: `Couldn’t save workspace: ${error instanceof Error ? error.message : String(error)}`,
        }));
      });
    }, 180);
    workspaceSaveTimer.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (workspaceSaveTimer.current === timer)
        workspaceSaveTimer.current = null;
    };
  }, [workspace, ready, saveWorkspace]);

  const refreshTab = useCallback(
    async (tab: TabState, quiet = false, explicit = false) => {
      if (!tabsRef.current.some((item) => item.id === tab.id)) return;
      explicit ||= forcedRefreshes.current.has(tab.id);
      if (
        (!navigator.onLine && !demoMode) ||
        refreshBlocked.current(tab.connectionId)
      ) {
        if (explicit) forcedRefreshes.current.add(tab.id);
        deferredRefreshes.current.add(tab.id);
        return;
      }
      if ((cooldowns.current[tab.connectionId] ?? 0) > Date.now()) return;
      if (!refreshSchedule.current.begin(tab.id, Date.now(), explicit)) {
        if (explicit && !runningExplicitRefreshes.current.has(tab.id)) {
          forcedRefreshes.current.add(tab.id);
          deferredRefreshes.current.add(tab.id);
        }
        return;
      }
      const rootKey = refreshRootKey(tab);
      const load = rootRefreshes.current.load(
        rootKey,
        explicit,
        !snapshotsRef.current[tab.id],
        () => window.canopy.tree(tab.connectionId, tab.rootKey),
      );
      if ('due' in load) {
        refreshSchedule.current.defer(tab.id, load.due);
        return;
      }
      deferredRefreshes.current.delete(tab.id);
      forcedRefreshes.current.delete(tab.id);
      const sequence = (refreshSequences.current[tab.id] ?? 0) + 1;
      refreshSequences.current[tab.id] = sequence;
      if (explicit) runningExplicitRefreshes.current.set(tab.id, sequence);
      const epoch = mutations.beginRefresh();
      const setter = quiet ? setRefreshing : setLoading;
      setter((current) => new Set(current).add(tab.id));
      try {
        const next = await load.promise;
        const targets = load.started
          ? tabsRef.current.filter((item) => refreshRootKey(item) === rootKey)
          : [tab];
        if (
          rootRefreshes.current.isCurrent(rootKey, load.generation) &&
          !refreshBlocked.current(tab.connectionId) &&
          connectionsRef.current.find((item) => item.id === tab.connectionId)
            ?.provider === 'jira' &&
          targets.some(
            (target) =>
              !target.id.startsWith('saved-view:') &&
              rootView(workspaceRef.current, target)
                .assumeMatchingStatusTransitions,
          )
        )
          await pickers.prime(tab.connectionId, tab.rootKey, next.issues);
        const delivered = new Set<string>();
        if (
          rootRefreshes.current.isCurrent(rootKey, load.generation) &&
          !refreshBlocked.current(tab.connectionId)
        ) {
          for (const target of targets) {
            if (
              !tabsRef.current.some((item) => item.id === target.id) ||
              (target.id === tab.id &&
                refreshSequences.current[tab.id] !== sequence)
            )
              continue;
            mutations.receive(target, next, epoch);
            delivered.add(target.id);
          }
          if (delivered.size) {
            const confirmed =
              mutations.confirmedSnapshot(delivered.values().next().value!) ??
              next;
            setWorkspace((current) => {
              const seenKey = seenRootKey(tab.connectionId, tab.rootKey);
              return {
                ...current,
                seenRoots: boundRoots({
                  ...current.seenRoots,
                  [seenKey]: seedOrExtend(
                    current.seenRoots?.[seenKey],
                    confirmed,
                  ),
                }),
              };
            });
          }
        } else if (refreshSequences.current[tab.id] === sequence) {
          deferredRefreshes.current.add(tab.id);
        }
        if (!delivered.size) return;
        setConnectionErrors((current) => {
          const copy = new Set(current);
          for (const id of delivered) copy.delete(id);
          return copy;
        });
        setErrors((current) => {
          const copy = { ...current };
          for (const id of delivered) delete copy[id];
          return copy;
        });
      } catch (error) {
        if (
          refreshSequences.current[tab.id] !== sequence ||
          !rootRefreshes.current.isCurrent(rootKey, load.generation)
        )
          return;
        const status = await window.canopy
          .syncStatus(tab.connectionId)
          .catch(() => null);
        if (refreshSequences.current[tab.id] !== sequence) return;
        if (status?.retryAt) {
          cooldowns.current[tab.connectionId] = status.retryAt;
          setCooldownTimes({ ...cooldowns.current });
        }
        setConnectionErrors((current) => new Set(current).add(tab.id));
        setErrors((current) => ({
          ...current,
          [tab.id]: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        mutations.endRefresh(epoch);
        if (runningExplicitRefreshes.current.get(tab.id) === sequence)
          runningExplicitRefreshes.current.delete(tab.id);
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
    [demoMode],
  );

  const finishWorkflowReturn = useCallback(() => {
    const pending = workflowReturn.current;
    if (!pending?.opened || !pending.returned) return false;
    workflowReturn.current = null;
    const tab = tabsRef.current.find(
      (tab) =>
        tab.id === pending.tabId && tab.connectionId === pending.connectionId,
    );
    if (!tab) return false;
    pickers.revalidateStatus(pending.connectionId, pending.key);
    void window.canopy
      .invalidateChoices(pending.connectionId, pending.key)
      .catch((error) => {
        if (
          !tabsRef.current.some(
            (item) =>
              item.id === tab.id && item.connectionId === tab.connectionId,
          )
        )
          return;
        setErrors((current) => ({
          ...current,
          app: `Couldn’t refresh issue choices: ${String(error)}`,
        }));
      });
    // Enqueue before attempting: an older in-flight response cannot consume this return.
    deferredRefreshes.current.add(tab.id);
    forcedRefreshes.current.add(tab.id);
    void refreshTab(tab, true, true);
    return true;
  }, [pickers, refreshTab]);

  useEffect(() => {
    if (!ready) return;
    rootRefreshes.current.retain(allRefreshTabs.map(refreshRootKey));
    const activated = refreshSchedule.current.sync(
      allRefreshTabs.map((tab) => tab.id),
      foreground
        ? activeSavedView
          ? allRefreshTabs
              .filter((tab) =>
                savedSources.some((source) => sameRoot(source, tab)),
              )
              .map((tab) => tab.id)
          : workspace.activeTabId
        : null,
      Date.now(),
    );
    for (const tab of [...allRefreshTabs].sort(
      (a, b) =>
        Number(b.id === workspace.activeTabId) -
        Number(a.id === workspace.activeTabId),
    )) {
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
    allRefreshTabs,
    activeSavedView?.id,
    savedSources,
    foreground,
    snapshots,
    refreshTab,
  ]);

  useEffect(() => {
    if (!ready) return;
    const tick = () => {
      const now = Date.now();
      const recovered = new Set<string>();
      for (const [id, retryAt] of Object.entries(cooldowns.current)) {
        if (retryAt <= now) {
          delete cooldowns.current[id];
          recovered.add(id);
        }
      }
      if (Object.keys(cooldowns.current).length || recovered.size)
        setSyncNow(now);
      if (recovered.size) setCooldownTimes({ ...cooldowns.current });
      if (!navigator.onLine && !demoMode) return;
      const due = new Set(refreshSchedule.current.due(Date.now()));
      for (const tab of [...tabsRef.current].sort(
        (a, b) =>
          Number(b.id === activeIdRef.current) -
          Number(a.id === activeIdRef.current),
      )) {
        const activeRecovery =
          tab.id === activeIdRef.current && recovered.has(tab.connectionId);
        if (
          due.has(tab.id) ||
          deferredRefreshes.current.has(tab.id) ||
          activeRecovery
        )
          void refreshTab(tab, true, activeRecovery);
      }
    };
    const timer = window.setInterval(tick, 1000);
    const refreshActive = () => {
      for (const tab of tabsRef.current.filter((item) =>
        activeViewSourceIdsRef.current.length
          ? activeViewSourceIdsRef.current.includes(item.id)
          : item.id === activeIdRef.current,
      ))
        void refreshTab(tab, true);
    };
    const visibility = () => {
      const visible =
        document.visibilityState === 'visible' && document.hasFocus();
      setForeground(visible);
      const pending = workflowReturn.current;
      if (pending) {
        if (!visible) pending.left = true;
        else if (pending.left) pending.returned = true;
      }
      if (visible && !finishWorkflowReturn()) refreshActive();
    };
    const blur = () => {
      if (workflowReturn.current) workflowReturn.current.left = true;
      setForeground(false);
    };
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
  }, [ready, refreshTab, finishWorkflowReturn, demoMode]);

  useEffect(() => {
    for (const tab of allRefreshTabs) {
      if (deferredRefreshes.current.has(tab.id)) void refreshTab(tab, true);
    }
  }, [editor, saving, online, allRefreshTabs, refreshTab]);

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
    setWorkspace((value) => ({
      ...activateTab(value, tab, restoring),
      activeSavedViewId: null,
    }));
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
      const key =
        connections.find((item) => item.id === connectionId)?.provider ===
        'github'
          ? rootKey.toLowerCase()
          : rootKey.toUpperCase();
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
    [navigate, connections],
  );
  const openSavedResult = useCallback(
    (result: { issue: Issue; source: RootReference }) => {
      const current = workspaceRef.current;
      const existing = current.tabs.find((tab) => sameRoot(tab, result.source));
      const source = savedSources.find((item) => sameRoot(item, result.source));
      const snapshot = source ? viewSnapshots[source.id] : undefined;
      const expanded = snapshot
        ? ancestorPath(
            buildIssueTree(snapshot.issues, source!.rootKey),
            result.issue.key,
          ).map((node) => node.issue.key)
        : [result.source.rootKey];
      const savedRootView = rootView(current, result.source);
      const tab: TabState = existing ?? {
        id: crypto.randomUUID(),
        connectionId: result.source.connectionId,
        rootKey: result.source.rootKey,
        expanded: [],
        hideDone: savedRootView.hideDone,
        filters: savedRootView.filters,
        scrollTop: 0,
      };
      const next = {
        ...tab,
        selectedKey: result.issue.key,
        focusKey: undefined,
        expanded: [...new Set([...tab.expanded, ...expanded])],
      };
      navigate(next);
      navigationReveal.current = { tabId: next.id, key: result.issue.key };
      setReveal({ tabId: next.id, key: result.issue.key });
    },
    [navigate, savedSources, viewSnapshots],
  );

  const forgetTabs = useCallback(
    (ids: string[]) => {
      for (const tab of workspaceRef.current.tabs.filter((item) =>
        ids.includes(item.id),
      )) {
        if (
          !tabsRef.current.some(
            (other) =>
              !ids.includes(other.id) &&
              refreshRootKey(other) === refreshRootKey(tab),
          )
        )
          rootRefreshes.current.forget(refreshRootKey(tab));
      }
      for (const id of ids) {
        mutations.forget(id);
        displayedTrees.current.delete(id);
        attemptedLoads.current.delete(id);
        refreshSequences.current[id] = (refreshSequences.current[id] ?? 0) + 1;
        refreshSchedule.current.forget(id);
        deferredRefreshes.current.delete(id);
        forcedRefreshes.current.delete(id);
        runningExplicitRefreshes.current.delete(id);
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

  useEffect(() => {
    const virtualTabs = new Map(
      allRefreshTabs
        .filter((tab) => tab.id.startsWith('saved-view:'))
        .map((tab) => [tab.id, tab] as const),
    );
    const removed = [...previousVirtualTabs.current.values()].filter(
      (tab) => !virtualTabs.has(tab.id),
    );
    previousVirtualTabs.current = virtualTabs;
    if (!removed.length) return;
    for (const tab of removed)
      if (
        !allRefreshTabs.some(
          (item) => refreshRootKey(item) === refreshRootKey(tab),
        )
      )
        rootRefreshes.current.forget(refreshRootKey(tab));
    forgetTabs(removed.map((tab) => tab.id));
  }, [allRefreshTabs, forgetTabs]);

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
    setWorkspace({ ...next, activeSavedViewId: null });
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
        event.preventDefault();
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

  const openWorkflow = useCallback(
    async (key: string) => {
      if (!activeTab) return;
      const pending = {
        tabId: activeTab.id,
        connectionId: activeTab.connectionId,
        key,
        left: false,
        returned: false,
        opened: false,
      };
      workflowReturn.current = pending;
      setEditor(null);
      restoreTreeFocus(key);
      try {
        await window.canopy.openIssue(pending.connectionId, key);
        if (workflowReturn.current !== pending) return;
        if (
          !tabsRef.current.some(
            (tab) =>
              tab.id === pending.tabId &&
              tab.connectionId === pending.connectionId,
          )
        ) {
          workflowReturn.current = null;
          return;
        }
        pending.opened = true;
        setErrors((current) => {
          const copy = { ...current };
          delete copy.app;
          return copy;
        });
        finishWorkflowReturn();
      } catch (error) {
        if (workflowReturn.current !== pending) return;
        workflowReturn.current = null;
        if (
          !tabsRef.current.some(
            (tab) =>
              tab.id === pending.tabId &&
              tab.connectionId === pending.connectionId,
          )
        )
          return;
        setErrors((current) => ({
          ...current,
          app: `Couldn’t open ${key}: ${error instanceof Error ? error.message : String(error)}`,
        }));
      }
    },
    [activeTab, restoreTreeFocus, finishWorkflowReturn],
  );

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

  const copyIssueText = useCallback(
    async (issue: Issue, action: 'key' | 'title' | 'key-summary') => {
      const value =
        action === 'key'
          ? issue.key
          : action === 'title'
            ? issue.summary
            : issueKeyAndSummary(issue);
      try {
        await window.canopy.copyText(value);
      } catch (error) {
        setErrors((current) => ({
          ...current,
          app: `Couldn’t copy ${action}: ${error instanceof Error ? error.message : String(error)}`,
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
      if (workBrief) return;
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
      if (appearanceSaving.current) {
        event.preventDefault();
        return;
      }
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
    workBrief,
    childParent,
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
        void pickers.open(
          activeTab.connectionId,
          key,
          field,
          activeTab.rootKey,
          activeConnection?.provider === 'jira' &&
            view.assumeMatchingStatusTransitions,
          snapshot?.issues.find((issue) => issue.key === key),
        );
    },
    [
      activeTab,
      activeConnection?.provider,
      view.assumeMatchingStatusTransitions,
      snapshot,
      pickers,
    ],
  );

  useEffect(() => {
    if (!editor || editor.field === 'summary') return;
    const dismiss = (event: PointerEvent) => {
      const activeCell = document.querySelector('.field-cell.editing');
      if (activeCell && !activeCell.contains(event.target as Node))
        setEditor(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [editor]);

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
        workBrief ||
        childParent ||
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
  }, [mutations, undoState.label, dialog, workBrief, childParent]);

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
  const tasks = useMemo(
    () =>
      snapshot
        ? nextTasks(
            snapshot,
            activeConnection?.provider ?? 'jira',
            nextTaskCriterion,
            activeTab ? currentUsers[activeTab.connectionId]?.id : undefined,
            activeTab ? Boolean(nextTaskMine[activeTab.id]) : false,
            priorityOrder,
          )
        : [],
    [
      snapshot,
      activeConnection?.provider,
      nextTaskCriterion,
      activeTab?.id,
      activeTab?.connectionId,
      currentUsers,
      nextTaskMine,
      priorityOrder,
    ],
  );
  const jumpToTask = (key: string) => {
    if (!activeTab || !tree) return;
    const path = ancestorPath(tree, key);
    if (!path.length) return;
    updateTab(activeTab.id, {
      selectedKey: key,
      focusKey: undefined,
      expanded: [
        ...new Set([
          ...activeTab.expanded,
          ...path.map((node) => node.issue.key),
        ]),
      ],
    });
    setReveal({ tabId: activeTab.id, key });
  };
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
      editor ||
      reveal.preserveScroll
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
    if (
      !reveal ||
      reveal === focusedReveal.current ||
      reveal.tabId !== activeTab?.id ||
      editor
    )
      return;
    const target = document.querySelector<HTMLElement>(
      `[data-tree-key="${reveal.key}"]`,
    );
    if (target) {
      target.focus({ preventScroll: true });
      focusedReveal.current = reveal;
    }
  }, [reveal, activeTab?.id, snapshot]);
  const flat = useMemo(
    () => flattenVisible(shownTree, expandedSet),
    [shownTree, expandedSet],
  );
  const visibleKeys = useMemo(
    () => new Set(flat.map((node) => node.issue.key)),
    [flat],
  );
  const selectedKeys =
    activeTab && multiSelection?.tabId === activeTab.id
      ? new Set(multiSelection.keys.filter((key) => visibleKeys.has(key)))
      : new Set<string>();
  const bulkIssues = useMemo(() => {
    if (!activeTab || !snapshot || multiSelection?.tabId !== activeTab.id)
      return [];
    const byKey = new Map(snapshot.issues.map((issue) => [issue.key, issue]));
    return multiSelection.keys
      .filter((key) => visibleKeys.has(key))
      .map((key) => byKey.get(key))
      .filter(
        (issue): issue is Issue =>
          Boolean(issue) && issue?.type !== 'Repository',
      );
  }, [activeTab?.id, snapshot, multiSelection, visibleKeys]);
  const selectMultiple = (key: string, range: boolean, toggle: boolean) => {
    if (!activeTab) return;
    const previous =
      multiSelection?.tabId === activeTab.id ? multiSelection : null;
    const anchor = previous?.anchor ?? activeTab.selectedKey ?? key;
    let keys: string[];
    if (range) {
      const start = flat.findIndex((node) => node.issue.key === anchor);
      const end = flat.findIndex((node) => node.issue.key === key);
      keys =
        start < 0 || end < 0
          ? [key]
          : flat
              .slice(Math.min(start, end), Math.max(start, end) + 1)
              .map((node) => node.issue.key);
    } else if (toggle) {
      const current = new Set(
        previous?.keys ??
          (activeTab.selectedKey ? [activeTab.selectedKey] : []),
      );
      if (current.has(key)) current.delete(key);
      else current.add(key);
      keys = [...current];
    } else keys = [key];
    setMultiSelection(
      keys.length > 1
        ? { tabId: activeTab.id, keys, anchor: range ? anchor : key }
        : null,
    );
    updateTab(activeTab.id, {
      selectedKey: keys.includes(key) ? key : keys.at(-1),
    });
  };

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

  const focusTreeNeighbor = (
    key: string,
    direction: -1 | 1,
    extend = false,
  ) => {
    const index = flat.findIndex((node) => node.issue.key === key);
    const target = flat[index + direction];
    if (target) {
      if (extend) {
        suppressTreeFocus.current = true;
        selectMultiple(target.issue.key, true, false);
      } else setMultiSelection(null);
      document
        .querySelector<HTMLElement>(`[data-tree-key="${target.issue.key}"]`)
        ?.focus();
      suppressTreeFocus.current = false;
    }
  };

  const launchDemo = () =>
    void window.canopy.launchDemo().catch((error: unknown) =>
      setErrors((current) => ({
        ...current,
        app: `Couldn’t open demo: ${error instanceof Error ? error.message : String(error)}`,
      })),
    );

  useEffect(() => {
    if (
      !demoMode ||
      !ready ||
      !snapshots['demo-can-100'] ||
      tourStarted.current
    )
      return;
    tourStarted.current = true;
    const requestedStep = Number(
      sessionStorage.getItem('canopy-demo-step') ?? 0,
    );
    const startStep = Number.isInteger(requestedStep)
      ? Math.max(0, Math.min(7, requestedStep))
      : 0;
    const startPaused = sessionStorage.getItem('canopy-demo-paused') === 'true';
    sessionStorage.removeItem('canopy-demo-step');
    sessionStorage.removeItem('canopy-demo-paused');
    const controller = new AbortController();
    const signal = controller.signal;
    let finished = false;
    let currentStep = 0;
    let navigating = false;
    let restoreWork: Promise<void> | null = null;
    const priorityToken = Symbol('demo priority edit');
    let priorityWork: Promise<unknown> = Promise.resolve();
    let priorityEditStarted = false;
    const restorePriority = async () => {
      if (!priorityEditStarted) return;
      await priorityWork;
      mutations.discardHistory(priorityToken);
      await mutations.update(
        'demo',
        'CAN-111',
        { priorityId: '2' },
        undefined,
        false,
        undefined,
        (issue) => issue?.priority?.id === '1',
      );
    };
    signal.addEventListener('abort', () => {
      restoreWork = restorePriority().catch((error) =>
        console.error('Could not restore demo priority:', error),
      );
    });
    let paused = false;
    let pausedAt = 0;
    let totalPaused = 0;
    let resume: (() => void) | null = null;
    let resumeGate: Promise<void> | null = null;
    let stepElapsed = 0;
    let stepDuration = 1;
    let highlighted: HTMLElement | null = null;
    const activeNow = () =>
      performance.now() -
      totalPaused -
      (paused ? performance.now() - pausedAt : 0);
    const waitUntilPlaying = async () => {
      if (resumeGate) await resumeGate;
      signal.throwIfAborted();
    };
    const setProgress = (elapsed: number) => {
      if (tourProgressRef.current)
        tourProgressRef.current.value = Math.min(
          100,
          (100 * elapsed) / stepDuration,
        );
    };
    const delay = async (ms: number, count = true) => {
      if (currentStep < startStep && count) return;
      const start = activeNow();
      const before = stepElapsed;
      while (activeNow() - start < ms) {
        await waitUntilPlaying();
        if (count) setProgress(before + activeNow() - start);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      }
      await waitUntilPlaying();
      if (count) {
        stepElapsed = before + ms;
        setProgress(stepElapsed);
      }
    };
    const clearHighlight = () => {
      highlighted?.classList.remove('demo-target-highlight');
      highlighted = null;
    };
    const highlight = (target: HTMLElement | null, label: string) => {
      clearHighlight();
      if (currentStep < startStep) return;
      if (!target) throw new Error(`${label} did not appear.`);
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      target.classList.add('demo-target-highlight');
      highlighted = target;
    };
    const togglePause = () => {
      if (finished || signal.aborted) return;
      if (paused) {
        paused = false;
        totalPaused += performance.now() - pausedAt;
        resume?.();
        resume = null;
        resumeGate = null;
        setTour((current) =>
          current?.phase === 'paused'
            ? { ...current, phase: 'playing' }
            : current,
        );
      } else {
        paused = true;
        pausedAt = performance.now();
        resumeGate = new Promise<void>((resolve) => {
          resume = resolve;
        });
        setTour((current) =>
          current?.phase === 'playing'
            ? { ...current, phase: 'paused' }
            : current,
        );
      }
    };
    toggleTourPauseRef.current = togglePause;
    signal.addEventListener('abort', () => resume?.());
    const waitFor = async (check: () => boolean, label: string) => {
      const deadline = activeNow() + 8000;
      while (!check()) {
        await waitUntilPlaying();
        if (activeNow() > deadline) throw new Error(`${label} did not appear.`);
        await delay(100, false);
      }
      await waitUntilPlaying();
    };
    const row = (key: string) =>
      document.querySelector<HTMLElement>(`[data-tree-key="${key}"]`);
    const show = (step: number, caption: string, duration: number) => {
      currentStep = step;
      clearHighlight();
      stepElapsed = 0;
      stepDuration = duration;
      setProgress(0);
      if (step < startStep) return;
      if (step === startStep && startPaused) {
        paused = true;
        pausedAt = performance.now();
        resumeGate = new Promise<void>((resolve) => {
          resume = resolve;
        });
      }
      setTour({ phase: paused ? 'paused' : 'playing', step, caption });
    };
    const stop = (manual = false, target?: EventTarget | null) => {
      if (finished || signal.aborted) return;
      controller.abort(new Error('Demo stopped.'));
      finished = true;
      clearHighlight();
      if (
        tourEditor.current &&
        !(target instanceof Element && target.closest('.priority-editor'))
      ) {
        setEditor(null);
        tourEditor.current = false;
      }
      setTour({
        phase: 'stopped',
        step: 0,
        caption: manual
          ? 'Playback stopped because you took control. Explore the sample workspace freely.'
          : 'Playback stopped. Explore the sample workspace freely.',
      });
    };
    stopTourRef.current = () => stop();
    const seek = async (step: number, keepPaused = paused) => {
      if (navigating || step < 0 || step > 7) return;
      navigating = true;
      try {
        stop();
        if (restoreWork) await restoreWork;
        sessionStorage.setItem('canopy-demo-step', String(step));
        sessionStorage.setItem('canopy-demo-paused', String(keepPaused));
        await window.canopy.resetDemo();
      } catch (error) {
        navigating = false;
        sessionStorage.removeItem('canopy-demo-step');
        sessionStorage.removeItem('canopy-demo-paused');
        throw error;
      }
    };
    seekTourRef.current = (step, keepPaused) => {
      void seek(step, keepPaused).catch((error: unknown) =>
        setTour({
          phase: 'failed',
          step: 0,
          caption: `Couldn’t reset the demo: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    };
    const manual = (event: Event) => {
      if (
        signal.aborted ||
        finished ||
        !event.isTrusted ||
        !(event.target instanceof Element)
      )
        return;
      if (
        event instanceof KeyboardEvent &&
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) &&
        !event.target.closest('[contenteditable="true"]')
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        seekTourRef.current?.(
          currentStep + (event.key === 'ArrowRight' ? 1 : -1),
        );
        return;
      }
      if (event.target.closest('.demo-tour')) return;
      stop(true, event.target);
    };
    for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
      document.addEventListener(name, manual, true);
    const run = async () => {
      try {
        show(
          0,
          'This is a local sample workspace. We’ll follow one issue tree, then leave it ready for you.',
          6000,
        );
        highlight(
          document.querySelector('[aria-label="CAN-100 issue tree"]'),
          'Sample tree',
        );
        await delay(6000);
        show(
          1,
          'Expand CAN-100 to see stories, tasks, and an unfinished descendant.',
          6000,
        );
        highlight(
          document.querySelector('[aria-label="Expand CAN-100"]'),
          'Expand CAN-100',
        );
        await delay(2000);
        updateTab('demo-can-100', {
          expanded: ['CAN-100', 'CAN-106', 'CAN-107'],
        });
        await waitFor(() => Boolean(row('CAN-108')), 'CAN-108');
        row('CAN-108')?.scrollIntoView({ block: 'center' });
        highlight(row('CAN-108'), 'Expanded issue');
        await delay(4000);

        show(
          2,
          'Hide done narrows the tree. Turning it off restores the full hierarchy.',
          8000,
        );
        highlight(document.querySelector('.toolbar .checkbox'), 'Hide done');
        await delay(2000);
        updateTab('demo-can-100', { hideDone: true });
        await waitFor(() => !row('CAN-113'), 'Filtered tree');
        highlight(
          document.querySelector('[aria-label="CAN-100 issue tree"]'),
          'Filtered tree',
        );
        await delay(2000);
        highlight(document.querySelector('.toolbar .checkbox'), 'Hide done');
        await delay(2000);
        updateTab('demo-can-100', { hideDone: false });
        await waitFor(() => Boolean(row('CAN-113')), 'Restored tree');
        highlight(row('CAN-113'), 'Restored issue');
        await delay(2000);

        show(
          3,
          'Preview CAN-108 for its description, comment, and related work.',
          6000,
        );
        highlight(row('CAN-108'), 'CAN-108');
        await delay(2000);
        setPreviewKey('CAN-108');
        await waitFor(
          () =>
            Boolean(
              document.querySelector('[aria-label="Preview CAN-108"] h2'),
            ),
          'CAN-108 preview',
        );
        highlight(
          document.querySelector('[aria-label="Preview CAN-108"]'),
          'CAN-108 preview',
        );
        await delay(4000);

        show(4, 'The linked CAN-200 issue opens in a separate tab.', 6000);
        highlight(
          Array.from(document.querySelectorAll<HTMLElement>('.preview-link'))
            .find((link) => link.textContent?.includes('CAN-200'))
            ?.querySelector<HTMLElement>('button.tool-button') ?? null,
          'Open CAN-200',
        );
        await delay(2000);
        openTab('demo', 'CAN-200');
        await waitFor(
          () =>
            Boolean(
              document.querySelector(
                '[role="tree"][aria-label="CAN-200 issue tree"]',
              ),
            ),
          'CAN-200 tree',
        );
        highlight(
          Array.from(
            document.querySelectorAll<HTMLElement>('[role="tab"]'),
          ).find((tab) => tab.textContent?.includes('CAN-200')) ?? null,
          'CAN-200 tab',
        );
        await delay(4000);

        show(5, 'Return to CAN-100 without losing its place.', 6000);
        highlight(
          document.querySelector('[data-tab-id="demo-can-100"]'),
          'CAN-100 tab',
        );
        await delay(2000);
        selectTab('demo-can-100');
        await waitFor(() => Boolean(row('CAN-108')), 'CAN-100 tree');
        updateTab('demo-can-100', { expanded: ['CAN-100', 'CAN-110'] });
        await waitFor(() => Boolean(row('CAN-111')), 'CAN-111');
        row('CAN-111')?.scrollIntoView({ block: 'center' });
        highlight(row('CAN-111'), 'CAN-111 issue');
        await delay(4000);

        show(6, 'Raise CAN-111’s priority, then use Undo to restore it.', 9000);
        highlight(
          document.querySelector('[aria-label="Edit priority for CAN-111"]'),
          'CAN-111 priority',
        );
        await delay(2000);
        setEditor({ connectionId: 'demo', key: 'CAN-111', field: 'priority' });
        tourEditor.current = true;
        await pickers.open('demo', 'CAN-111', 'priority');
        await waitFor(
          () =>
            Boolean(row('CAN-111')?.querySelector('.priority-editor select')),
          'Priority editor',
        );
        highlight(
          row('CAN-111')?.querySelector('.priority-editor select') ?? null,
          'Priority editor',
        );
        await delay(1500);
        setEditor(null);
        tourEditor.current = false;
        highlight(row('CAN-111'), 'CAN-111 priority');
        const choices = await window.canopy.priorities('demo', 'CAN-111');
        signal.throwIfAborted();
        priorityEditStarted = true;
        priorityWork = mutations.update(
          'demo',
          'CAN-111',
          { priorityId: '1' },
          { priorities: choices },
          true,
          priorityToken,
        );
        if (!(await priorityWork)) throw new Error('The priority edit failed.');
        await waitFor(
          () =>
            row('CAN-111')?.querySelector('.priority')?.textContent ===
            'Highest',
          'Updated priority',
        );
        await delay(2000);
        highlight(
          document.querySelector('.undo-banner button'),
          'Undo priority edit',
        );
        await delay(1500);
        priorityWork = mutations.undo();
        await priorityWork;
        signal.throwIfAborted();
        await waitFor(
          () =>
            row('CAN-111')?.querySelector('.priority')?.textContent === 'High',
          'Restored priority',
        );
        highlight(row('CAN-111'), 'Restored priority');
        await delay(2000);

        show(
          7,
          'Move CAN-112 above its sibling CAN-111. You can keep editing after the tour.',
          6000,
        );
        highlight(
          document.querySelector('[aria-label^="Reorder CAN-112"]'),
          'Reorder CAN-112',
        );
        await delay(2000);
        if (!(await mutations.rank('demo', 'CAN-112', 'CAN-111')))
          throw new Error('The sibling reorder failed.');
        signal.throwIfAborted();
        await waitFor(() => {
          const first = row('CAN-112')?.getBoundingClientRect().top;
          const second = row('CAN-111')?.getBoundingClientRect().top;
          return first !== undefined && second !== undefined && first < second;
        }, 'Reordered siblings');
        highlight(row('CAN-112'), 'Reordered issue');
        await delay(4000);
        signal.throwIfAborted();
        clearHighlight();
        setPreviewKey(null);
        setEditor(null);
        setDialog(null);
        finished = true;
        setTour({
          phase: 'complete',
          step: 7,
          caption: 'Tour complete. The sample tree is yours to explore.',
        });
      } catch (error) {
        if (signal.aborted) return;
        finished = true;
        setEditor(null);
        setDialog(null);
        setTour({
          phase: 'failed',
          step: 0,
          caption: `The tour stopped: ${error instanceof Error ? error.message : String(error)} The sample workspace is still available.`,
        });
      }
    };
    void run();
    return () => {
      controller.abort();
      stopTourRef.current = null;
      seekTourRef.current = null;
      toggleTourPauseRef.current = null;
      clearHighlight();
      for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
        document.removeEventListener(name, manual, true);
    };
  }, [demoMode, ready, Boolean(snapshots['demo-can-100'])]);

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
          <div className="side-heading">
            <span>SAVED VIEWS</span>
            <button
              className="icon-button"
              aria-label="Create saved view"
              onClick={() => {
                const id = crypto.randomUUID();
                const view: SavedIssueView = {
                  id,
                  name: 'New view',
                  roots: [],
                  connectionIds: [],
                  filters: {
                    assignee: 'any',
                    statuses: [],
                    priority: '',
                    hideDone: true,
                  },
                  sort: { column: 'key', direction: 'asc' },
                };
                setWorkspace((current) => ({
                  ...current,
                  savedViews: [...(current.savedViews ?? []), view],
                  activeSavedViewId: id,
                }));
              }}
            >
              <Plus size={15} />
            </button>
          </div>
          <nav className="side-tabs" aria-label="Saved views">
            {(workspace.savedViews ?? []).map((item) => (
              <button
                key={item.id}
                aria-label={`Saved view: ${item.name}`}
                className={cx(
                  'side-tab',
                  item.id === activeSavedView?.id && 'active',
                )}
                onClick={() => {
                  setSelectedViewIssue(null);
                  setWorkspace((current) => ({
                    ...current,
                    activeSavedViewId: item.id,
                  }));
                }}
              >
                <span>
                  <b>{item.name}</b>
                </span>
              </button>
            ))}
          </nav>
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
            demoMode={demoMode}
            setConnections={(nextConnections) => {
              setConnections(nextConnections);
              const removed = connections.filter(
                (item) => !nextConnections.some((next) => next.id === item.id),
              );
              for (const connection of removed)
                delete cooldowns.current[connection.id];
              setCooldownTimes({ ...cooldowns.current });
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
          onClick={() => setDialog('appearance')}
        >
          <Settings2 size={16} />
          <span>Appearance</span>
        </button>
        <button
          className="sidebar-settings"
          onClick={() => setDialog('shortcuts')}
        >
          <Keyboard size={16} />
          <span>Keyboard shortcuts</span>
        </button>
        {!demoMode && (
          <button className="sidebar-settings" onClick={launchDemo}>
            <CircleDot size={16} />
            <span>Try demo</span>
          </button>
        )}
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

        {activeSavedView && (
          <SavedViewsPanel
            view={activeSavedView}
            connections={connections}
            availableRoots={availableRoots}
            sources={savedSources}
            results={savedResults}
            selected={selectedViewIssue}
            errors={Object.fromEntries(
              savedSources
                .map((source) => [
                  source.id,
                  errors[sourceTabId(source, workspace.tabs)],
                ])
                .filter(([, error]) => error),
            )}
            workspaceError={errors.workspace}
            appError={errors.app}
            identityErrors={identityErrors}
            loading={
              new Set(
                savedSources
                  .filter((source) =>
                    loading.has(sourceTabId(source, workspace.tabs)),
                  )
                  .map((source) => source.id),
              )
            }
            onSelect={setSelectedViewIssue}
            onOpen={openSavedResult}
            onChange={(view) =>
              setWorkspace((current) => ({
                ...current,
                savedViews: current.savedViews?.map((item) =>
                  item.id === view.id ? view : item,
                ),
              }))
            }
            onDelete={() =>
              setWorkspace((current) => ({
                ...current,
                savedViews: current.savedViews?.filter(
                  (item) => item.id !== activeSavedView.id,
                ),
                activeSavedViewId: null,
              }))
            }
            onRefresh={() => {
              setIdentityRetry((value) => value + 1);
              for (const source of savedSources) {
                const tab = allRefreshTabs.find((item) =>
                  sameRoot(item, source),
                );
                if (tab) void refreshTab(tab, true, true);
              }
            }}
          />
        )}
        {activeTab && !activeSavedView && (
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
                <button
                  className={cx('tool-button', nextTaskOpen && 'active')}
                  aria-pressed={nextTaskOpen}
                  onClick={() =>
                    setNextTaskViews((current) => ({
                      ...current,
                      [activeTab.id]: !current[activeTab.id],
                    }))
                  }
                >
                  Next tasks
                </button>
                <ViewSettings
                  view={view}
                  provider={activeConnection?.provider}
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
                  <span>
                    {activeConnection?.provider === 'github'
                      ? 'Hide closed'
                      : 'Hide done'}
                  </span>
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
                  disabled={
                    refreshing.has(activeTab.id) ||
                    (cooldownTimes[activeTab.connectionId] ?? 0) > syncNow
                  }
                  onClick={() => void refreshTab(activeTab, true, true)}
                  title="Refresh"
                >
                  <RefreshCw
                    className={cx(refreshing.has(activeTab.id) && 'spin')}
                    size={16}
                  />
                </button>
                {unreadCount > 0 && confirmedSnapshot && (
                  <button
                    className="tool-button"
                    onClick={() => {
                      const rootKey = seenRootKey(
                        activeTab.connectionId,
                        activeTab.rootKey,
                      );
                      setWorkspace((current) => ({
                        ...current,
                        seenRoots: boundRoots({
                          ...current.seenRoots,
                          [rootKey]: markRootSeen(
                            confirmedSnapshot,
                            current.seenRoots?.[rootKey],
                          ),
                        }),
                      }));
                    }}
                  >
                    Mark root seen ({unreadCount})
                  </button>
                )}
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
              {activeConnection?.provider !== 'github' && (
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
              )}
              <details
                className="tree-view-menu"
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector('summary')?.focus();
                }}
              >
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
              errors.app ||
              (cooldownTimes[activeTab.connectionId] ?? 0) > syncNow) && (
              <div className="error-banner" role="alert">
                <AlertCircle size={15} />
                <span>
                  {(cooldownTimes[activeTab.connectionId] ?? 0) > syncNow
                    ? `${activeConnection?.provider === 'github' ? 'GitHub' : 'Jira'} rate limit reached. Refresh resumes after ${new Date(cooldownTimes[activeTab.connectionId]).toLocaleTimeString()}.`
                    : (errors.edit ??
                      errors[activeTab.id] ??
                      errors.workspace ??
                      errors.app)}
                </span>
                {errors[activeTab.id] && (
                  <button
                    onClick={() => void refreshTab(activeTab, true, true)}
                    disabled={
                      (!online && !demoMode) ||
                      (cooldownTimes[activeTab.connectionId] ?? 0) > syncNow ||
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
            {activeTab &&
              activeConnection &&
              (bulkIssues.length > 1 || bulkOperations[activeTab.id]) && (
                <BulkTriage
                  api={window.canopy}
                  connection={activeConnection}
                  issues={bulkIssues}
                  operation={bulkOperations[activeTab.id] ?? null}
                  onOperation={(change) => {
                    const tabId = activeTab.id;
                    setBulkOperations((current) => {
                      const next = change(current[tabId] ?? null);
                      if (next) return { ...current, [tabId]: next };
                      const copy = { ...current };
                      delete copy[tabId];
                      return copy;
                    });
                  }}
                  currentUser={currentUsers[activeConnection.id]}
                  onClear={() => setMultiSelection(null)}
                  copy={async (issues) => {
                    const result = await copySelectedIssues(
                      window.canopy,
                      issues,
                    );
                    if (!result.ok)
                      setErrors((current) => ({
                        ...current,
                        app: `Couldn’t copy selected issues: ${result.error}`,
                      }));
                    return result.ok;
                  }}
                  canUndo={(key, token) =>
                    mutations.canUndo(activeConnection.id, key, token)
                  }
                  undo={(key, token) =>
                    mutations.undo(activeConnection.id, key, token)
                  }
                  update={async (key, patch, choice, token) => {
                    const options = patch.priorityId
                      ? { priorities: choice ? [choice] : [] }
                      : patch.assigneeId
                        ? { assignees: choice ? [choice] : [] }
                        : patch.transitionId
                          ? {
                              transitions: [
                                {
                                  id: patch.transitionId,
                                  name: choice?.name ?? '',
                                  requiresFields: false,
                                  to: choice?.category
                                    ? {
                                        id: choice.id,
                                        name: choice.name,
                                        category: choice.category,
                                      }
                                    : undefined,
                                },
                              ],
                            }
                          : undefined;
                    const success = await mutations.update(
                      activeConnection.id,
                      key,
                      patch,
                      options,
                      true,
                      token,
                    );
                    if (success && patch.transitionId)
                      pickers.invalidate(activeConnection.id, key);
                    return success;
                  }}
                />
              )}
            {snapshot && activeConnection?.provider !== 'github' && (
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
                      <button onClick={retryPriorityOrder}>
                        Retry priority sort
                      </button>
                    )}
                  </span>
                )}
              </div>
            )}
            <div className="tree-with-preview">
              <div className="tree-content">
                {nextTaskOpen && snapshot && (
                  <section className="next-tasks" aria-label="Next tasks">
                    <div className="next-tasks-controls">
                      <strong>Next tasks in {activeTab.rootKey}</strong>
                      <label>
                        Order by{' '}
                        <select
                          aria-label="Order next tasks by"
                          value={nextTaskCriterion}
                          onChange={(event) =>
                            setNextTaskCriteria((current) => ({
                              ...current,
                              [activeTab.id]: event.target
                                .value as NextTaskCriterion,
                            }))
                          }
                        >
                          <option value="rank">
                            {activeConnection?.provider === 'github'
                              ? 'Tree order'
                              : 'Sibling rank'}
                          </option>
                          {activeConnection?.provider !== 'github' && (
                            <option value="priority">Jira priority</option>
                          )}
                          <option value="status">Status</option>
                          <option value="assignment">Assignment</option>
                          <option value="blocked">Blocked state</option>
                        </select>
                      </label>
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={Boolean(nextTaskMine[activeTab.id])}
                          disabled={
                            !currentUsers[activeTab.connectionId] &&
                            !nextTaskMine[activeTab.id]
                          }
                          onChange={(event) =>
                            setNextTaskMine((current) => ({
                              ...current,
                              [activeTab.id]: event.target.checked,
                            }))
                          }
                        />
                        Assigned to me
                      </label>
                    </div>
                    <p className="next-tasks-explanation">
                      {nextTaskCriterion === 'priority'
                        ? priorityOrder
                          ? 'Jira priority orders issues using this site’s priority order. Missing priorities follow known values.'
                          : priorityError
                            ? `Jira priority order is unavailable: ${priorityError}. Showing tree order.`
                            : 'Loading Jira priority order. Showing tree order for now.'
                        : nextTaskCriterion === 'rank'
                          ? activeConnection?.provider === 'github'
                            ? 'Tree order follows the loaded hierarchy; GitHub has no Jira sibling rank.'
                            : snapshot.warnings.some((warning) =>
                                  warning.includes(
                                    'Rank ordering is unavailable',
                                  ),
                                )
                              ? 'Jira rank ordering is unavailable. Tree order follows issue keys.'
                              : 'Sibling rank follows Jira order within each parent. Parent branches follow tree order.'
                          : nextTaskCriterion === 'status'
                            ? 'New statuses appear before in progress statuses; tree order breaks ties.'
                            : nextTaskCriterion === 'assignment'
                              ? currentUsers[activeTab.connectionId]
                                ? 'Your issues appear first, then other assigned issues, then unassigned issues; assignee name and tree order break ties.'
                                : 'Your account is unavailable. Assigned issues appear before unassigned issues; assignee name and tree order break ties.'
                              : 'Clear issues appear first, unknown blocker state next, then confirmed blocked issues.'}{' '}
                      Blocked issues always follow clear and unknown issues.{' '}
                      {activeConnection?.provider === 'github'
                        ? 'GitHub dependency data is unavailable in tree snapshots, so blocker state is unknown.'
                        : 'Jira blocker state is unknown when link data or a linked blocker status is unavailable.'}
                      {nextTaskCriterion === 'priority' && priorityError && (
                        <button onClick={retryPriorityOrder}>
                          Retry priority order
                        </button>
                      )}
                    </p>
                    {snapshot.warnings.length > 0 && (
                      <p className="next-tasks-explanation">
                        This tree may be incomplete:{' '}
                        {snapshot.warnings.join(' ')}
                      </p>
                    )}
                    <div className="next-tasks-list">
                      {tasks.length === 0 ? (
                        <p>
                          {nextTaskMine[activeTab.id] &&
                          !currentUsers[activeTab.connectionId]
                            ? 'Your account is unavailable. Clear Assigned to me or retry account lookup.'
                            : 'No unfinished issues match this view.'}
                        </p>
                      ) : (
                        tasks.map((task, index) => (
                          <React.Fragment key={task.issue.key}>
                            {task.blocker !== tasks[index - 1]?.blocker && (
                              <div className="next-task-group">
                                {task.blocker === 'clear'
                                  ? 'No active blockers found'
                                  : task.blocker === 'unknown'
                                    ? 'Blocker state unknown'
                                    : 'Blocked'}
                              </div>
                            )}
                            <div className="next-task">
                              <span className="next-task-number">
                                {index + 1}
                              </span>
                              <div className="next-task-detail">
                                <div className="next-task-title">
                                  <strong>{task.issue.key}</strong>{' '}
                                  {task.issue.summary}
                                </div>
                                <div className="next-task-context">
                                  {task.parents.length > 0
                                    ? task.parents
                                        .map((parent) => parent.key)
                                        .join(' › ')
                                    : 'Root issue'}
                                  {' · '}
                                  {task.parents.length > 0
                                    ? `${activeConnection?.provider === 'github' || snapshot.warnings.some((warning) => warning.includes('Rank ordering is unavailable')) ? 'Tree position' : 'Sibling rank'} #${task.rankPath.at(-1)! + 1}`
                                    : 'Root'}
                                  {' · '}
                                  {task.issue.priority?.name ??
                                    (activeConnection?.provider === 'github'
                                      ? 'Jira priority unavailable'
                                      : 'Priority unknown')}
                                  {' · '}
                                  {task.issue.status.name}
                                  {' · '}
                                  {task.issue.assignee?.name ?? 'Unassigned'}
                                  {' · '}
                                  {task.blocker === 'blocked'
                                    ? `Blocked by ${task.blockers.join(', ')}`
                                    : task.blocker === 'unknown'
                                      ? 'Blocker state unknown'
                                      : 'No active blockers found'}
                                </div>
                              </div>
                              <button
                                className="tool-button"
                                onClick={() => jumpToTask(task.issue.key)}
                                aria-label={`Show ${task.issue.key} in tree`}
                              >
                                Show in tree
                              </button>
                            </div>
                          </React.Fragment>
                        ))
                      )}
                    </div>
                  </section>
                )}
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
                      onAction={() => void refreshTab(activeTab, false, true)}
                    />
                  ) : shownTree ? (
                    <div
                      role="tree"
                      aria-label={`${activeTab.rootKey} issue tree`}
                      className="issue-tree"
                    >
                      <TreeRows
                        provider={activeConnection?.provider ?? 'jira'}
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
                        seenIssues={activeSeenRoot?.issues ?? {}}
                        confirmedIssues={
                          new Map(
                            confirmedSnapshot?.issues.map((issue) => [
                              issue.key,
                              issue,
                            ]) ?? [],
                          )
                        }
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
                        selectedKeys={selectedKeys}
                        suppressFocus={suppressTreeFocus}
                        onSelect={(key) => {
                          setMultiSelection(null);
                          updateTab(activeTab.id, { selectedKey: key });
                        }}
                        onMultiSelect={selectMultiple}
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
                              : { issue, x, y, trigger: toggle },
                          );
                        }}
                        editor={editor}
                        beginEdit={beginEdit}
                        onOpenWorkflow={(key) => void openWorkflow(key)}
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
                      title={
                        activeConnection?.provider === 'github'
                          ? 'All issues are closed'
                          : 'All issues are done'
                      }
                      detail={
                        activeConnection?.provider === 'github'
                          ? 'Closed issues in this tree are currently hidden.'
                          : 'Completed issues in this tree are currently hidden.'
                      }
                      action={
                        activeConnection?.provider === 'github'
                          ? 'Show closed issues'
                          : 'Show done issues'
                      }
                      onAction={() =>
                        updateTab(activeTab.id, { hideDone: false })
                      }
                    />
                  ) : (
                    <EmptyState
                      icon={Search}
                      title="No issue tree yet"
                      detail={
                        activeConnection?.provider === 'github'
                          ? 'Open a selected repository, GitHub issue URL, or owner/repo#number.'
                          : 'Open an issue key or Jira URL to see its full hierarchy.'
                      }
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
                    {demoMode
                      ? 'Local sample'
                      : !online
                        ? 'Offline'
                        : (cooldownTimes[activeTab.connectionId] ?? 0) > syncNow
                          ? 'Rate limited'
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
                  provider={activeConnection?.provider ?? 'jira'}
                  connectionId={activeTab.connectionId}
                  issueKey={previewKey}
                  observedIssue={confirmedSnapshot?.issues.find(
                    (issue) => issue.key === previewKey,
                  )}
                  baseline={activeSeenRoot?.issues[previewKey]}
                  onMarkSeen={(previewIssue) => {
                    const issue = confirmedSnapshot?.issues.find(
                      (value) => value.key === previewKey,
                    );
                    if (issue)
                      markSeen({
                        ...issue,
                        commentCount: Math.max(
                          issue.commentCount ?? 0,
                          previewIssue.commentCount ?? 0,
                        ),
                      });
                  }}
                  width={
                    Number.isFinite(workspace.previewWidth)
                      ? Math.max(300, Math.min(720, workspace.previewWidth!))
                      : 420
                  }
                  onWidth={(previewWidth) =>
                    setWorkspace((current) => ({ ...current, previewWidth }))
                  }
                  onClose={closePreview}
                  onChanged={(issue) => {
                    mutations.acceptConfirmedLabels(
                      activeTab.connectionId,
                      issue,
                    );
                    void refreshTab(activeTab);
                  }}
                  onPreview={setPreviewKey}
                  onOpenTab={(key) => openTab(activeTab.connectionId, key)}
                  onOpenExternal={(key) =>
                    void openExternal(activeTab.connectionId, key)
                  }
                  onCopyKeySummary={(issue) =>
                    void copyIssueText(issue, 'key-summary')
                  }
                  onWorkBrief={(preview) =>
                    setWorkBrief({
                      connectionId: activeTab.connectionId,
                      issueKey: preview.issue.key,
                      provider: activeConnection?.provider ?? 'jira',
                      knownIssues: snapshot?.issues ?? [],
                      preview,
                    })
                  }
                  onOpenComment={(commentId) => {
                    void window.canopy
                      .openComment(
                        activeTab.connectionId,
                        previewKey,
                        commentId,
                      )
                      .catch((error: unknown) =>
                        setErrors((current) => ({
                          ...current,
                          app: `Couldn’t open comment: ${error instanceof Error ? error.message : String(error)}`,
                        })),
                      );
                  }}
                />
              )}
            </div>
          </>
        )}
        {!activeTab &&
          !activeSavedView &&
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
        {!activeTab && !activeSavedView && (
          <Welcome
            onOpen={() => setDialog('open')}
            onConnect={() => setDialog('connect')}
            onDemo={launchDemo}
            demoMode={demoMode}
            hasConnections={connections.length > 0}
            error={errors.app ?? errors.workspace}
          />
        )}
      </main>

      {demoMode && (
        <section className="demo-tour" aria-label="Canopy demo">
          <div className="demo-tour-copy">
            <strong>Canopy demo</strong>
            <span role="status" aria-live="polite">
              {tour?.caption ?? 'Loading the sample workspace…'}
            </span>
            {(tour?.phase === 'playing' || tour?.phase === 'paused') && (
              <span className="demo-tour-progress">
                {tour.step === 0 ? 'Starting tour' : `Step ${tour.step} of 7`}
                {tour.phase === 'paused' ? ' · Paused' : ''}
              </span>
            )}
            {(tour?.phase === 'playing' || tour?.phase === 'paused') && (
              <progress
                ref={tourProgressRef}
                className="demo-tour-meter"
                max={100}
                value={0}
                aria-label="Step progress"
              />
            )}
          </div>
          {(tour?.phase === 'playing' ||
            tour?.phase === 'paused' ||
            tour?.phase === 'complete') && (
            <div className="demo-tour-navigation">
              <button
                className="secondary"
                disabled={tour.step === 0}
                onClick={() =>
                  seekTourRef.current?.(tour.step - 1, tour.phase === 'paused')
                }
                aria-label="Previous demo step"
                title="Previous step (Left arrow)"
              >
                <ArrowLeft size={15} />
              </button>
              <button
                className="secondary"
                disabled={tour.step === 7}
                onClick={() =>
                  seekTourRef.current?.(tour.step + 1, tour.phase === 'paused')
                }
                aria-label="Next demo step"
                title="Next step (Right arrow)"
              >
                <ArrowRight size={15} />
              </button>
            </div>
          )}
          {(tour?.phase === 'playing' || tour?.phase === 'paused') && (
            <>
              <button
                className="secondary"
                onClick={() => toggleTourPauseRef.current?.()}
              >
                {tour.phase === 'paused' ? 'Resume demo' : 'Pause demo'}
              </button>
              <button
                className="secondary"
                onClick={() => stopTourRef.current?.()}
              >
                Stop demo
              </button>
            </>
          )}
          <button
            className="secondary"
            onClick={() => seekTourRef.current?.(0, false)}
          >
            Reset and replay
          </button>
          <button
            className="secondary"
            onClick={() => void window.canopy.closeDemo()}
          >
            Close demo
          </button>
        </section>
      )}

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
              {!demoMode && (
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
              )}
              {!demoMode && (
                <button
                  role="menuitem"
                  onClick={() =>
                    action(
                      () => void openExternal(tab.connectionId, tab.rootKey),
                    )
                  }
                >
                  Open in{' '}
                  {connections.find((item) => item.id === tab.connectionId)
                    ?.provider === 'github'
                    ? 'GitHub'
                    : 'Jira'}
                </button>
              )}
            </div>
          );
        })()}
      {rowMenu && activeTab && (
        <RowMenu
          provider={activeConnection?.provider ?? 'jira'}
          issue={rowMenu.issue}
          position={rowMenu}
          onClose={closeRowMenu}
          onAction={(action) => {
            if (action === 'createChild')
              setChildParent({
                issue: rowMenu.issue,
                connectionId: activeTab.connectionId,
                tabId: activeTab.id,
              });
            else if (action === 'link')
              void copyIssueLink(activeTab.connectionId, rowMenu.issue.key);
            else if (action === 'open')
              void openExternal(activeTab.connectionId, rowMenu.issue.key);
            else if (action === 'brief')
              setWorkBrief({
                connectionId: activeTab.connectionId,
                issueKey: rowMenu.issue.key,
                provider: activeConnection?.provider ?? 'jira',
                knownIssues: snapshot?.issues ?? [],
              });
            else void copyIssueText(rowMenu.issue, action);
          }}
        />
      )}
      {workBrief && (
        <WorkBriefDialog {...workBrief} onClose={() => setWorkBrief(null)} />
      )}
      {childParent && (
        <CreateChildDialog
          key={`${childParent.connectionId}:${childParent.issue.key}`}
          connectionId={childParent.connectionId}
          parent={childParent.issue}
          onClose={() => {
            setChildParent(null);
            restoreTreeFocus(childParent.issue.key);
          }}
          onOpenJira={() =>
            void openExternal(childParent.connectionId, childParent.issue.key)
          }
          onCreated={(issue) => {
            mutations.insertCreated(childParent.connectionId, issue);
            updateTab(childParent.tabId, {
              expanded: [
                ...new Set([
                  ...(workspaceRef.current.tabs.find(
                    (tab) => tab.id === childParent.tabId,
                  )?.expanded ?? []),
                  childParent.issue.key,
                ]),
              ],
              selectedKey: issue.key,
            });
            setReveal({
              tabId: childParent.tabId,
              key: issue.key,
              preserveScroll: true,
            });
            setChildParent(null);
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
            for (const tab of allRefreshTabs)
              rootRefreshes.current.forget(refreshRootKey(tab));
            forgetTabs(allRefreshTabs.map((tab) => tab.id));
            setConnections(value);
            // Token replacement can retain a connection ID. Refresh its transport
            // deadline while preserving limits on other authenticated connections.
            for (const [id, previous] of Object.entries(cooldowns.current)) {
              void window.canopy
                .syncStatus(id)
                .then((status) => {
                  if (cooldowns.current[id] !== previous) return;
                  if (status.retryAt) cooldowns.current[id] = status.retryAt;
                  else {
                    delete cooldowns.current[id];
                    const active = tabsRef.current.find(
                      (tab) =>
                        tab.id === activeIdRef.current &&
                        tab.connectionId === id,
                    );
                    if (active) deferredRefreshes.current.add(active.id);
                  }
                  setCooldownTimes({ ...cooldowns.current });
                })
                .catch(() => {});
            }
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
      {dialog === 'appearance' && (
        <AppearanceDialog
          theme={workspace.theme}
          palette={workspace.palette ?? 'default'}
          onPreview={setAppearancePreview}
          onClose={() => {
            setAppearancePreview(null);
            setDialog(null);
          }}
          onSave={async (theme, palette) => {
            appearanceSaving.current = true;
            try {
              if (workspaceSaveTimer.current !== null) {
                window.clearTimeout(workspaceSaveTimer.current);
                workspaceSaveTimer.current = null;
                void saveWorkspace(workspaceRef.current).catch(() => {});
              }
              await saveWorkspace({
                ...workspaceRef.current,
                theme,
                palette,
              });
              setWorkspace((current) => ({ ...current, theme, palette }));
              setAppearancePreview(null);
              setDialog((current) =>
                current === 'appearance' ? null : current,
              );
            } finally {
              appearanceSaving.current = false;
            }
          }}
          onShortcuts={() => {
            setAppearancePreview(null);
            setDialog('shortcuts');
          }}
        />
      )}
    </div>
  );
}

function Connections({
  connections,
  demoMode,
  setConnections,
  onConnect,
  onError,
}: {
  connections: Connection[];
  demoMode: boolean;
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
        {!demoMode && (
          <button
            className="icon-button"
            onClick={onConnect}
            disabled={busy}
            aria-label="Connect Jira or GitHub"
          >
            {busy ? <Loader2 className="spin" size={14} /> : <Plus size={15} />}
          </button>
        )}
      </div>
      {connections.map((connection) => (
        <div className="connection" key={connection.id}>
          <div className={cx('connection-dot', connection.provider)} />
          <span>
            <b>{connection.name}</b>
            <small>
              {connection.provider === 'github'
                ? connection.repositories?.join(', ')
                : (connection.accountName ?? connection.url)}
            </small>
          </span>
          {!demoMode && (
            <button
              className="icon-button disconnect"
              title={`Disconnect ${connection.name}`}
              onClick={() => void disconnect(connection.id)}
            >
              <LogOut size={14} />
            </button>
          )}
        </div>
      ))}
      {!demoMode && connections.length === 0 && (
        <button className="connect-quiet" onClick={onConnect}>
          <LogIn size={15} />
          Connect Jira or GitHub
        </button>
      )}
    </section>
  );
}

type RowsProps = {
  provider: Connection['provider'];
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
  seenIssues: Record<string, SeenIssue>;
  confirmedIssues: Map<string, Issue>;
  revealedKey?: string;
  onToggle: (key: string) => void;
  selectedKey?: string;
  selectedKeys: Set<string>;
  suppressFocus: React.RefObject<boolean>;
  onSelect: (key: string) => void;
  onMultiSelect: (key: string, range: boolean, toggle: boolean) => void;
  onOpenTab: (key: string) => void;
  onOpenExternal: (key: string) => void;
  onOpenWorkflow: (key: string) => void;
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
  focusNeighbor: (key: string, direction: -1 | 1, extend?: boolean) => void;
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
  const unread = unseenChanges(
    props.seenIssues[issue.key],
    props.confirmedIssues.get(issue.key) ?? issue,
  );
  const repositoryRoot =
    props.provider === 'github' && issue.type === 'Repository';
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
      focusNeighbor(issue.key, 1, event.shiftKey);
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusNeighbor(issue.key, -1, event.shiftKey);
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
      if (repositoryRoot) {
        if (hasChildren && !props.expansionLocked) onToggle(issue.key);
      } else props.beginEdit(issue.key, 'summary');
    }
    if (
      event.key === ' ' &&
      !event.shiftKey &&
      event.target === event.currentTarget
    ) {
      event.preventDefault();
      if (repositoryRoot) {
        if (hasChildren && !props.expansionLocked) onToggle(issue.key);
      } else props.onPreview(issue.key);
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
          {props.provider === 'demo' ? (
            <span className="key">{issue.key}</span>
          ) : (
            <button
              className="key"
              onClick={() => props.onOpenExternal(issue.key)}
              title={`Open in ${props.provider === 'github' ? 'GitHub' : 'Jira'}`}
            >
              {issue.key}
            </button>
          )}
          {props.provider !== 'demo' && (
            <button
              className="copy-key"
              onClick={() => props.onCopyLink(issue.key)}
              title={`Copy link to ${issue.key}`}
              aria-label={`Copy link to ${issue.key}`}
            >
              <Copy size={11} />
            </button>
          )}
          {repositoryRoot ? (
            <span className="summary">{issue.summary}</span>
          ) : props.editor?.key === issue.key &&
            props.editor.field === 'summary' ? (
            <SummaryEditor
              provider={props.provider}
              issue={issue}
              save={props.updateIssue}
              cancel={props.cancelEdit}
            />
          ) : props.provider !== 'demo' ? (
            <button
              className="summary"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  props.beginEdit(issue.key, 'summary');
                }
              }}
              onDoubleClick={() => props.beginEdit(issue.key, 'summary')}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey)
                  props.onMultiSelect(
                    issue.key,
                    event.shiftKey,
                    event.metaKey || event.ctrlKey,
                  );
                else onSelect(issue.key);
              }}
              title={`${issue.summary} — Double-click to edit`}
              aria-label={issue.summary}
            >
              {issue.summary}
            </button>
          ) : (
            <span className="summary">{issue.summary}</span>
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
    priority: repositoryRoot ? null : (
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
    assignee: repositoryRoot ? null : (
      <FieldCell
        label={`Edit assignee for ${issue.key}`}
        active={
          props.editor?.key === issue.key && props.editor.field === 'assignee'
        }
        onEdit={() => props.beginEdit(issue.key, 'assignee')}
      >
        <AssigneeEditor
          provider={props.provider}
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
        />
      </FieldCell>
    ),
    status: repositoryRoot ? null : (
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
          openWorkflow={() => props.onOpenWorkflow(issue.key)}
          choices={props.options[issue.key]?.transitions}
          state={props.options[issue.key]?.status}
          retry={() =>
            void props.loadOptions(issue.key, 'status', '', false, true)
          }
          save={(id) => void props.updateIssue(issue.key, { transitionId: id })}
        />
      </FieldCell>
    ),
  };
  return (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? open : undefined}
      aria-label={`${issue.key}: ${issue.summary}`}
      aria-selected={
        props.selectedKeys.size > 0
          ? props.selectedKeys.has(issue.key)
          : selectedKey === issue.key
      }
      data-tree-key={issue.key}
      tabIndex={
        selectedKey === issue.key || (!selectedKey && depth === 0) ? 0 : -1
      }
      onFocus={(event) => {
        event.stopPropagation();
        if (
          event.target === event.currentTarget &&
          !props.suppressFocus.current
        )
          onSelect(issue.key);
      }}
      onPointerDownCapture={(event) => {
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          (event.target as HTMLElement).closest('.disclosure')
        )
          props.suppressFocus.current = true;
      }}
      onClick={(event) => {
        event.stopPropagation();
        const target = event.target as HTMLElement;
        if (!target.closest('input,button,select,[role="button"]')) {
          if (event.metaKey || event.ctrlKey || event.shiftKey)
            props.onMultiSelect(
              issue.key,
              event.shiftKey,
              event.metaKey || event.ctrlKey,
            );
          else onSelect(issue.key);
        }
        props.suppressFocus.current = false;
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
          (event.target as HTMLElement)
            .closest<HTMLElement>('.field-cell')
            ?.focus();
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
          (props.selectedKeys.size > 0
            ? props.selectedKeys.has(issue.key)
            : selectedKey === issue.key) && 'selected',
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
        {(unread.fields.length > 0 || unread.comments > 0) && (
          <span
            className="unread-badge"
            aria-label={`Unseen changes on ${issue.key}`}
            title="Unseen changes"
          >
            ●
          </span>
        )}
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
          ) : props.provider !== 'demo' ? (
            <button
              className="icon-button"
              title={`Open in ${props.provider === 'github' ? 'GitHub' : 'Jira'}`}
              onClick={() => props.onOpenExternal(issue.key)}
            >
              <ExternalLink size={14} />
            </button>
          ) : null}
        </div>
      </div>
      {linksOpen && (
        <LinkedIssues
          issue={issue}
          depth={depth}
          openTab={props.onOpenTab}
          openExternal={props.onOpenExternal}
          provider={props.provider}
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
  provider,
  issue,
  save,
  cancel,
}: {
  provider: Connection['provider'];
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
      aria-label={`${provider === 'github' ? 'Title' : 'Summary'} for ${issue.key}`}
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
  provider,
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
}: {
  provider: Connection['provider'];
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
}) {
  const [query, setQuery] = useState('');
  const previousQuery = useRef('');
  const queryChanged = useRef(false);
  const searchTimer = useRef<number | undefined>(undefined);
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
    searchTimer.current = timer;
    return () => window.clearTimeout(timer);
  }, [active, query]);
  const choose = (id: string | null) => {
    window.clearTimeout(searchTimer.current);
    queryChanged.current = false;
    save(id);
  };
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
        placeholder="Search people…"
        aria-label="Search assignees"
      />
      <button
        disabled={
          !currentUser ||
          issue.assignee?.id === currentUser.id ||
          state?.validating
        }
        title={
          !currentUser
            ? 'Your account is not available yet. Retry the account lookup.'
            : undefined
        }
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => currentUser && choose(currentUser.id)}
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
          onClick={() => choose(null)}
        >
          <AssigneeAvatar assignee={null} />
          Unassigned
        </button>
        {visible?.map((choice) => (
          <button
            key={choice.id}
            disabled={state?.validating}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(choice.id)}
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
        {provider === 'github'
          ? 'GitHub checks assignment eligibility for this repository when selected. Load more to browse additional assignees.'
          : 'Recent people are suggestions; Jira checks assignment for this issue when selected. Search covers only Jira’s first 1,000 users and may be incomplete.'}
      </p>
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
  openWorkflow,
}: {
  color?: string;
  active: boolean;
  issue: Issue;
  choices?: EditOptions['transitions'];
  state?: FieldLoad;
  retry: () => void;
  save: (id: string) => void;
  openWorkflow: () => void;
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
          <div className="workflow-choice" key={choice.id}>
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
              onClick={() => save(choice.id)}
            >
              {choice.name}
              {choice.requiresFields && <small>Requires fields</small>}
            </button>
            {choice.requiresFields && (
              <button
                role="menuitem"
                autoFocus={
                  choice === choices?.[0] &&
                  choices.every((value) => value.requiresFields)
                }
                aria-label={`Open ${issue.key} in Jira for ${choice.name}`}
                onClick={openWorkflow}
              >
                Open in Jira
              </button>
            )}
          </div>
        ))}
    </div>
  );
}

function LinkedIssues({
  issue,
  depth,
  openTab,
  openExternal,
  provider,
}: {
  issue: Issue;
  depth: number;
  openTab: (key: string) => void;
  openExternal: (key: string) => void;
  provider: Connection['provider'];
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
                {provider === 'demo' ? (
                  <span className="key">{link.key}</span>
                ) : (
                  <button
                    className="key"
                    onClick={() => openExternal(link.key)}
                  >
                    {link.key}
                  </button>
                )}
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
  const [provider, setProvider] = useState<'jira' | 'github'>('jira');
  const [repositories, setRepositories] = useState('');
  const [githubToken, setGithubToken] = useState('');
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
  const connectGithub = async () => {
    setBusy('token');
    setError('');
    try {
      onConnected(
        await window.canopy.connectGithub({
          token: githubToken,
          repositories: repositories.split(/[\s,]+/).filter(Boolean),
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog
      title={`Connect ${provider === 'github' ? 'GitHub' : 'Jira'}`}
      onClose={onClose}
      wide
    >
      <div className="connect-dialog">
        <div className="connect-provider">
          <button
            className={provider === 'jira' ? 'primary' : 'secondary'}
            onClick={() => {
              setProvider('jira');
              setError('');
            }}
          >
            Jira
          </button>
          <button
            className={provider === 'github' ? 'primary' : 'secondary'}
            onClick={() => {
              setProvider('github');
              setError('');
            }}
          >
            GitHub
          </button>
        </div>
        {provider === 'github' ? (
          <>
            <p className="connect-lead">
              Use a fine-grained personal access token with Issues read and
              write permission on the selected repositories.
            </p>
            <label>
              <span>Repositories</span>
              <textarea
                value={repositories}
                onChange={(event) => setRepositories(event.target.value)}
                placeholder="owner/repo-one, owner/repo-two"
              />
              <small>
                Enter the repositories selected for this connection, separated
                by commas or spaces. Canopy verifies issue access before saving.
              </small>
            </label>
            <label>
              <span>Fine-grained token</span>
              <input
                type="password"
                autoComplete="off"
                value={githubToken}
                onChange={(event) => setGithubToken(event.target.value)}
                placeholder="Paste your token"
              />
              <small>Stored in your operating system keychain.</small>
            </label>
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
            <div className="connect-actions">
              <button
                className="primary"
                disabled={
                  Boolean(busy) || !repositories.trim() || !githubToken.trim()
                }
                onClick={() => void connectGithub()}
              >
                {busy ? 'Connecting…' : 'Connect GitHub'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="connect-lead">
              Use an Atlassian API token for a direct connection to your Jira
              Cloud site.
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
          </>
        )}
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
  const [groupRepositories, setGroupRepositories] = useState(false);
  const [searchState, setSearchState] = useState<SearchState>({
    issues: [],
    loading: false,
    searched: false,
    error: '',
  });
  const [selectedKey, setSelectedKey] = useState<string>();
  const [explicitSelection, setExplicitSelection] = useState(false);
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
  const selectedConnection = connections.find(
    (item) => item.id === connectionId,
  );
  const parsedKey = parseIssueKey(query);
  const parsedRepository = parseGithubRepository(query);
  const directKey =
    selectedConnection?.provider === 'github'
      ? parsedKey?.includes('#')
        ? parsedKey
        : parsedRepository &&
            selectedConnection.repositories?.includes(parsedRepository)
          ? parsedRepository
          : null
      : parsedKey && !parsedKey.includes('#')
        ? parsedKey
        : null;
  const project = (
    activeRoot?.connectionId === connectionId
      ? activeRoot
      : recentRoots.find((root) => root.connectionId === connectionId)
  )?.rootKey.split('-')[0];
  const recent = recentRoots
    .filter((root) => root.connectionId === connectionId)
    .slice(0, 20);
  const repositories =
    selectedConnection?.provider === 'github'
      ? (selectedConnection.repositories ?? []).map((key) => ({
          key,
          summary: 'Repository',
          type: 'Repository',
        }))
      : [];
  const matchingRepositories = query.trim()
    ? repositories.filter((repo) =>
        repo.key.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : repositories;
  const options = !query.trim()
    ? [
        ...repositories,
        ...recent
          .filter(
            (root) => !repositories.some((repo) => repo.key === root.rootKey),
          )
          .map((root) => ({
            key: root.rootKey,
            summary: root.summary ?? '',
            type: '',
          })),
      ]
    : [...matchingRepositories, ...searchState.issues];
  const displayedOptions =
    groupRepositories &&
    query.trim() &&
    selectedConnection?.provider === 'github'
      ? [...options].sort(
          (a, b) =>
            a.key.split('#')[0].localeCompare(b.key.split('#')[0]) ||
            a.key.localeCompare(b.key),
        )
      : options;
  const selected =
    options.find((issue) => issue.key === selectedKey) ?? options[0];
  const busy = searchState.loading;
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    setSelectedKey(matchingRepositories[0]?.key);
    setExplicitSelection(false);
    setError('');
    search.start(
      connectionId,
      query.trim(),
      project,
      Boolean(
        connectionId &&
        query.trim().length >= 2 &&
        (selectedConnection?.provider === 'github'
          ? !directKey
          : !(directKey && /\/browse\//i.test(query))),
      ),
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
    const key = directKey && !explicitSelection ? directKey : selected?.key;
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
                displayedOptions.length
              ) {
                event.preventDefault();
                setExplicitSelection(true);
                const index = Math.max(
                  0,
                  displayedOptions.findIndex(
                    (issue) => issue.key === selected?.key,
                  ),
                );
                setSelectedKey(
                  displayedOptions[
                    directKey && !explicitSelection
                      ? 0
                      : Math.max(
                          0,
                          Math.min(
                            displayedOptions.length - 1,
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
            placeholder={
              selectedConnection?.provider === 'github'
                ? 'GitHub URL, owner/repo, issue number, or title'
                : 'Issue key, uppercase project prefix, Jira URL, or summary'
            }
            aria-label={
              selectedConnection?.provider === 'github'
                ? 'GitHub URL, owner/repo, issue number, or title'
                : 'Issue key, uppercase project prefix, Jira URL, or summary'
            }
          />
          {busy && <Loader2 className="spin" size={14} />}
        </div>
        {connections.length === 0 && (
          <p className="dialog-note">
            <AlertCircle size={14} />
            Connect Jira or GitHub from the sidebar first.
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
            {options.length
              ? 'Loading more matches…'
              : `Searching ${selectedConnection?.provider === 'github' ? 'GitHub' : 'Jira'}…`}
          </p>
        )}
        {!busy &&
          !searchState.error &&
          searchState.searched &&
          !options.length && (
            <p className="dialog-note" role="status">
              {searchState.nextPageToken
                ? searchState.nextPageKind === 'repositories'
                  ? 'No matches in these repositories. Search more repositories to continue.'
                  : 'No matches on this page. Load more to continue searching.'
                : 'No matching issues. Try another summary or enter an issue key.'}
            </p>
          )}
        {!query.trim() && options.length > 0 && (
          <p className="dialog-note">
            {selectedConnection?.provider === 'github'
              ? 'Repositories and recent roots'
              : 'Recent roots'}
          </p>
        )}
        {selectedConnection?.provider === 'github' && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={groupRepositories}
              onChange={(event) => setGroupRepositories(event.target.checked)}
            />
            Group by repository
          </label>
        )}
        <div
          className={
            selectedConnection?.provider === 'github'
              ? 'search-results github-results'
              : 'search-results'
          }
          id="issue-search-options"
          role="listbox"
          aria-label="Issue results"
        >
          {displayedOptions.map((issue, index) => (
            <React.Fragment key={issue.key}>
              {groupRepositories &&
                query.trim() &&
                selectedConnection?.provider === 'github' &&
                (index === 0 ||
                  displayedOptions[index - 1].key.split('#')[0] !==
                    issue.key.split('#')[0]) && (
                  <div className="search-repo-group" role="presentation">
                    {issue.key.split('#')[0]}
                  </div>
                )}
              <button
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
            </React.Fragment>
          ))}
        </div>
        {query.trim() && searchState.issues.length > 0 && (
          <p className="dialog-note" role="status">
            {searchState.nextPageToken
              ? searchState.nextPageKind === 'repositories'
                ? `${searchState.issues.length} matches loaded. More repositories can be searched.`
                : `Ranked among ${searchState.issues.length} loaded matches; more matches are available. Later pages may contain better matches.`
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
            {searchState.nextPageKind === 'repositories'
              ? 'Search more repositories'
              : 'Load more'}
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

function AppearanceDialog({
  theme,
  palette,
  onPreview,
  onClose,
  onSave,
  onShortcuts,
}: {
  theme: Workspace['theme'];
  palette: NonNullable<Workspace['palette']>;
  onPreview: (value: {
    theme: Workspace['theme'];
    palette: NonNullable<Workspace['palette']>;
  }) => void;
  onClose: () => void;
  onSave: (
    theme: Workspace['theme'],
    palette: NonNullable<Workspace['palette']>,
  ) => Promise<void>;
  onShortcuts: () => void;
}) {
  const [draftTheme, setDraftTheme] = useState(theme);
  const [draftPalette, setDraftPalette] = useState(palette);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const initialFocus = useRef<HTMLInputElement>(null);
  useEffect(() => {
    initialFocus.current?.focus();
  }, []);
  const preview = (
    nextTheme: Workspace['theme'],
    nextPalette: NonNullable<Workspace['palette']>,
  ) => {
    setDraftTheme(nextTheme);
    setDraftPalette(nextPalette);
    setSaveError(null);
    onPreview({ theme: nextTheme, palette: nextPalette });
  };
  const save = async () => {
    if (isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await onSave(draftTheme, draftPalette);
    } catch (error) {
      setSaveError(
        `Couldn’t save appearance: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsSaving(false);
    }
  };
  return (
    <Dialog title="Appearance" onClose={() => !isSaving && onClose()}>
      <div className="appearance-dialog">
        <p>
          Choose a palette and appearance. Changes preview throughout the window
          until you save.
        </p>
        <fieldset className="appearance-modes">
          <legend>Appearance</legend>
          {(['system', 'light', 'dark'] as const).map((mode) => (
            <label key={mode} className="appearance-mode">
              <input
                ref={mode === theme ? initialFocus : undefined}
                type="radio"
                disabled={isSaving}
                name="appearance-mode"
                checked={draftTheme === mode}
                onChange={() => preview(mode, draftPalette)}
              />
              {mode === 'system'
                ? 'System'
                : mode === 'light'
                  ? 'Light'
                  : 'Dark'}
            </label>
          ))}
        </fieldset>
        <fieldset className="appearance-palettes">
          <legend>Palette</legend>
          {(['default', 'ocean', 'forest'] as const).map((choice) => (
            <label key={choice} className="appearance-palette">
              <input
                type="radio"
                disabled={isSaving}
                name="appearance-palette"
                checked={draftPalette === choice}
                onChange={() => preview(draftTheme, choice)}
              />
              <span className="palette-samples" aria-hidden="true">
                {(['light', 'dark'] as const).map((mode) => (
                  <span
                    key={mode}
                    className="palette-sample"
                    data-palette={choice}
                    data-theme={mode}
                  >
                    <i />
                    <b />
                    <em />
                  </span>
                ))}
              </span>
              <span>
                {choice === 'default'
                  ? 'Default'
                  : choice === 'ocean'
                    ? 'Ocean'
                    : 'Forest'}
              </span>
            </label>
          ))}
        </fieldset>
        {saveError && (
          <p className="dialog-error" role="alert">
            {saveError}
          </p>
        )}
      </div>
      <div className="dialog-footer">
        <button className="secondary" onClick={onShortcuts} disabled={isSaving}>
          Keyboard shortcuts
        </button>
        <span className="footer-spacer" />
        <button className="secondary" onClick={onClose} disabled={isSaving}>
          Cancel
        </button>
        <button
          className="primary"
          onClick={() => void save()}
          disabled={isSaving}
        >
          Save
        </button>
      </div>
    </Dialog>
  );
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

function WorkBriefDialog({
  connectionId,
  issueKey,
  provider,
  knownIssues,
  preview,
  onClose,
}: {
  connectionId: string;
  issueKey: string;
  provider: Connection['provider'];
  knownIssues: Issue[];
  preview?: IssuePreviewData;
  onClose: () => void;
}) {
  const [brief, setBrief] = useState('');
  const [error, setError] = useState('');
  const [partial, setPartial] = useState(false);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setBrief('');
    setError('');
    setPartial(false);
    setCopied(false);
    Promise.allSettled([
      preview && attempt === 0
        ? Promise.resolve(preview)
        : window.canopy.preview(connectionId, issueKey),
      provider === 'demo'
        ? Promise.resolve('Local sample workspace')
        : window.canopy.issueUrl(connectionId, issueKey),
    ]).then(([details, sourceUrl]) => {
      if (!live) return;
      try {
        setBrief(
          issueWorkBrief({
            preview: details.status === 'fulfilled' ? details.value : undefined,
            provider,
            sourceUrl:
              sourceUrl.status === 'fulfilled' ? sourceUrl.value : undefined,
            knownIssues,
            issueKey,
          }),
        );
        setPartial(
          details.status === 'rejected' ||
            sourceUrl.status === 'rejected' ||
            Boolean(details.status === 'fulfilled' && details.value.linksError),
        );
      } catch (reason) {
        setError(`Couldn’t load work brief: ${String(reason)}`);
      }
    });
    return () => {
      live = false;
    };
  }, [connectionId, issueKey, provider, knownIssues, preview, attempt]);
  const copy = async () => {
    try {
      await window.canopy.copyText(brief);
      setCopied(true);
      setError('');
    } catch (reason) {
      setError(`Couldn’t copy work brief: ${String(reason)}`);
    }
  };
  return (
    <Dialog
      title={`Work brief for ${issueKey}`}
      onClose={onClose}
      wide
      initialFocus
    >
      <div className="work-brief-dialog">
        <p className="dialog-note">
          Review the exact Markdown before copying it.
        </p>
        {error && (
          <p role="alert" className="dialog-error">
            {error}
          </p>
        )}
        {partial && (
          <p role="status" className="dialog-note">
            Some work brief details are unavailable. Retry to load them.
          </p>
        )}
        {brief ? (
          <pre aria-label="Work brief Markdown" tabIndex={0}>
            {brief}
          </pre>
        ) : !error ? (
          <p role="status">Loading work brief…</p>
        ) : null}
        <div className="dialog-footer">
          {(error || partial) && (
            <button onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </button>
          )}
          {copied && <span role="status">Copied</span>}
          <button
            className="primary"
            disabled={!brief}
            onClick={() => void copy()}
          >
            Copy work brief
          </button>
        </div>
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
  initialFocus,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  compact?: boolean;
  wide?: boolean;
  initialFocus?: boolean;
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
            autoFocus={initialFocus}
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
  onDemo,
  demoMode,
  hasConnections,
  error,
}: {
  onOpen: () => void;
  onConnect: () => void;
  onDemo: () => void;
  demoMode: boolean;
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
            onClick={hasConnections || demoMode ? onOpen : onConnect}
          >
            {hasConnections || demoMode ? (
              <Search size={16} />
            ) : (
              <LogIn size={16} />
            )}
            {hasConnections || demoMode
              ? 'Open an issue'
              : 'Connect Jira or GitHub'}
          </button>
          {!demoMode && (
            <button className="secondary" onClick={onDemo}>
              Try demo
            </button>
          )}
          {hasConnections && !demoMode && (
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
