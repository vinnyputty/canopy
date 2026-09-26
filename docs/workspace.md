# Workspace controls

Drag a tab onto another tab to move it to that position. Keyboard users can focus a tab and press `Alt+Shift+Left` or `Alt+Shift+Right`. Tab order is saved with the workspace.

Right-click a tab, or press `Shift+F10` while it is focused, to close other tabs, close tabs to its right, pin its root, copy its Jira link, or open it in Jira. Middle-click closes a tab. Pins are sidebar favorites: closing their tabs retains the favorites, and favorites do not affect tab ordering or bulk close actions. The sidebar unpin button removes a favorite.

Press `⌘⇧T` on macOS or `Ctrl+Shift+T` elsewhere to reopen the most recently closed tab, including its selection, scroll position, done and assignee/status/priority filters, table columns and widths, sorting, text size and row spacing, subtree focus, hierarchy expansion, and linked-issue expansion. Find-in-tree text stays with an open tab during the session and clears when that tab closes; it is excluded from saved tab snapshots. The last twenty closed tabs survive restarts. Bulk close records tabs from right to left for reopening. If a root is already open, reopening restores the saved state into its existing tab.

The open-issue picker selects its first result automatically. Up/Down moves the highlight without leaving the input. Enter opens a typed issue key or Jira URL directly; after Up/Down, Enter opens the highlighted suggestion. Search starts after two characters and a short pause, including key prefixes that may also be complete keys. An uppercase project-key prefix such as `CAN` finds issue keys beginning with that text; lowercase words continue through summary search. Exact and prefix key matches lead summary matches; project context comes from the active tab on that connection, otherwise its latest recent root. Loading, empty results, and recoverable errors have explicit states. Load more fetches another page and may reorder results by relevance, while preserving the selected issue; Retry retains already loaded matches.

The open-issue picker shows up to twenty recent roots for the selected connection when its search field is empty. Recent roots, favorites, and tabs include cached summaries with full-title tooltips. Explicitly disconnecting a site removes its tabs, favorites, recent roots, closed tabs, navigation history, root views, and connection defaults. Temporarily unavailable connections retain their saved state.

Back and Forward restore the complete tab state at each root or tab navigation, reopening a destination if its tab was closed. Use the toolbar buttons, `Alt+Left` / `Alt+Right`, or `⌘[` / `⌘]` on macOS. Editing text does not trigger these navigation shortcuts. History is limited to one hundred entries in each direction and lasts for the current session; a new navigation clears the forward branch.

Reopen, Back, and Forward apply the saved filters and table presentation as that root's override. Later default changes leave the restored view intact. **Reset this root to default** adopts the connection's current default, including filters. Ordinary tab selection preserves default inheritance for uncustomized roots.

Drag the sidebar divider to resize it between 180 and 400 pixels (220 by default). When the divider is focused, arrow keys adjust it by ten pixels; Home and End select the limits. The width survives restarts.

Window size, position, and maximized state survive restarts. Saved bounds are clamped to an available monitor's work area when display arrangements change. Fullscreen state is not restored.

Workspace saves replace the previous file atomically. On Windows, temporary file-lock errors retry with bounded backoff; persistent failures remain visible and leave the previous saved file intact.
