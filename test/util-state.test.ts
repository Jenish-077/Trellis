/**
 * Persisted local build configuration.
 *
 * Explicit directory and submodule choices must survive later no-flag builds
 * and the hooks/refresh path, which never sees CLI flags. These tests pin the
 * round-trip and merge contracts independently of the CLI wiring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConfigPath,
  cacheDir,
  patchBuildConfig,
  readBuildConfig,
  readFollowSubmodules,
  readIncludeDirs,
  resolveContextDir,
  writeBuildConfig,
} from "../src/util/state.js";

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "trellis-buildconfig-"));
}

test("readBuildConfig returns null when nothing was ever persisted", () => {
  const d = fresh();
  assert.equal(readBuildConfig(d), null);
  assert.equal(readIncludeDirs(d), undefined, "no persisted config -> today's default (no includes)");
  assert.equal(readFollowSubmodules(d), false, "no persisted config -> historical submodule boundary");
});

test("writeBuildConfig + readBuildConfig round-trip includeDirs", () => {
  const d = fresh();
  writeBuildConfig(d, { includeDirs: ["build", "vendor"] });
  assert.deepEqual(readBuildConfig(d), { includeDirs: ["build", "vendor"] });
  assert.equal(buildConfigPath(d), join(d, ".trellis", "config.json"));
  assert.equal(existsSync(join(d, "trellis", ".cache", "config.json")), false);
  assert.match(readFileSync(join(d, ".gitignore"), "utf8"), /^\/\.trellis\/$/m);
});

test("readIncludeDirs turns a persisted list into a Set; an empty persisted list reads as undefined (default behavior)", () => {
  const d = fresh();
  writeBuildConfig(d, { includeDirs: ["build"] });
  assert.deepEqual(readIncludeDirs(d), new Set(["build"]));

  writeBuildConfig(d, { includeDirs: [] });
  assert.equal(readIncludeDirs(d), undefined, "an empty list must read exactly like no list at all");
});

test("followSubmodules round-trips true and explicit false", () => {
  const d = fresh();
  writeBuildConfig(d, { followSubmodules: true });
  assert.equal(readFollowSubmodules(d), true);

  writeBuildConfig(d, { followSubmodules: false });
  assert.deepEqual(readBuildConfig(d), { followSubmodules: false });
  assert.equal(readFollowSubmodules(d), false);
});

test("patchBuildConfig preserves unrelated persisted build choices", () => {
  const d = fresh();
  writeBuildConfig(d, { includeDirs: ["build"] });
  patchBuildConfig(d, { followSubmodules: true });
  assert.deepEqual(readBuildConfig(d), {
    includeDirs: ["build"],
    followSubmodules: true,
  });

  patchBuildConfig(d, { includeDirs: ["vendor"] });
  assert.deepEqual(readBuildConfig(d), {
    includeDirs: ["vendor"],
    followSubmodules: true,
  });

  patchBuildConfig(d, { followSubmodules: false });
  assert.deepEqual(readBuildConfig(d), {
    includeDirs: ["vendor"],
    followSubmodules: false,
  });
});

// ── resolveContextDir / TRELLIS_DIR ──────────────────────────────────────────
//
// Everything in this module keyed only by a project dir (stats cache, sync
// lock, session state, the upkeep stamp) resolves its `trellis/` subpath
// through resolveContextDir, so hooks/sync-run/statusline honor TRELLIS_DIR
// the same way a direct `--dir` CLI call already does via contextDirFor.

function withTrellisDir<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.TRELLIS_DIR;
  if (value === undefined) delete process.env.TRELLIS_DIR; else process.env.TRELLIS_DIR = value;
  try { return fn(); }
  finally { if (prev === undefined) delete process.env.TRELLIS_DIR; else process.env.TRELLIS_DIR = prev; }
}

test("resolveContextDir defaults to <projectDir>/trellis when TRELLIS_DIR is unset", () => {
  const d = fresh();
  withTrellisDir(undefined, () => {
    assert.equal(resolveContextDir(d), join(d, "trellis"));
    assert.equal(cacheDir(d), join(d, "trellis", ".cache"));
  });
});

test("resolveContextDir resolves a relative TRELLIS_DIR against projectDir", () => {
  const d = fresh();
  withTrellisDir(".repo-docs/trellis", () => {
    assert.equal(resolveContextDir(d), join(d, ".repo-docs", "trellis"));
    assert.equal(cacheDir(d), join(d, ".repo-docs", "trellis", ".cache"));
  });
});

test("resolveContextDir takes an absolute TRELLIS_DIR verbatim", () => {
  const d = fresh();
  const abs = join(tmpdir(), "trellis-context-elsewhere");
  withTrellisDir(abs, () => {
    assert.equal(resolveContextDir(d), abs);
    assert.equal(cacheDir(d), join(abs, ".cache"));
  });
});
