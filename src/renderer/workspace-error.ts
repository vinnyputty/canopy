export function workspaceError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  for (const method of ['loadWorkspace', 'saveWorkspace', 'reloadWorkspace']) {
    const prefix = `Error invoking remote method 'canopy:${method}': Error: `;
    if (message.startsWith(prefix) && message.length > prefix.length)
      return message.slice(prefix.length);
  }
  return message;
}
