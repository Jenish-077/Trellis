import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillTemplate } from '../src/claude/skill-template.js';

test('skill template is a well-formed SKILL.md', () => {
  const src = skillTemplate();
  assert.ok(src.startsWith('---\n'), 'starts with YAML frontmatter');
  assert.match(src, /^name: trellis$/m, 'declares name: trellis');
  assert.match(src, /^description:/m, 'has a description');
  const body = src.split(/\n---\n/)[1] ?? '';
  assert.ok(body.trim().length > 0, 'has a non-empty body');
  assert.match(body, /trellis ask/, 'body tells the agent to use `trellis ask`');
  assert.match(body, /every occurrence/i, 'body teaches the exhaustive-task grep rule');
  assert.match(body, /trellis callers/, 'body teaches the callers command');
  assert.match(body, /--direction out/, 'body teaches callees via --direction out');
  assert.match(body, /--depth/, 'body teaches blast radius via --depth');
  assert.match(body, /truncated/i, 'body tells the agent to follow up on truncated spans');
  assert.match(body, /trellis grep/, 'body routes sweeps to trellis grep');
  assert.match(body, /trellis map/, 'body tells the agent to orient with trellis map before exploring');
  assert.match(body, /\[scope\/\]/, 'body teaches the [scope/] label on multi-scope hits');
  assert.match(body, /--in <scope>\//, 'body teaches narrowing with ask --in <scope>/');
  assert.match(body, /tokens saved/i, 'body references the tokens-saved footer');
  assert.match(body, /every turn/i, 'body tells the agent to report savings each turn');
});
