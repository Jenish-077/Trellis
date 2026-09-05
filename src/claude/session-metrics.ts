/**
 * Session usage accounting, shared across every host (Claude Code, Cursor, and
 * plain MCP). It answers the one question the README rests on: when an agent had
 * both trellis and grep in front of it, which did it reach for, and how much did
 * that save?
 *
 * The counters (`trellisReads`, `sourceReads`, `savedTokens`) already live on
 * {@link SessionState}; before this module nothing ever incremented the first
 * two, so `session_summary` telemetry shipped 0/0 for every session. Everything
 * here is a pure classify + read-modify-write over `trellis/.cache/session/`, so a
 * host adapter is a few lines: parse its payload, call {@link recordToolUse}.
 *
 * Two payload shapes feed it, confirmed against the vendor docs rather than
 * guessed (the matcher depends on getting the names right):
 *
 *   - Claude Code `PostToolUse`  — `{ tool_name, tool_input: { command }, tool_response }`.
 *     A trellis retrieval prints a `[trellis] tokens saved ≈ N` footer into
 *     `tool_response`, which is itself proof trellis ran.
 *   - Cursor `postToolUse`       — `{ tool_name, tool_input, tool_output, conversation_id }`
 *     (https://cursor.com/docs/hooks). `tool_output` is the JSON-stringified
 *     result; a Shell `trellis …` call carries the same footer inside its stdout.
 *   - Cursor `afterMCPExecution` — `{ tool_name, tool_input, result_json, duration }`.
 *     Fires only for MCP tools, so a trellis tool is recognised by its name and
 *     its savings read out of `result_json`.
 *
 * MCP tool names arrive host-prefixed in different shapes (`trellis_find_code`,
 * `MCP:trellis_find_code`, `mcp__trellis__trellis_find_code`). {@link isTrellisMcpTool}
 * strips the prefix to the last delimited segment and checks it against the real
 * name list (`TRELLIS_MCP_TOOL_NAMES`), so a trellis tool is recognised across every
 * host format while a third-party tool that merely contains "trellis" is not.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { sumSavingsFooters } from '../context/savings.js';
import { dollarsSaved, formatDollars } from '../context/price.js';
import { readSession, writeSession, sessionDir, listSessionIds, type SessionState } from './state.js';
import type { AgentHost } from '../telemetry/contract.js';
import { TRELLIS_MCP_TOOL_NAMES } from '../mcp/tool-names.js';

export type ToolKind = 'trellis' | 'source';

/** Native tools that mean "the agent went to read source itself" — the grep/read
 *  path trellis is meant to replace. These are the host tool NAMES (Claude Code and
 *  Cursor both use Read/Grep/Glob; Cursor adds Search); shell builtins like `ls`
 *  are commands, never tool names, so they belong to the Shell branch, not here.
 *  Compared lower-cased. */
const SOURCE_TOOLS = new Set(['read', 'grep', 'glob', 'search']);

/** The host's shell tool, whose `command` we then inspect for a trellis invocation. */
function isShellTool(t: string): boolean {
  return t === 'bash' || t === 'shell';
}

/** An MCP-style tool name (server-prefixed), as opposed to a native Read/Shell.
 *  Used to hand trellis MCP calls to the dedicated MCP hook so a host that fires
 *  BOTH a generic post-tool hook and an MCP hook can't double-count them. */
export function isMcpToolName(toolName: string): boolean {
  const t = toolName.toLowerCase();
  return t.startsWith('mcp') || t.includes(':') || t.includes('__');
}

/**
 * Whether a tool name is one of trellis's MCP tools, across every host prefix.
 * Anchored on the real name list (`trellis_find_code`, its legacy aliases, …), not
 * a loose `includes('trellis')`: a third-party MCP tool whose name merely contains
 * "trellis" (or a repo working on trellis itself) must not count as a trellis read —
 * the same care `commandInvokesTrellis` takes for the CLI side. Strips the host
 * prefix first (`mcp__trellis__trellis_find_code`, `MCP:trellis_find_code`) by taking
 * the last delimited segment. */
export function isTrellisMcpTool(toolName: string): boolean {
  const t = toolName.toLowerCase();
  const bare = t.split(/[:./]|__/).pop() ?? t;
  return TRELLIS_MCP_TOOL_NAMES.has(bare);
}

/** Whether a shell command line invokes the trellis CLI (any of its install shapes). */
export function commandInvokesTrellis(command: string): boolean {
  const c = command.trim();
  if (/dist[/\\]cli\.js/.test(c)) return true; // running from a source checkout
  // `trellis …`, `trellis-dev …`, `npx [-y] [@jenish-077/]trellis …`, at the start of the
  // line or of a &&/;/| segment — not "mytrellis" or a path that merely contains it.
  return /(^|[|&;]\s*)(npx\s+(-y\s+)?(@jenish-077\/)?)?trellis(-dev)?\b/i.test(c);
}

/**
 * Classify one tool use as a trellis retrieval, a source read, or neither
 * (an edit, a task spawn, an unrelated shell command — no retrieval signal).
 * `command` is the shell command line when `toolName` is the host's shell tool.
 */
export function classifyToolUse(toolName?: string, command?: string): ToolKind | null {
  const t = (toolName ?? '').toLowerCase();
  if (!t) return null;
  if (isTrellisMcpTool(t)) return 'trellis';
  if (SOURCE_TOOLS.has(t)) return 'source';
  if (isShellTool(t) && command && commandInvokesTrellis(command)) return 'trellis';
  return null;
}

/** Sum every `[trellis] tokens saved ≈ N` footer in a blob of tool output. Thin
 *  alias over {@link sumSavingsFooters}, which lives next to the code that writes
 *  the footer so the two can't drift. */
export function parseSavings(blob: string): number {
  return sumSavingsFooters(blob);
}

export interface ToolUse {
  /** 'trellis' → trellisReads++, 'source' → sourceReads++, null/absent → neither. */
  kind?: ToolKind | null;
  /** Tokens the retrieval saved, parsed from its footer. Added to the running total. */
  savedTokens?: number;
  /** The host recording this use. Stamped on the session file (once) so the
   * `session_summary` is attributed correctly no matter which host later flushes it. */
  host?: AgentHost;
}

/**
 * Fold one tool use into a session's counters. A no-op when there is nothing to
 * record (kind null and no savings), so a host can call it unconditionally after
 * every tool without first checking whether the tool was interesting — the
 * no-write path is what keeps it cheap on the Write/Edit/Task majority.
 *
 * Best-effort read-modify-write, not locked — mirroring `patchStats` in
 * util/state.ts. Two tool-use hooks racing on the same session file can lose a
 * count; that is acceptable for an episodic usage estimate (worst case is an
 * undercount by one, never corruption thanks to the atomic write), and a lock
 * here would contend with the build lock these hooks also touch.
 */
export function recordToolUse(dir: string, sessionId: string, use: ToolUse): void {
  const saved = use.savedTokens ?? 0;
  if (!use.kind && saved <= 0) return;
  const id = sessionId || 'default';
  const s = readSession(dir, id);
  if (use.kind === 'trellis') s.trellisReads = (s.trellisReads ?? 0) + 1;
  else if (use.kind === 'source') s.sourceReads = (s.sourceReads ?? 0) + 1;
  if (saved > 0) s.savedTokens = (s.savedTokens ?? 0) + saved;
  // A trellis use owes a tally in this turn's reply; the Stop hook (countTallyTurn)
  // resolves whether it got one and clears the flag. A flag, not a count — a turn
  // with several trellis calls is still one reply to the user.
  if (use.kind === 'trellis') s.turnUsedTrellis = true;
  // Stamp the host once; the first tool use that lands owns the attribution.
  if (use.host && !s.host) s.host = use.host;
  writeSession(dir, id, s);
}

export interface SessionSummary extends SessionState {
  id: string;
}

/** The most-recently-touched session file for a repo, or null when none exist —
 *  what `trellis stats` shows by default: the session you were just in. */
export function latestSession(dir: string): SessionSummary | null {
  const sdir = sessionDir(dir);
  let bestId: string | null = null;
  let bestMtime = -Infinity;
  for (const id of listSessionIds(dir)) {
    let mtime: number;
    try { mtime = statSync(join(sdir, `${id}.json`)).mtimeMs; } catch { continue; }
    if (mtime > bestMtime) { bestMtime = mtime; bestId = id; }
  }
  if (bestId === null) return null;
  return { id: bestId, ...readSession(dir, bestId) };
}

/**
 * A one-line-per-fact readout of a session's usage mix — Cursor has no
 * statusline, so this is how you see the numbers the Claude Code bar would show.
 * Reads local JSON only; sends nothing.
 */
/**
 * What this repo's most recent session has actually been paying per million
 * input tokens, or null when no turn has been billed yet.
 *
 * `latestSession` rather than a session id because the callers are CLI and MCP
 * processes answering one query: they know the repo, never the host's session
 * id. The rate belongs to the repo's current session, which is the one whose
 * reply the number is about to appear in.
 */
export function sessionInputRate(dir: string): number | null {
  const s = latestSession(dir);
  if (!s?.inputCostMicros || !s?.inputTokensBilled) return null;
  // Micro-dollars per token and dollars per million tokens are the same number:
  // both divide by 1e6 once. Returned as $/Mtok because that is the unit the
  // price table is written in and the one a reader can sanity-check against it.
  return s.inputCostMicros / s.inputTokensBilled;
}

export function formatSessionStats(s: SessionSummary | null): string {
  if (s === null) {
    return 'trellis stats: no session recorded yet — use trellis in an agent session, then look again.';
  }
  const trellis = s.trellisReads ?? 0;
  const source = s.sourceReads ?? 0;
  const saved = s.savedTokens ?? 0;
  const total = trellis + source;
  const mix =
    total === 0 ? 'no retrieval yet' : `${Math.round((trellis / total) * 100)}% trellis`;
  const lines = [
    `trellis stats — session ${s.id}`,
    `  trellis reads:   ${trellis}`,
    `  source reads:  ${source}   (Read / Grep / Glob)`,
    `  mix:           ${mix}`,
    `  tokens saved:  ~${saved.toLocaleString()}`,
  ];
  // Omitted, not zeroed, when no turn has been billed yet: a host whose hooks
  // name no transcript can't know what a token costs here, and a made-up rate
  // would be worse than the silence.
  const usd = dollarsSaved(saved, s.inputCostMicros, s.inputTokensBilled);
  if (usd !== null) lines.push(`  value saved:   ~${formatDollars(usd)}`);
  if (s.lastQuery) lines.push(`  last query:    ${s.lastQuery}`);
  return lines.join('\n');
}
