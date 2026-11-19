/**
 * The red proof's two speed-ups. `red_pool` keeps a checkout per clone and reuses it, so `red_setup` (a copy of
 * node_modules) runs once, not once per checkout: between runs everything but the kept paths is reset. The verdict
 * cache is box-wide, so a second clone of the same repo reads what the first one ran.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { makeRepo, buildIssue, sh, BUGGY } = require("./helpers/repo");
const { check } = require("../lib/check");
const cfgLib = require("../lib/config");
const pool = require("../lib/pool");

const SETUP = 'mkdir -p deps && echo run >> "$CATALINA_ROOT/../setup.log"';
const pooled = (over = {}) => makeRepo({ config: { red_setup: SETUP, red_pool: { keep: ["deps"] }, ...over } });
const setups = (repo) => (fs.existsSync(path.join(repo.tmp, "setup.log")) ? fs.readFileSync(path.join(repo.tmp, "setup.log"), "utf8").split("\n").filter(Boolean).length : 0);
const run = (repo, n, tip, red = "run", cwd = repo.cwd) => check(n, { cwd, source: "commit", red, sha: tip });
const slotOf = (repo, i = 0) => path.join(pool.poolDir(repo.cwd), `slot-${i}`);
const reasonsOf = (r) => r.reasons.join(" | ");

test("red_pool: red_setup runs once for the base and the sha, and not again on the next run", () => {
  const repo = pooled();
  const { tip } = buildIssue(repo, 300);
  const first = run(repo, 300, tip);
  assert.deepStrictEqual(first.reasons, [], reasonsOf(first));
  assert.strictEqual(setups(repo), 1);
  assert.deepStrictEqual(run(repo, 300, tip).reasons, []);
  assert.strictEqual(setups(repo), 1);
  assert.deepStrictEqual(fs.readdirSync(pool.poolDir(repo.cwd)).sort(), ["slot-0", "slot-0.stamp"]);
});

test("no red_pool: each checkout is a temp worktree with its own red_setup, as before", () => {
  const repo = makeRepo({ config: { red_setup: SETUP } });
  const { tip } = buildIssue(repo, 301);
  assert.deepStrictEqual(run(repo, 301, tip).reasons, []);
  assert.strictEqual(setups(repo), 2);
  assert.strictEqual(fs.existsSync(path.join(repo.tmp, "state", "red-pool")), false);
});

test("red_pool: what a run leaves in the checkout doesn't reach the next, but the kept paths stay", () => {
  const repo = pooled();
  const { tip } = buildIssue(repo, 302);
  assert.deepStrictEqual(run(repo, 302, tip).reasons, []);
  const slot = slotOf(repo);
  fs.writeFileSync(path.join(slot, "src", "add.js"), BUGGY); // a tracked file left changed: the green run would fail
  fs.writeFileSync(path.join(slot, "junk.txt"), "left behind\n");
  fs.mkdirSync(path.join(slot, "ignored-dir"));
  fs.writeFileSync(path.join(slot, "ignored-dir", ".gitignore"), "*\n");
  fs.writeFileSync(path.join(slot, "deps", "kept.txt"), "a dependency\n");
  const again = run(repo, 302, tip);
  assert.deepStrictEqual(again.reasons, [], reasonsOf(again));
  assert.strictEqual(fs.existsSync(path.join(slot, "junk.txt")), false);
  assert.strictEqual(fs.existsSync(path.join(slot, "ignored-dir")), false);
  assert.strictEqual(fs.existsSync(path.join(slot, "deps", "kept.txt")), true);
  assert.strictEqual(setups(repo), 1);
});

test("red_pool: a changed stamp file rebuilds the checkout and runs red_setup again", () => {
  const repo = pooled({ red_pool: { keep: ["deps"], stamp: ["lock.txt"] } });
  repo.write("lock.txt", "one\n");
  const { tip } = buildIssue(repo, 303);
  assert.deepStrictEqual(run(repo, 303, tip).reasons, []);
  assert.strictEqual(setups(repo), 1);
  repo.write("lock.txt", "two\n");
  assert.deepStrictEqual(run(repo, 303, tip).reasons, []);
  assert.strictEqual(setups(repo), 2);
  assert.strictEqual(fs.existsSync(path.join(slotOf(repo), "deps", "kept.txt")), false);
});

test("red_pool: a slot another live run holds is skipped; one a dead run held is taken", () => {
  const repo = pooled();
  const cfg = cfgLib.load(repo.cwd);
  const a = pool.acquire(repo.cwd, cfg);
  const b = pool.acquire(repo.cwd, cfg);
  assert.strictEqual(path.basename(a), "slot-0");
  assert.strictEqual(path.basename(b), "slot-1");
  pool.release(a);
  pool.release(b);
  const dead = spawnSync("true").pid;
  fs.mkdirSync(`${a}.lock`);
  fs.writeFileSync(path.join(`${a}.lock`, "pid"), String(dead));
  const c = pool.acquire(repo.cwd, cfg);
  assert.strictEqual(path.basename(c), "slot-0");
  pool.release(c);
  assert.strictEqual(fs.existsSync(`${a}.lock`), false);
});

test("red_pool: every slot held → the run falls back to temp checkouts", () => {
  const repo = pooled();
  const cfg = cfgLib.load(repo.cwd);
  const held = [];
  for (let s; (s = pool.acquire(repo.cwd, cfg)); ) held.push(s);
  assert.strictEqual(held.length, pool.MAX_SLOTS);
  const { tip } = buildIssue(repo, 304);
  assert.deepStrictEqual(run(repo, 304, tip).reasons, []);
  assert.strictEqual(setups(repo), 2);
  held.forEach(pool.release);
});

test("red_pool: a slot that is no longer this repo's worktree is rebuilt, and the clean never runs in another repo", () => {
  const repo = pooled();
  // The state dir sits inside the project, so a slot that lost its .git file resolves to the project's own checkout.
  process.env.CATALINA_STATE_DIR = path.join(repo.cwd, ".state");
  const { tip } = buildIssue(repo, 305);
  assert.deepStrictEqual(run(repo, 305, tip).reasons, []);
  const slot = slotOf(repo);
  assert.ok(slot.startsWith(path.join(fs.realpathSync(repo.cwd), ".state")) || slot.startsWith(path.join(repo.cwd, ".state")));
  fs.rmSync(path.join(slot, ".git"));
  repo.write("precious.txt", "untracked work\n");
  const again = run(repo, 305, tip);
  assert.deepStrictEqual(again.reasons, [], reasonsOf(again));
  assert.strictEqual(fs.readFileSync(path.join(repo.cwd, "precious.txt"), "utf8"), "untracked work\n");
  assert.strictEqual(setups(repo), 2);
});

test("the red cache is box-wide: a second clone of the repo reads the first clone's verdict", () => {
  const repo = makeRepo();
  const { tip } = buildIssue(repo, 306);
  repo.git("push", "-q", "origin", "issue-306");
  assert.deepStrictEqual(run(repo, 306, tip).reasons, []);
  const dir = path.join(repo.tmp, "state", "o__r", "red-cache");
  assert.strictEqual(fs.readdirSync(dir).length, 1);
  const other = path.join(repo.tmp, "other");
  sh("git", ["clone", "-q", repo.bare, other], repo.tmp);
  sh("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], other);
  const r = run(repo, 306, tip, "cache", other);
  assert.deepStrictEqual(r.reasons, [], reasonsOf(r));
  assert.strictEqual(r.red.cached, true);
});

test("the red cache still reads a verdict from the clone's own git dir (where it lived before)", () => {
  const repo = makeRepo();
  const { tip } = buildIssue(repo, 307);
  assert.deepStrictEqual(run(repo, 307, tip).reasons, []);
  const dir = path.join(repo.tmp, "state", "o__r", "red-cache");
  const legacy = path.join(repo.git("rev-parse", "--path-format=absolute", "--git-common-dir"), "catalina", "red-cache");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.renameSync(dir, legacy);
  const r = run(repo, 307, tip, "cache");
  assert.deepStrictEqual(r.reasons, [], reasonsOf(r));
  assert.strictEqual(r.red.cached, true);
});

test("CATALINA_RED_CACHE still names the cache dir", () => {
  const repo = makeRepo();
  const { tip } = buildIssue(repo, 308);
  process.env.CATALINA_RED_CACHE = path.join(repo.tmp, "named-cache");
  try {
    assert.deepStrictEqual(run(repo, 308, tip).reasons, []);
    assert.strictEqual(fs.readdirSync(process.env.CATALINA_RED_CACHE).length, 1);
    assert.strictEqual(fs.existsSync(path.join(repo.tmp, "state", "o__r", "red-cache")), false);
  } finally {
    delete process.env.CATALINA_RED_CACHE;
  }
});
