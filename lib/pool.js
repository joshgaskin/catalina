/**
 * Catalina — reusable red-proof checkouts (`red_pool` in .catalina/config.json).
 *
 * A red proof needs a checkout of the merge-base and one of the shipped commit, and `red_setup` (usually a copy of
 * node_modules) is most of what each costs. With `red_pool: { keep: [...] }` a run takes a slot, a worktree kept
 * under <state dir>/red-pool/<clone>/slot-N, and moves it from ref to ref: `git checkout -f` plus
 * `git clean -ffdx` of everything but the `keep` patterns, so only what `red_setup` made survives a run. A slot is
 * built (worktree add + red_setup) once, and again when its stamp changes: red_setup, the keep list, or the content
 * of a `stamp` file in the project (name the file that changes when dependencies are installed).
 *
 * One run holds a slot at a time (a lock dir with the holder's pid). When every slot is held the caller falls back
 * to temp checkouts. The slots are outside any `.git` dir: vitest ignores test files under one.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const g = require("./git");
const { stateDir } = require("./gatelog");

const MAX_SLOTS = 4;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const real = (p) => fs.realpathSync(p);

const keepOf = (cfg) => (Array.isArray(cfg.red_pool?.keep) ? cfg.red_pool.keep.filter((k) => typeof k === "string" && k.trim()) : []);

/** The clone's slots: one dir per git common dir, so worktrees of a clone share them and two clones never do. */
function poolDir(cwd) {
  const common = real(g.commonDir(cwd));
  const name = path.basename(path.basename(common) === ".git" ? path.dirname(common) : common);
  return path.join(stateDir(), "red-pool", `${name}-${sha256(common).slice(0, 10)}`);
}

/** Whether the lock's holder is gone: its pid no longer runs, or the lock is older than any run can be. */
function stale(lock, maxAgeMs) {
  let age;
  try {
    age = Date.now() - fs.statSync(lock).mtimeMs;
  } catch {
    return false; // released meanwhile: the next mkdir decides
  }
  if (age > maxAgeMs) return true;
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8"));
  } catch {}
  if (!pid) return false; // just made, pid not written yet
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
}

function lockSlot(lock, maxAgeMs) {
  const take = () => {
    try {
      fs.mkdirSync(lock);
    } catch (e) {
      if (e.code === "EEXIST") return false;
      throw e;
    }
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
    return true;
  };
  if (take()) return true;
  if (!stale(lock, maxAgeMs)) return false;
  // Move the dead lock aside before removing it: of two runs that both saw it stale, one rename wins.
  const aside = `${lock}.${process.pid}`;
  try {
    fs.renameSync(lock, aside);
  } catch {
    return false;
  }
  fs.rmSync(aside, { recursive: true, force: true });
  return take();
}

/** A free slot's path, locked for this process, or null: red_pool isn't set, or every slot is held. */
function acquire(cwd, cfg) {
  if (!keepOf(cfg).length) return null;
  const dir = poolDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const maxAgeMs = (cfg.red_timeout_s || 300) * 1000 * 4 + 60000; // a mutant proof is three runs
  for (let i = 0; i < MAX_SLOTS; i++) {
    const slot = path.join(dir, `slot-${i}`);
    if (lockSlot(`${slot}.lock`, maxAgeMs)) return slot;
  }
  return null;
}

function release(slot) {
  fs.rmSync(`${slot}.lock`, { recursive: true, force: true });
}

function stamp(cfg, root) {
  const files = (cfg.red_pool.stamp || []).map((f) => {
    try {
      return [f, sha256(fs.readFileSync(path.join(root, f)))];
    } catch {
      return [f, null];
    }
  });
  return sha256(JSON.stringify({ setup: cfg.red_setup || null, keep: keepOf(cfg), files }));
}

/**
 * Whether the slot is this clone's worktree, built under this stamp. The top-level check matters: `git clean` in a
 * dir that isn't its own worktree would clean whichever repo holds it.
 */
function usable(slot, want, cwd) {
  try {
    if (fs.readFileSync(`${slot}.stamp`, "utf8") !== want) return false;
    return real(g.topLevel(slot)) === real(slot) && real(g.commonDir(slot)) === real(g.commonDir(cwd));
  } catch {
    return false;
  }
}

/** The slot, checked out at `ref` with nothing in it but that tree and the kept paths. `setup(dir)` runs red_setup. */
function prepare(slot, ref, { cwd, cfg, root, setup }) {
  const want = stamp(cfg, root);
  if (usable(slot, want, cwd)) {
    const clean = ["clean", "-q", "-ffdx", ...keepOf(cfg).flatMap((k) => ["-e", k])];
    try {
      g.git(clean, slot);
      g.git(["checkout", "-q", "-f", "--detach", ref], slot);
      g.git(clean, slot);
      return slot;
    } catch {} // a broken slot (a killed run's index.lock, say): build it again
  }
  fs.rmSync(`${slot}.stamp`, { force: true });
  g.tryGit(["worktree", "remove", "--force", slot], cwd);
  fs.rmSync(slot, { recursive: true, force: true });
  g.tryGit(["worktree", "prune"], cwd);
  g.git(["worktree", "add", "-q", "--detach", slot, ref], cwd);
  setup(slot);
  fs.writeFileSync(`${slot}.stamp`, want);
  return slot;
}

module.exports = { acquire, release, prepare, poolDir, MAX_SLOTS };
