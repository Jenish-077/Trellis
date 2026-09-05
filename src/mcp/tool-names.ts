/**
 * The trellis MCP tool names, kept in a zero-import module so both the MCP server
 * (which also pulls in the whole engine) and the session-scoring hooks (which must
 * stay cheap and engine-free) can share one list. Adding a dependency here would
 * drag it into every hook invocation, so this file imports nothing.
 */

/** The tools trellis advertises today, as their canonical names. */
export const TRELLIS_MCP_TOOL_CANONICAL = [
  'trellis_find_code',
  'trellis_find_all',
  'trellis_trace_calls',
  'trellis_file_api',
  'trellis_repo_map',
  'trellis_check_freshness',
] as const;

/**
 * The pre-0.8.1 tool names, still accepted. A name is an API: skills, saved
 * prompts and other people's notes reference the old ones, so they map to the
 * canonical name rather than 404.
 */
export const TRELLIS_MCP_TOOL_ALIASES: Record<string, string> = {
  trellis_ask: 'trellis_find_code',
  trellis_grep: 'trellis_find_all',
  trellis_callers: 'trellis_trace_calls',
  trellis_skeleton: 'trellis_file_api',
  trellis_map: 'trellis_repo_map',
  trellis_check: 'trellis_check_freshness',
};

/** Every name trellis answers to (canonical + legacy), lower-cased, for a membership
 *  test that anchors on the real vocabulary instead of a loose `includes('trellis')`. */
export const TRELLIS_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(
  [...TRELLIS_MCP_TOOL_CANONICAL, ...Object.keys(TRELLIS_MCP_TOOL_ALIASES)].map((n) => n.toLowerCase()),
);

/** Canonical name for a requested tool: itself, or what it was renamed to. */
export function canonicalToolName(name: string): string {
  return TRELLIS_MCP_TOOL_ALIASES[name] ?? name;
}
