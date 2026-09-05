import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyToolUse,
  commandInvokesTrellis,
  isTrellisMcpTool,
  isMcpToolName,
  parseSavings,
  recordToolUse,
  latestSession,
  formatSessionStats,
} from '../src/claude/session-metrics.js';
import { readSession } from '../src/claude/state.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'trellis-metrics-')); }

// ── the classifier: the load-bearing table ────────────────────────────────

/**
 * Every host names its tools differently; this is the one place those names are
 * mapped to trellis / source / neither. The MCP rows cover the three prefixes a
 * trellis tool arrives under across hosts (bare, `MCP:`, `mcp__…__`) — the matcher
 * must recognise all three, since it is what decides whether a call is counted.
 */
const CASES: Array<{ name: string; command?: string; want: 'trellis' | 'source' | null }> = [
  // trellis MCP tools, every host prefix
  { name: 'trellis_find_code', want: 'trellis' },
  { name: 'MCP:trellis_find_code', want: 'trellis' },
  { name: 'mcp__trellis__trellis_find_code', want: 'trellis' },
  { name: 'trellis_repo_map', want: 'trellis' },
  // native source-read tools (Claude + Cursor)
  { name: 'Read', want: 'source' },
  { name: 'Grep', want: 'source' },
  { name: 'Glob', want: 'source' },
  { name: 'Search', want: 'source' },
  // shell running the trellis CLI → trellis
  { name: 'Bash', command: 'trellis ask "how does auth work"', want: 'trellis' },
  { name: 'Shell', command: 'trellis map', want: 'trellis' },
  { name: 'Shell', command: 'npx -y @jenish-077/trellis callers foo', want: 'trellis' },
  { name: 'Bash', command: 'node dist/cli.js grep bar', want: 'trellis' },
  // shell running something else → neither
  { name: 'Bash', command: 'ls -la', want: null },
  { name: 'Shell', command: 'git status', want: null },
  // a path that merely contains "trellis" is not an invocation
  { name: 'Bash', command: './mytrellis/run.sh', want: null },
  // a third-party MCP tool whose NAME merely contains "trellis" is NOT a trellis read —
  // the name test is anchored on the real vocabulary, not a loose substring
  { name: 'mytrellis_search', want: null },
  { name: 'trellis-adjacent-tool', want: null },
  { name: 'some__trellis__tool', want: null },
  // edits / spawns / unknown → neither
  { name: 'Write', want: null },
  { name: 'Edit', want: null },
  { name: 'Task', want: null },
  { name: '', want: null },
];

for (const c of CASES) {
  test(`classifyToolUse(${c.name || '∅'}${c.command ? ` :: ${c.command}` : ''}) → ${c.want}`, () => {
    assert.equal(classifyToolUse(c.name, c.command), c.want);
  });
}

test('isTrellisMcpTool recognises trellis tools across prefixes, and rejects lookalikes', () => {
  // every host prefix, canonical and legacy names
  assert.ok(isTrellisMcpTool('MCP:trellis_find_code'));
  assert.ok(isTrellisMcpTool('mcp__trellis__trellis_find_code'));
  assert.ok(isTrellisMcpTool('trellis_trace_calls'));
  assert.ok(isTrellisMcpTool('trellis_ask'), 'a legacy alias still counts');
  // anchored on the real name list — a third-party tool that merely CONTAINS
  // "trellis" must not be counted as a trellis read
  assert.ok(!isTrellisMcpTool('Read'));
  assert.ok(!isTrellisMcpTool('mytrellis_search'));
  assert.ok(!isTrellisMcpTool('trellis-adjacent-tool'));
  assert.ok(!isTrellisMcpTool('mcp__other__trellis_helper'));
});

test('isMcpToolName recognises the server-prefixed shapes', () => {
  assert.ok(isMcpToolName('MCP:trellis_find_code'));
  assert.ok(isMcpToolName('mcp__trellis__trellis_find_code'));
  assert.ok(!isMcpToolName('Read'));
  assert.ok(!isMcpToolName('Shell'));
});

test('commandInvokesTrellis is anchored — not fooled by a substring path', () => {
  assert.ok(commandInvokesTrellis('trellis ask x'));
  assert.ok(commandInvokesTrellis('cd repo && trellis map'));
  assert.ok(!commandInvokesTrellis('cat mytrellis.txt'));
  assert.ok(!commandInvokesTrellis('echo uptrellis'));
});

// ── parseSavings ───────────────────────────────────────────────────────────

test('parseSavings sums every footer, tolerant of commas', () => {
  assert.equal(parseSavings('nothing here'), 0);
  assert.equal(parseSavings('[trellis] tokens saved ≈ 2,181 (89%) — …'), 2181);
  assert.equal(
    parseSavings('a\n[trellis] tokens saved ≈ 100 — …\nb\n[trellis] tokens saved ≈ 1,000 — …'),
    1100,
  );
});

// ── recordToolUse ──────────────────────────────────────────────────────────

test('recordToolUse increments the right counter and accumulates savings', () => {
  const d = fresh();
  recordToolUse(d, 's1', { kind: 'trellis', savedTokens: 500 });
  recordToolUse(d, 's1', { kind: 'trellis' });
  recordToolUse(d, 's1', { kind: 'source' });
  const s = readSession(d, 's1');
  assert.equal(s.trellisReads, 2);
  assert.equal(s.sourceReads, 1);
  assert.equal(s.savedTokens, 500);
});

test('recordToolUse is a no-op when there is nothing to record (no file written)', () => {
  const d = fresh();
  recordToolUse(d, 's1', { kind: null, savedTokens: 0 });
  recordToolUse(d, 's1', {});
  // readSession returns the empty default without a file; the proof it never
  // wrote is that a fresh empty session equals what we read.
  const s = readSession(d, 's1');
  assert.equal(s.trellisReads, 0);
  assert.equal(s.sourceReads, 0);
  assert.equal(s.savedTokens, 0);
});

test('recordToolUse can log savings on a trellis read with no explicit kind classification', () => {
  const d = fresh();
  recordToolUse(d, 's1', { kind: 'trellis', savedTokens: 1990 });
  assert.equal(readSession(d, 's1').savedTokens, 1990);
  assert.equal(readSession(d, 's1').trellisReads, 1);
});

test('recordToolUse stamps the host once — the first tool use owns the attribution', () => {
  const d = fresh();
  recordToolUse(d, 's1', { kind: 'trellis', host: 'cursor' });
  assert.equal(readSession(d, 's1').host, 'cursor');
  // a later use from a different host must not overwrite the stamp
  recordToolUse(d, 's1', { kind: 'source', host: 'claude-code' });
  assert.equal(readSession(d, 's1').host, 'cursor', 'host is not re-stamped');
});

// ── latestSession + formatSessionStats (what `trellis stats` reads) ──────────

function writeSession(d: string, id: string, body: object, ageMs = 0): void {
  const dir = join(d, 'trellis', '.cache', 'session');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${id}.json`);
  writeFileSync(p, JSON.stringify(body));
  if (ageMs) { const w = new Date(Date.now() - ageMs); utimesSync(p, w, w); }
}

test('latestSession returns null when no session exists', () => {
  assert.equal(latestSession(fresh()), null);
});

test('latestSession picks the most recently touched session file', () => {
  const d = fresh();
  writeSession(d, 'old', { trellisReads: 1, sourceReads: 9 }, 60_000);
  writeSession(d, 'new', { trellisReads: 8, sourceReads: 2 }, 0);
  const s = latestSession(d)!;
  assert.equal(s.id, 'new');
  assert.equal(s.trellisReads, 8);
});

test('formatSessionStats renders the mix, savings and last query', () => {
  const out = formatSessionStats({
    id: 'abc', lastQuery: 'where is auth', perAgentQuery: {},
    trellisReads: 8, sourceReads: 2, savedTokens: 12345,
  });
  assert.match(out, /session abc/);
  assert.match(out, /trellis reads:\s+8/);
  assert.match(out, /source reads:\s+2/);
  assert.match(out, /80% trellis/);
  assert.match(out, /12,345/);
  assert.match(out, /where is auth/);
});

test('formatSessionStats has a friendly empty state', () => {
  assert.match(formatSessionStats(null), /no session recorded yet/);
});

test('formatSessionStats prices the saving once the session has been billed', () => {
  // Billed $0.60 for 1M input tokens = $0.60/Mtok, so 100k saved is worth $0.06 —
  // which formats as <$0.01? No: $0.06. The point is that it is the MEASURED
  // rate, an order of magnitude under this model's $5/Mtok list price.
  const out = formatSessionStats({
    id: 'abc', lastQuery: null, perAgentQuery: {},
    trellisReads: 8, sourceReads: 2, savedTokens: 100_000,
    inputCostMicros: 600_000, inputTokensBilled: 1_000_000,
  });
  assert.match(out, /tokens saved:\s+~100,000/);
  assert.match(out, /value saved:\s+~\$0\.06/);
});

test('formatSessionStats omits the dollar line rather than claiming zero', () => {
  // Cursor: its hooks name no transcript, so nothing has ever been billed. The
  // token count still stands; a "$0.00" next to it would be a false claim.
  const out = formatSessionStats({
    id: 'abc', lastQuery: null, perAgentQuery: {},
    trellisReads: 8, sourceReads: 2, savedTokens: 100_000,
  });
  assert.match(out, /tokens saved:\s+~100,000/);
  assert.doesNotMatch(out, /value saved/);
  assert.doesNotMatch(out, /\$/);
});
