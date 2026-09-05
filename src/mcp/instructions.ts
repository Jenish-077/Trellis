/**
 * The `instructions` string returned in trellis's MCP `initialize` response.
 *
 * This is the one piece of trellis prose that survives **tool deferral**. When a
 * host has more tools than its schema budget allows, it sends tool *names* only
 * and withholds the JSONSchemas until a `ToolSearch`-style lookup fetches them —
 * measured in a real session: 111 tools deferred, of which trellis's six arrived as
 * six bare strings with no descriptions at all. The MCP spec's `instructions`
 * field is delivered on a separate track (Claude Code records it as its own
 * `mcp_instructions_delta` context layer), so it lands whole even then. Other
 * servers already rely on this — `claude-in-chrome` uses it for exactly the
 * batch-your-ToolSearch instruction below; trellis used to send nothing.
 *
 * Two jobs, in this order:
 *   1. Defuse the deferral tax. One lookup loads all six tools for the whole
 *      session, so the cost is a single round trip, not two calls per use. An
 *      agent that doesn't know this can only assume the worse reading.
 *   2. Say what each tool is FOR as a decision rule, not a feature summary —
 *      because in a host with no hooks and no skill listing (a plain chat client
 *      with an MCP config), this string plus the tool descriptions are the entire
 *      steering budget trellis gets.
 *
 * Budget: keep this under ~1,000 characters. Observed sibling servers sit at
 * 660–984, and nothing proves a longer one survives un-truncated.
 */

/** Tool names in the order an agent should reach for them, most-used first. */
const TOOL_ORDER = [
  'trellis_find_code',
  'trellis_find_all',
  'trellis_trace_calls',
  'trellis_file_api',
  'trellis_repo_map',
] as const;

/** The `select:` argument that loads every trellis tool in one lookup. */
export function toolSearchQuery(prefix = 'mcp__trellis__'): string {
  return `select:${TOOL_ORDER.map((t) => `${prefix}${t}`).join(',')}`;
}

export function mcpInstructions(): string {
  return [
    'This repo is indexed by trellis: a prebuilt graph of every symbol, its file:line',
    'span, and who calls what. Prefer these tools over grep/read — one call usually',
    'replaces several file reads.',
    '',
    `**If these tools are deferred (names shown, schemas withheld), load them all in ONE lookup:** ToolSearch "${toolSearchQuery()}" — one round trip for the whole session. Never load them one at a time.`,
    '',
    '- trellis_find_code — "how does X work" / "where is Y": ranked hits, code inlined.',
    '- trellis_find_all — when you need EVERY occurrence; find_code is top-N and misses some.',
    '- trellis_trace_calls — who calls it, what it calls, blast radius before a rename.',
    '- trellis_file_api — a file\'s whole API in ~200 tokens.',
    '- trellis_repo_map — orientation in an unfamiliar repo.',
    '',
    'Results already reflect uncommitted edits — the graph refreshes before each query.',
  ].join('\n');
}
