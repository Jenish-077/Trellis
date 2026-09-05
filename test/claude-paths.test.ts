import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, dirname } from 'node:path';
import { trellisCliPath, claudeScriptPath } from '../src/claude/paths.js';

test('trellisCliPath is module-relative (cwd-independent) and points at a sibling cli.js', () => {
  const a = trellisCliPath();
  const orig = process.cwd();
  try { process.chdir('/'); assert.equal(trellisCliPath(), a, 'must not depend on cwd / project dir'); }
  finally { process.chdir(orig); }
  assert.match(a, /[/\\]cli\.js$/);
  // cli.js sits one level above the claude module dir → its parent dir is src (tsx) or dist (built)
  assert.match(basename(dirname(a)), /^(src|dist)$/);
});

test('claudeScriptPath resolves a sibling script in the claude dir (cwd-independent)', () => {
  const a = claudeScriptPath('sync-run.js');
  const orig = process.cwd();
  try { process.chdir('/'); assert.equal(claudeScriptPath('sync-run.js'), a); }
  finally { process.chdir(orig); }
  assert.match(a, /[/\\]sync-run\.js$/);
  assert.equal(basename(dirname(a)), 'claude');
});
