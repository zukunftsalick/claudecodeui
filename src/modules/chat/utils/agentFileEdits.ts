// Tools whose successful result means a file on disk now has new content.
// Claude Code's own file tools, plus Codex's patch tool when it names one file.
const FILE_WRITING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'ApplyPatch']);

/**
 * Returns the path a file-writing tool call targets, or null for any other
 * tool. Used by the realtime handler to follow the agent's edits in the editor
 * panel: the path is remembered on `tool_use` and acted on once its
 * `tool_result` reports success, so a refused or failed edit never opens.
 */
export const readAgentEditedFilePath = (toolName: unknown, toolInput: unknown): string | null => {
  if (typeof toolName !== 'string' || !FILE_WRITING_TOOLS.has(toolName)) {
    return null;
  }
  if (!toolInput || typeof toolInput !== 'object') {
    return null;
  }
  const input = toolInput as { file_path?: unknown; notebook_path?: unknown };
  const path = typeof input.file_path === 'string' ? input.file_path : input.notebook_path;
  return typeof path === 'string' && path.trim() ? path : null;
};
