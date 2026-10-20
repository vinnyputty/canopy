export function openIssueError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = "Error invoking remote method 'canopy:openIssue': Error: ";
  return message.startsWith(prefix) && message.length > prefix.length
    ? message.slice(prefix.length)
    : message;
}
