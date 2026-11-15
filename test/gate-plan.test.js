/**
 * #27 second witness: the gate moves off the session repo only for a simple script (a flat list of simple commands
 * joined by && or ;, with nothing that might not run or that the gate can't read). Anything else is checked in every
 * repo the text could reach, the session repo first, so it is never looser than main's gate.
 *
 * Table tests over every hostile case the witnesses wrote (test/fixtures/gate-cases/*.tpl; @P is plus2, @H hatchery,
 * @T a dir outside any repo). The invariant, for every case: the issues main checks (legacyFlip, in the session repo)
 * are checked by plan(), unless the script is simple and its flip's target resolved (or carries the bypass).
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { plan, legacyFlip, parseFlips, resolveFlip } = require("../hooks/lib/target-repo");

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (args, cwd) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** home/Documents/dev/projects/{plus2,hatchery} with joshgaskin remotes, plus2's issue-2228 worktree, and a non-repo dir. */
function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "catalina-plan-")));
  const projects = path.join(home, "Documents", "dev", "projects");
  const dirs = {};
  for (const [key, name, url] of [
    ["P", "plus2", "git@github.com:joshgaskin/plus2.git"],
    ["H", "hatchery", "https://github.com/joshgaskin/hatchery.git"],
  ]) {
    const d = path.join(projects, name);
    fs.mkdirSync(path.join(d, ".claude", "tracking"), { recursive: true });
    git(["init", "-q", "-b", "main"], d);
    git(["remote", "add", "origin", url], d);
    git(["commit", "-q", "--allow-empty", "-m", "init"], d);
    dirs[key] = d;
  }
  git(["worktree", "add", "-q", ".claude/worktrees/issue-2228", "-b", "issue-2228"], dirs.P);
  dirs.T = path.join(home, "tmp");
  fs.mkdirSync(dirs.T);
  return { home, ...dirs };
}

const fx = fixture();
const at = (s) => String(s).replace(/@P/g, fx.P).replace(/@H/g, fx.H).replace(/@T/g, fx.T);
const run = (cmd, cwd = fx.P, env = {}) => plan(at(cmd), { cwd: at(cwd), env, home: fx.home });
const top = (d) => {
  try {
    return git(["rev-parse", "--show-toplevel"], d);
  } catch {
    return d;
  }
};
const has = (p, n, dir) => p.gates.some((g) => g.n === String(n) && g.dir === dir);
const flipNumbers = (p) => p.flips.flatMap((f) => f.numbers);

const CASES = [];
for (const file of fs.readdirSync(path.join(__dirname, "fixtures", "gate-cases")).sort()) {
  for (const line of fs.readFileSync(path.join(__dirname, "fixtures", "gate-cases", file), "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [cwd, ...rest] = line.split("\t");
    CASES.push({ file, cwd: at(cwd), command: at(rest.join("\t").replace(/\\n/g, "\n")) });
  }
}

test("#27 the case tables hold every hostile case", () => {
  assert.ok(CASES.length >= 160, `${CASES.length} cases`);
});

test("#27 invariant: every issue main checks is checked, unless the script is simple and its target resolved", () => {
  const bad = [];
  for (const c of CASES) {
    const main = legacyFlip(c.command);
    if (!main) continue;
    const p = plan(c.command, { cwd: c.cwd, env: {}, home: fx.home });
    const session = top(c.cwd);
    let ok;
    if (main.n === null) ok = p.block.length > 0 || (p.mode === "simple" && p.flips.length > 0 && p.flips.every((f) => f.numbers.length));
    else if (p.mode === "complex") ok = has(p, main.n, session) && p.bypassed.length === 0;
    else ok = flipNumbers(p).includes(main.n);
    if (!ok) bad.push(`${c.file} [${path.basename(c.cwd)}] ${c.command.replace(/\n/g, "⏎")}\n    → ${JSON.stringify({ mode: p.mode, gates: p.gates, block: p.block, bypassed: p.bypassed })}`);
  }
  assert.deepStrictEqual(bad, []);
});

test("#27 the second witness's cases are complex: the session repo is checked and the text bypass ignored", () => {
  for (const c of [
    // 1. cd text inside a heredoc body
    "cat > /dev/null <<'X'\ncd @T\nX\ngh issue edit 138 --add-label review",
    "gh issue comment 138 --body-file - <<'EOF'\nRepro:\ncd @T && ls\nEOF\ngh issue edit 138 --add-label review",
    "git commit -F - <<'EOF'\nfix\n\ncd @H\nEOF\ngh issue edit 138 --add-label review",
    // 2. a cd that never runs
    "false && cd @T; gh issue edit 138 --add-label review",
    "[ -d /nope ] && cd @T; gh issue edit 138 --add-label review",
    "test -d /nope && cd @H; gh issue edit 138 --add-label review",
    "cd @H || cd @T; gh issue edit 138 --add-label review",
    "f(){ cd @T; }; gh issue edit 138 --add-label review",
    "function f { cd @H; }; gh issue edit 138 --add-label review",
    "cd @T | cat; gh issue edit 138 --add-label review",
    "cd @T & gh issue edit 138 --add-label review",
    "true # ; cd @T\ngh issue edit 138 --add-label review",
    "# cd @T\ngh issue edit 138 --add-label review",
    "pushd @T && popd && gh issue edit 138 --add-label review",
    "cd @T && cd @P && popd; gh issue edit 138 --add-label review",
    "if false; then cd @T; fi; gh issue edit 138 --add-label review",
    "eval \"cd @T\"; gh issue edit 138 --add-label review",
    "HOME=@T; cd; gh issue edit 138 --add-label review",
    "{ cd @H; }; gh issue edit 138 --add-label review",
    "pushd && gh issue edit 138 --add-label review",
    // 3. a flip the parser can't read beside one it can
    "env -S 'gh issue edit 138 --add-label review' && gh issue edit 99999 --add-label review",
    "if true; then gh issue edit 138 --add-label review; fi; gh issue edit 99999 --add-label review",
    "watch -n1 gh issue edit 138 --add-label review && gh issue edit 99999 --add-label review",
    // 5. a bypass that never runs
    "f(){ export CATALINA_WITNESS_ALLOW=1; }; gh issue edit 138 --add-label review",
    "false && export CATALINA_WITNESS_ALLOW=1; gh issue edit 138 --add-label review",
    "cat <<'X'\nexport CATALINA_WITNESS_ALLOW=1\nX\ngh issue edit 138 --add-label review",
    "true # ; export CATALINA_WITNESS_ALLOW=1\ngh issue edit 138 --add-label review",
  ]) {
    const p = run(c);
    assert.strictEqual(p.mode, "complex", c);
    assert.ok(has(p, 138, fx.P), `${c}: ${JSON.stringify(p.gates)}`);
    assert.deepStrictEqual(p.bypassed, [], c);
    assert.strictEqual(p.notes.filter((n) => /too complex/.test(n)).length, 1, `${c}: one note: ${JSON.stringify(p.notes)}`);
  }
});

test("#27 the backstop counts per flip: every number either read gets checked", () => {
  for (const c of [
    "env -S 'gh issue edit 138 --add-label review' && gh issue edit 99999 --add-label review",
    "if true; then gh issue edit 138 --add-label review; fi; gh issue edit 99999 --add-label review",
    "sudo -u gh gh issue edit 138 --add-label review; gh issue edit 99999 --add-label review",
    "watch -n1 gh issue edit 138 --add-label review && gh issue edit 99999 --add-label review",
    "gh issue edit 5 --add-label bug && gh issue edit 99999 --add-label review",
  ]) {
    const p = run(c);
    const first = c.match(/edit (\d+)/)[1];
    assert.ok(has(p, first, fx.P) && has(p, 99999, fx.P), `${c}: ${JSON.stringify(p.gates)}`);
  }
});

test("#27 a complex script is checked in every repo its text could reach", () => {
  const p = run("cat <<'X'\ncd @H\nX\ngh issue edit 138 --add-label review");
  assert.ok(has(p, 138, fx.P) && has(p, 138, fx.H), JSON.stringify(p.gates));
  const r = run("f(){ :; }; gh -R git@github.com:joshgaskin/hatchery.git issue edit 138 --add-label review");
  assert.ok(has(r, 138, fx.P) && has(r, 138, fx.H), JSON.stringify(r.gates));
  const u = run("cd ../hatchery || true; GH_REPO=joshgaskin/plus2 gh issue edit https://github.com/joshgaskin/hatchery/issues/17 --add-label review");
  assert.strictEqual(u.mode, "complex");
  for (const d of [fx.P, fx.H]) assert.ok(has(u, 17, d), `17 in ${d}: ${JSON.stringify(u.gates)}`);
  const x = run("false || gh -R o/nowhere issue edit 138 --add-label review");
  assert.ok(has(x, 138, fx.P));
  assert.ok(x.unchecked.some((n) => n.repo === "o/nowhere"), JSON.stringify(x.unchecked));
  const v = run("f(){ :; }; CATALINA_WITNESS_ALLOW=1 gh issue edit 138 --add-label review");
  assert.deepStrictEqual(v.bypassed, []);
  assert.ok(has(v, 138, fx.P));
  assert.ok(v.notes.some((n) => /CATALINA_WITNESS_ALLOW=1.*ignored/.test(n)), JSON.stringify(v.notes));
});

test("#27 a flip main sees but can't number blocks, unless a simple script numbers it", () => {
  for (const c of [
    "parallel gh issue edit {} --add-label review ::: 138",
    "if true; then gh issue edit --add-label review; fi",
    "echo 138 | xargs -I{} gh issue edit {} --add-label review",
  ]) assert.ok(run(c).block.length, c);
  const p = run("gh issue edit --add-label review 138");
  assert.deepStrictEqual([p.mode, p.block, p.gates], ["simple", [], [{ n: "138", dir: fx.P }]]);
});

test("#27 a simple script keeps its target: cd, -R, URL, GH_REPO, subshells and child shells", () => {
  for (const [cwd, c, dir] of [
    ["@P", "cd @H && gh issue edit 138 --remove-label dev/implement --add-label review", fx.H],
    ["@P", "cd '@H' && gh issue edit 138 --add-label review", fx.H],
    ["@P", 'cd "$HOME/Documents/dev/projects/hatchery" && gh issue edit 138 --add-label review', fx.H],
    ["@P", "cd ~/Documents/dev/projects/hatchery/.claude; gh issue edit 138 --add-label review", fx.H],
    ["@P", "cd @T && cd - && gh issue edit 138 --add-label review", fx.P],
    ["@P", "(cd @H; gh issue edit 138 --add-label review)", fx.H],
    ["@P", "(cd @H && git pull -q) && gh issue edit 138 --add-label review", fx.P],
    ["@P", "X=$(cd @H && pwd) && gh issue edit 138 --add-label review", fx.P],
    ["@P", 'sh -c "cd @H; gh issue edit 138 --add-label review"', fx.H],
    ["@P", "bash -c 'cd @T' ; gh issue edit 138 --add-label review", fx.P],
    ["@P", "git status && cd @H && gh issue edit 138 --add-label review", fx.H],
    ["@P", "gh -R joshgaskin/hatchery issue edit 138 --remove-label dev/implement --add-label review", fx.H],
    ["@P", "gh issue edit 138 --add-label review -R git@github.com:joshgaskin/hatchery.git", fx.H],
    ["@P", "gh issue edit 138 --add-label review -R https://github.com/joshgaskin/hatchery.git", fx.H],
    ["@P", "gh issue edit 138 --add-label review -R github.com/joshgaskin/hatchery", fx.H],
    ["@P", "gh issue edit 138 --add-label review -R=joshgaskin/hatchery", fx.H],
    ["@P", "gh -R=joshgaskin/hatchery issue edit 138 --add-label review", fx.H],
    ["@P", "gh issue edit 138 --add-label review -R joshgaskin/hatchery -R joshgaskin/plus2", fx.P],
    ["@P", "GH_REPO=joshgaskin/hatchery gh issue edit 138 --add-label review", fx.H],
    ["@P", "export GH_REPO=joshgaskin/hatchery; unset GH_REPO; gh issue edit 138 --add-label review", fx.P],
    ["@P", "(export GH_REPO=joshgaskin/hatchery); gh issue edit 138 --add-label review", fx.P],
    ["@P", "sudo -u josh gh issue edit 138 --add-label review", fx.P],
    ["@H", "cd ../plus2 && gh issue edit 138 --add-label review", fx.P],
    ["@H", "gh -R joshgaskin/plus2 issue edit 138 --add-label review", fx.P],
    ["@H", "git -C ../plus2 log -1 && gh issue edit 138 --add-label review", fx.H],
    ["@P/.claude/worktrees/issue-2228", "gh -R joshgaskin/hatchery issue edit 138 --add-label review", fx.H],
  ]) {
    const p = run(c, cwd);
    assert.strictEqual(p.mode, "simple", `${c}: ${JSON.stringify(p.reasons)}`);
    assert.deepStrictEqual(p.gates, [{ n: "138", dir }], c);
  }
});

test("#27 a simple cd to a dir outside any repo also checks the session repo", () => {
  const p = run("cd @T && gh issue edit 138 --add-label review");
  assert.strictEqual(p.mode, "simple");
  assert.ok(has(p, 138, fx.P), JSON.stringify(p.gates));
});

test("#27 a cd or -R the gate can't read makes the script complex", () => {
  for (const c of [
    "WT=@H; cd $WT && gh issue edit 138 --add-label review",
    "cd $(git rev-parse --show-toplevel) && gh issue edit 138 --add-label review",
    "cd /no/such/dir; gh issue edit 138 --add-label review",
    "cd @H && cd $X && gh issue edit 138 --add-label review",
    "gh -R $REPO issue edit 138 --add-label review",
  ]) {
    const p = run(c);
    assert.strictEqual(p.mode, "complex", c);
    assert.ok(has(p, 138, fx.P), c);
  }
  assert.ok(run("cd /no/such/dir; gh issue edit 138 --add-label review").notes.some((n) => /can't resolve `cd \/no\/such\/dir`/.test(n)));
});

test("#27 the bypass counts only as a prefix or export in a simple script", () => {
  for (const c of [
    "CATALINA_WITNESS_ALLOW=1 gh issue edit 138 --remove-label dev/implement --add-label review",
    "export CATALINA_WITNESS_ALLOW=1; cd @H && gh issue edit 138 --add-label review",
    "gh issue view 138 | CATALINA_WITNESS_ALLOW=1 gh issue edit 138 --add-label review",
  ]) {
    const p = run(c);
    assert.deepStrictEqual([p.mode, p.bypassed, p.gates], ["simple", ["138"], []], c);
  }
  for (const c of [
    "CATALINA_WITNESS_ALLOW=1 cd @H && gh issue edit 138 --add-label review",
    "(export CATALINA_WITNESS_ALLOW=1); gh issue edit 138 --add-label review",
    "bash -c 'export CATALINA_WITNESS_ALLOW=1'; gh issue edit 138 --add-label review",
    "CATALINA_WITNESS_ALLOW=1 && gh issue edit 138 --add-label review",
  ]) assert.deepStrictEqual(run(c).bypassed, [], c);
});

test("#27 -R values normalise to owner/name: ssh, https, host and = forms", () => {
  for (const v of ["git@github.com:o/n.git", "git@github.com:o/n", "ssh://git@github.com/o/n.git", "https://github.com/o/n.git", "https://github.com/o/n/", "github.com/o/n", "o/n", "=o/n"]) {
    const [f] = parseFlips(`gh issue edit 9 --add-label review -R ${v}`);
    assert.strictEqual(f.repo, "o/n", v);
  }
  assert.strictEqual(parseFlips("gh -R=o/n issue edit 9 --add-label review")[0].repo, "o/n");
});

test("#27 popd only returns from a pushd: after a plain cd it goes nowhere", () => {
  const f = parseFlips(`cd ${fx.H} && cd ${fx.T} && popd && gh issue edit 9 --add-label review`)[0];
  assert.strictEqual(resolveFlip(f, fx.P, fx.home).dir, fx.T);
  const g = parseFlips(`pushd ${fx.H} && pushd ${fx.T} && popd && gh issue edit 9 --add-label review`)[0];
  assert.strictEqual(resolveFlip(g, fx.P, fx.home).dir, fx.H);
});

test("#27 no flip, no plan", () => {
  for (const c of ["gh issue view 138", "gh issue edit 138 --add-label reviewer", "gh api repos/o/n/issues/138/labels -f 'labels[]=review'"]) {
    const p = run(c);
    assert.deepStrictEqual([p.flip, p.gates, p.block], [false, [], []], c);
  }
});
