/**
 * #27 third witness: the gate doesn't model cd. A flip is checked in one repo only when its own gh argv names that repo
 * (an issue URL, else -R/--repo) and parses cleanly; anything else is checked in the session repo and every repo the
 * command's text mentions, and blocks if any of them fails.
 *
 * Table tests over every hostile case the witnesses wrote (test/fixtures/gate-cases/*.tpl; @P is plus2, @H hatchery,
 * @T a dir outside any repo, @C catalina, @S a scratch dir, @F the plus2#138 flip). The invariant, for every case: the
 * issues main checks (legacyFlip, in the session repo) are checked by plan(), unless the flip names its repo explicitly
 * and cleanly (then the oracle test runs it for real and checks gh edits that repo) or the text bypass applies to a
 * simple script.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { plan, legacyFlip, parseFlips, slugOf } = require("../hooks/lib/target-repo");

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (args, cwd) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * home/Documents/dev/projects/{plus2,hatchery,catalina} with joshgaskin remotes, plus2's issue-2228 worktree, a dir
 * outside any repo (T), and the third witness's scratch dir (S).
 */
function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "catalina-plan-")));
  const projects = path.join(home, "Documents", "dev", "projects");
  const dirs = {};
  for (const [key, name, url] of [
    ["P", "plus2", "git@github.com:joshgaskin/plus2.git"],
    ["H", "hatchery", "https://github.com/joshgaskin/hatchery.git"],
    ["C", "catalina", "https://github.com/joshgaskin/catalina"],
  ]) {
    const d = path.join(projects, name);
    fs.mkdirSync(path.join(d, ".claude", "tracking"), { recursive: true });
    git(["init", "-q", "-b", "main"], d);
    git(["remote", "add", "origin", url], d);
    git(["commit", "-q", "--allow-empty", "-m", "init"], d);
    dirs[key] = d;
  }
  fs.mkdirSync(path.join(dirs.P, "src"));
  git(["worktree", "add", "-q", ".claude/worktrees/issue-2228", "-b", "issue-2228"], dirs.P);
  dirs.T = path.join(home, "tmp");
  fs.mkdirSync(dirs.T);
  const S = (dirs.S = path.join(home, "scratch"));
  for (const d of ["repo", "clone", "lock", "gone"]) {
    fs.mkdirSync(path.join(S, d), { recursive: true });
    git(["init", "-q", "-b", "main"], path.join(S, d));
  }
  git(["remote", "add", "origin", "git@github.com:joshgaskin/plus2.git"], path.join(S, "clone"));
  fs.symlinkSync(path.join(dirs.P, "src"), path.join(S, "repo", "l"));
  fs.mkdirSync(path.join(S, "crash", ".claude"), { recursive: true });
  fs.symlinkSync(dirs.C, path.join(S, "clink"));
  return { home, ...dirs };
}

const fx = fixture();
const FLIP = "gh issue edit 138 --add-label review";
const at = (s) =>
  String(s)
    .replace(/@F/g, FLIP)
    .replace(/@([PHTCS])/g, (_, k) => fx[k]);
const unescape = (s) => s.replace(/\\n/g, "\n").replace(/\\u([0-9a-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const run = (cmd, cwd = fx.P, env = {}) => plan(at(cmd), { cwd: at(cwd), env, home: fx.home });
const top = (d) => {
  try {
    return git(["rev-parse", "--show-toplevel"], d);
  } catch {
    return d;
  }
};
const has = (p, n, dir) => p.gates.some((g) => g.n === String(n) && g.dir === dir);
const dirsOf = (p, n) => p.gates.filter((g) => g.n === String(n)).map((g) => g.dir).sort();

const CASES = [];
for (const file of fs.readdirSync(path.join(__dirname, "fixtures", "gate-cases")).sort()) {
  for (const line of fs.readFileSync(path.join(__dirname, "fixtures", "gate-cases", file), "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [cwd, ...rest] = line.split("\t");
    CASES.push({ file, cwd: at(cwd), command: unescape(at(rest.join("\t"))) });
  }
}
const planOf = (c) => plan(c.command, { cwd: c.cwd, env: {}, home: fx.home });

test("#27 the case tables hold every hostile case: adv1, adv2, adv3, new and r2", () => {
  const files = new Set(CASES.map((c) => c.file));
  for (const f of ["adv1.tpl", "adv2.tpl", "adv3.tpl", "new.tpl", "r2.tpl"]) assert.ok(files.has(f), f);
  assert.ok(CASES.length >= 143 + 47 + 5, `${CASES.length} cases`);
});

test("#27 invariant: every issue main checks is checked, unless the flip names its repo explicitly or a simple script bypasses it", () => {
  const bad = [];
  for (const c of CASES) {
    const main = legacyFlip(c.command);
    if (!main) continue;
    const p = planOf(c);
    const session = top(c.cwd);
    let ok;
    if (p.block.length) ok = true;
    else if (main.n === null) ok = p.flips.length > 0 && p.flips.every((f) => f.numbers.length && (has(p, f.numbers[0], session) || f.explicit || (p.simple && f.allow)));
    else {
      const n = String(Number(main.n));
      const explicitOnly = p.flips.some((f) => f.numbers.includes(n)) && p.flips.filter((f) => f.numbers.includes(n)).every((f) => f.explicit && p.mode !== "union");
      const bypassed = p.simple && p.bypassed.includes(n);
      ok = has(p, n, session) || explicitOnly || bypassed;
      if (has(p, n, session) && p.bypassed.length && !p.simple) ok = false;
    }
    if (!ok) bad.push(`${c.file} [${path.basename(c.cwd)}] ${c.command.replace(/\n/g, "⏎")}\n    → ${JSON.stringify({ mode: p.mode, gates: p.gates, block: p.block, bypassed: p.bypassed })}`);
  }
  assert.deepStrictEqual(bad, []);
});

/** Run a command for real with gh stubbed: [{pwd, ghRepo, args}] for each gh call. */
function realRun(shell, command, cwd) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "catalina-oracle-"));
  const bin = path.join(box, "bin");
  fs.mkdirSync(bin);
  const log = path.join(box, "gh.log");
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh\n{ printf 'PWD=%s\\n' "$PWD"; printf 'GHR=%s\\n' "\${GH_REPO-}"; for a in "$@"; do printf 'ARG=%s\\n' "$a"; done; printf 'END\\n'; } >> "${log}"\n`,
    { mode: 0o755 }
  );
  for (const noop of ["git", "sudo", "watch", "parallel", "curl", "ssh"]) fs.writeFileSync(path.join(bin, noop), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: fx.home, GH_TOKEN: "x", GH_CONFIG_DIR: box, TERM: "dumb" };
  const args = shell === "zsh" ? ["-c", 'eval "$1"', "_", command] : ["-c", command];
  spawnSync(shell === "zsh" ? "/bin/zsh" : "/bin/bash", args, { cwd, env, encoding: "utf8", timeout: 20000, input: "" });
  const out = [];
  let cur = null;
  for (const l of (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").split("\n")) {
    if (l.startsWith("PWD=")) cur = { pwd: l.slice(4), ghRepo: "", args: [] };
    else if (l.startsWith("GHR=")) cur.ghRepo = l.slice(4);
    else if (l.startsWith("ARG=")) cur.args.push(l.slice(4));
    else if (l === "END") out.push(cur);
  }
  fs.rmSync(box, { recursive: true, force: true });
  return out;
}

/** The repo gh edits, as gh ranks it: an issue URL, then the last -R/--repo, then GH_REPO, then the cwd's origin. */
function ghTarget({ pwd, ghRepo, args }) {
  const url = args.map((a) => a.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/\d+/)).find(Boolean);
  if (url) return url[1].toLowerCase();
  let r = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-R" || a === "--repo") r = args[++i];
    else if (a.startsWith("--repo=")) r = a.slice(7);
    else if (a.startsWith("-R")) r = a.slice(2).replace(/^=/, "");
  }
  if (r) return slugOf(r).toLowerCase();
  if (ghRepo) return slugOf(ghRepo).toLowerCase();
  try {
    return slugOf(git(["remote", "get-url", "origin"], top(pwd))).toLowerCase();
  } catch {
    return null;
  }
}

/** Commands the oracle never runs for real: they could change files, processes or the network outside its box. */
const DANGER = /\b(rm|rmdir|chmod|chown|kill|pkill|killall|open|osascript|curl|wget|ssh|scp|rsync|dd|mv|cp|ln|shutdown|reboot|launchctl|defaults|security|sudo|doas|truncate|tee)\b|>/;

test("#27 oracle: a flip the gate reads as naming its repo edits that repo when run for real (bash, and zsh eval)", () => {
  const shells = ["bash", ...(fs.existsSync("/bin/zsh") ? ["zsh"] : [])];
  const extra = [
    "gh issue edit https://github.com/joshgaskin/plus2/issues/138 -R joshgaskin/catalina --add-label review",
    "gh -R joshgaskin/catalina issue edit https://github.com/joshgaskin/plus2/issues/138 --add-label review",
    "gh issue edit 138 --add-label review -R joshgaskin/hatchery -R joshgaskin/plus2",
    "gh issue edit 138 --add-label review --repo=joshgaskin/hatchery",
    "gh -Rjoshgaskin/hatchery issue edit 138 --add-label review",
    "cd @H && gh -R joshgaskin/plus2 issue edit 138 --add-label review",
    "gh issue edit 138 --add-label review -R git@github.com:joshgaskin/hatchery.git",
  ].map((c) => ({ file: "extra", cwd: fx.P, command: at(c) }));
  let checked = 0;
  const bad = [];
  for (const c of [...CASES, ...extra]) {
    const p = planOf(c);
    const explicit = p.flips.filter((f) => f.explicit);
    if (!explicit.length || p.mode === "union") continue;
    if (/(^|[\s;&|])\/\S*\/gh\s/.test(c.command)) continue; // a gh by path would be the real gh
    if (DANGER.test(c.command)) continue; // never run a case that could touch more than the sandbox
    for (const shell of shells) {
      const calls = realRun(shell, c.command, c.cwd).filter((k) => k.args.includes("edit"));
      for (const f of explicit) {
        const call = calls.find((k) => f.numbers.every((n) => k.args.some((a) => a === n || a.endsWith(`/issues/${n}`) || Number(a) === Number(n))));
        if (!call) continue; // the flip never ran, so nothing was edited
        checked++;
        const real = ghTarget(call);
        if (real !== f.explicit.toLowerCase()) bad.push(`${shell} ${c.command.replace(/\n/g, "⏎")}: the gate read ${f.explicit}, gh edits ${real}`);
      }
    }
  }
  assert.deepStrictEqual(bad, []);
  assert.ok(checked >= 10, `only ${checked} explicit flips ran`);
});

test("#27 third witness D1: an issue URL beats -R, as gh ranks them", () => {
  for (const c of [
    "gh issue edit https://github.com/joshgaskin/hatchery/issues/138 -R joshgaskin/plus2 --add-label review",
    "gh issue edit https://github.com/joshgaskin/hatchery/issues/138 --add-label review --repo=joshgaskin/plus2",
    "gh -R joshgaskin/plus2 issue edit https://github.com/joshgaskin/hatchery/issues/138 --add-label review",
  ]) {
    const p = run(c);
    assert.strictEqual(p.mode, "explicit", c);
    assert.deepStrictEqual(dirsOf(p, 138), [fx.H], c);
  }
  const r = run("gh issue edit https://github.com/joshgaskin/plus2/issues/138 -R nobody/none --add-label review");
  assert.deepStrictEqual([dirsOf(r, 138), r.unchecked], [[fx.P], []]);
  assert.strictEqual(parseFlips("gh issue edit https://github.com/p/q/issues/9 -R o/n --add-label review")[0].repo, "p/q");
});

test("#27 third witness D2: no cd moves the gate; the session repo is always checked", () => {
  for (const c of CASES.filter((k) => k.file === "new.tpl" && k.cwd === fx.P && /\bcd\b|pushd|env -C/.test(k.command))) {
    const p = planOf(c);
    if (p.block.length || !legacyFlip(c.command)) continue;
    const explicit = p.flips.some((f) => f.explicit) && p.mode !== "union";
    if (!explicit) assert.ok(p.gates.some((g) => g.dir === fx.P), `${c.command}: ${JSON.stringify(p.gates)}`);
  }
  for (const c of [
    "cd -Q @C; @F",
    "cd @C > /nonexistent/x; @F",
    'cd "~/Documents/dev/projects/catalina"; @F',
    "cd '$HOME/Documents/dev/projects/catalina'; @F",
    "cd ../catalina\r; @F",
    "cd\u000b../catalina; @F",
    "cd ../catalina; @F",
    "cd -P @S/repo/l/.. && @F",
    "set -P; cd @S/repo/l/.. && @F",
    "disable cd; cd @C; @F",
    "enable -n cd; cd @C && @F",
    "cd @C; @F",
    "cd @H && gh issue edit 138 --add-label review",
    "(cd @H && gh issue edit 138 --add-label review)",
  ]) {
    const p = run(c);
    assert.strictEqual(p.mode, "union", c);
    assert.ok(has(p, 138, fx.P), `${c}: ${JSON.stringify(p.gates)}`);
  }
  const both = run("cd @C; @F");
  assert.ok(has(both, 138, fx.C), "the cd's repo is checked too");
  assert.ok(both.notes.some((n) => /every repo this command could reach/.test(n)), JSON.stringify(both.notes));
});

test("#27 third witness D3: GH_REPO in any form means the union, with its repo in it", () => {
  for (const c of [
    "GH_REPO=joshgaskin/hatchery; export GH_REPO; @F",
    "declare -x GH_REPO=joshgaskin/hatchery; @F",
    "set -a; GH_REPO=joshgaskin/hatchery; @F",
    "typeset -x GH_REPO=joshgaskin/hatchery; @F",
    "export GH_REPO=joshgaskin/hatchery; @F",
    "GH_REPO=joshgaskin/hatchery gh issue edit 138 --add-label review",
    "GH_REPO=joshgaskin/hatchery gh -R joshgaskin/plus2 issue edit 138 --add-label review",
  ]) {
    const p = run(c);
    assert.strictEqual(p.mode, "union", c);
    assert.deepStrictEqual(dirsOf(p, 138), [fx.H, fx.P].sort(), c);
  }
  const env = run("@F", "@P", { GH_REPO: "joshgaskin/hatchery" });
  assert.deepStrictEqual(dirsOf(env, 138), [fx.H, fx.P].sort(), "the session's GH_REPO too");
});

test("#27 third witness D5: a cd into another checkout of the same repo checks both", () => {
  const wt = path.join(fx.P, ".claude", "worktrees", "issue-2228");
  const p = run("cd .claude/worktrees/issue-2228 && gh issue edit 19 --add-label review");
  assert.deepStrictEqual(dirsOf(p, 19), [fx.P, wt].sort());
  const q = run("cd @S/clone && @F");
  assert.deepStrictEqual(dirsOf(q, 138), [fx.P, path.join(fx.S, "clone")].sort());
  const r = run("gh -R joshgaskin/plus2 issue edit 138 --add-label review", wt);
  assert.deepStrictEqual(dirsOf(r, 138), [fx.P, wt].sort(), "a named repo is checked in its worktree and its main checkout");
});

test("#27 a flip that names its repo cleanly is checked only there; anything unclean falls back to the union", () => {
  for (const [cwd, c, dirs] of [
    ["@P", "gh -R joshgaskin/hatchery issue edit 138 --remove-label dev/implement --add-label review", [fx.H]],
    ["@P", "gh issue edit 138 --add-label review -R git@github.com:joshgaskin/hatchery.git", [fx.H]],
    ["@P", "gh issue edit 138 --add-label review -R https://github.com/joshgaskin/hatchery.git", [fx.H]],
    ["@P", "gh issue edit 138 --add-label review -R github.com/joshgaskin/hatchery", [fx.H]],
    ["@P", "gh issue edit 138 --add-label review -R=joshgaskin/hatchery", [fx.H]],
    ["@P", "gh -R=joshgaskin/hatchery issue edit 138 --add-label review", [fx.H]],
    ["@P", "gh issue edit 138 --add-label review -R joshgaskin/hatchery -R joshgaskin/plus2", [fx.P]],
    ["@P", "gh issue edit 138 --add-label review --repo 'joshgaskin/hatchery'", [fx.H]],
    ["@P", "cd @C && gh -R joshgaskin/hatchery issue edit 138 --add-label review", [fx.H]],
    ["@P", "false || gh -R joshgaskin/hatchery issue edit 138 --add-label review", [fx.H]],
    ["@H", "gh -R joshgaskin/plus2 issue edit 138 --add-label review", [fx.P]],
    ["@P", "gh issue edit https://github.com/joshgaskin/hatchery/issues/138 --add-label review", [fx.H]],
  ]) {
    const p = run(c, cwd);
    assert.strictEqual(p.mode, "explicit", c);
    assert.deepStrictEqual(dirsOf(p, 138), dirs, c);
  }
  for (const c of [
    "gh -R $REPO issue edit 138 --add-label review",
    'gh -R "$REPO" issue edit 138 --add-label review',
    "gh -R joshgaskin/hatchery issue edit 138 --add-label review # -R joshgaskin/plus2",
    "gh -R joshgaskin/hatch* issue edit 138 --add-label review",
    "gh -R joshgaskin/{hatchery,plus2} issue edit 138 --add-label review",
    "gh -R joshgaskin/hatchery issue edit 138 --add-label review \\\n -R joshgaskin/plus2",
    "gh -R joshgaskin/hatchery issue edit 138 --add-label review",
    "gh -R joshgaskin/hatchery issue edit 138 --add-label review 2>&1",
    "alias gh='gh -R joshgaskin/plus2'\ngh -R joshgaskin/hatchery issue edit 138 --add-label review",
    "gh(){ command gh \"$@\"; }; gh -R joshgaskin/hatchery issue edit 138 --add-label review",
    "function gh { :; }; gh -R joshgaskin/hatchery issue edit 138 --add-label review",
    "hash -p /tmp/x gh; gh -R joshgaskin/hatchery issue edit 138 --add-label review",
    "timeout 60 gh -R joshgaskin/hatchery issue edit 138 --add-label review",
    "bash -c 'gh -R joshgaskin/hatchery issue edit 138 --add-label review'",
    "eval 'gh -R joshgaskin/hatchery issue edit 138 --add-label review'",
    "cat <<X\nX\ngh -R joshgaskin/hatchery issue edit 138 --add-label review",
    "gh issue edit https://github.com/joshgaskin/hatchery/issues/138 https://github.com/joshgaskin/plus2/issues/17 --add-label review",
    "gh issue edit https://github.com/joshgaskin/hatchery/issues/138 17 --add-label review",
  ]) {
    const p = run(c);
    assert.strictEqual(p.mode, "union", c);
    assert.ok(has(p, 138, fx.P), `${c}: ${JSON.stringify(p.gates)}`);
  }
});

test("#27 a named repo with no local checkout is let through with a notice; in the union the session is still checked", () => {
  const p = run("gh -R o/nowhere issue edit 138 --add-label review");
  assert.deepStrictEqual([p.gates, p.unchecked.map((u) => u.repo)], [[], ["o/nowhere"]]);
  const q = run("cd @T; gh -R o/nowhere issue edit 138 --add-label review # x");
  assert.ok(has(q, 138, fx.P) && q.unchecked.some((u) => u.repo === "o/nowhere"), JSON.stringify(q));
});

test("#27 the second witness's cases stay checked in the session repo, the text bypass ignored", () => {
  for (const c of [
    "cat > /dev/null <<'X'\ncd @T\nX\ngh issue edit 138 --add-label review",
    "false && cd @T; gh issue edit 138 --add-label review",
    "cd @H || cd @T; gh issue edit 138 --add-label review",
    "f(){ cd @T; }; gh issue edit 138 --add-label review",
    "true # ; cd @T\ngh issue edit 138 --add-label review",
    "pushd @T && popd && gh issue edit 138 --add-label review",
    "eval \"cd @T\"; gh issue edit 138 --add-label review",
    "HOME=@T; cd; gh issue edit 138 --add-label review",
    "env -S 'gh issue edit 138 --add-label review' && gh issue edit 99999 --add-label review",
    "f(){ export CATALINA_WITNESS_ALLOW=1; }; gh issue edit 138 --add-label review",
    "false && export CATALINA_WITNESS_ALLOW=1; gh issue edit 138 --add-label review",
    "cat <<'X'\nexport CATALINA_WITNESS_ALLOW=1\nX\ngh issue edit 138 --add-label review",
  ]) {
    const p = run(c);
    assert.strictEqual(p.simple, false, c);
    assert.ok(has(p, 138, fx.P), `${c}: ${JSON.stringify(p.gates)}`);
    assert.deepStrictEqual(p.bypassed, [], c);
    assert.strictEqual(p.notes.filter((n) => /every repo this command could reach/.test(n)).length, 1, `${c}: ${JSON.stringify(p.notes)}`);
  }
  const v = run("f(){ :; }; CATALINA_WITNESS_ALLOW=1 gh issue edit 138 --add-label review");
  assert.deepStrictEqual(v.bypassed, []);
  assert.ok(v.notes.some((n) => /CATALINA_WITNESS_ALLOW=1.*ignored/.test(n)), JSON.stringify(v.notes));
});

test("#27 the backstop counts per flip: every number either read gets checked", () => {
  for (const c of [
    "env -S 'gh issue edit 138 --add-label review' && gh issue edit 99999 --add-label review",
    "if true; then gh issue edit 138 --add-label review; fi; gh issue edit 99999 --add-label review",
    "sudo -u gh gh issue edit 138 --add-label review; gh issue edit 99999 --add-label review",
    "watch -n1 gh issue edit 138 --add-label review && gh issue edit 99999 --add-label review",
    "if true; then gh -R joshgaskin/hatchery issue edit 138 --add-label review ; fi; gh -R joshgaskin/hatchery issue edit 99999 --add-label review",
  ]) {
    const p = run(c);
    assert.ok(has(p, 138, fx.P) && has(p, 99999, fx.P), `${c}: ${JSON.stringify(p.gates)}`);
  }
});

test("#27 the union is the session repo plus every repo the text mentions: cd, pushd, env -C, -R, GH_REPO, URLs", () => {
  const p = run("cat <<'X'\ncd @H\nX\ngh issue edit 138 --add-label review");
  assert.deepStrictEqual(dirsOf(p, 138), [fx.H, fx.P].sort());
  const r = run("f(){ :; }; gh -R git@github.com:joshgaskin/hatchery.git issue edit 138 --add-label review");
  assert.deepStrictEqual(dirsOf(r, 138), [fx.H, fx.P].sort());
  const u = run("cd ../catalina || true; gh issue edit 17 --add-label review # https://github.com/joshgaskin/hatchery/issues/1");
  assert.deepStrictEqual(dirsOf(u, 17), [fx.C, fx.H, fx.P].sort());
  const e = run("env -C @H gh issue edit 138 --add-label review");
  assert.deepStrictEqual(dirsOf(e, 138), [fx.H, fx.P].sort());
  const t = run("cd @T && gh issue edit 138 --add-label review");
  assert.deepStrictEqual(dirsOf(t, 138), [fx.P, fx.T].sort(), "a dir outside any repo is checked as is");
});

test("#27 numbers: leading zeros are the same issue, labels match in any case", () => {
  assert.deepStrictEqual(dirsOf(run("gh issue edit 0138 --add-label review"), 138), [fx.P]);
  assert.deepStrictEqual(dirsOf(run("cd @C && gh issue edit 0138 --add-label review"), 138), [fx.C, fx.P].sort());
  assert.deepStrictEqual(dirsOf(run("gh issue edit 138 --add-label Review"), 138), [fx.P]);
});

test("#27 caps: more than 20 candidate repos or 50 numbers blocks, fast", () => {
  const many = [];
  for (let i = 0; i < 25; i++) {
    const d = path.join(fx.T, `d${i}`);
    fs.mkdirSync(d, { recursive: true });
    many.push(`cd ${d}`);
  }
  const t0 = Date.now();
  const p = run(`true # ${many.join(" ")}\n@F`);
  assert.ok(p.block.some((b) => /more than 20/.test(b)), JSON.stringify(p.block));
  const slugs = Array.from({ length: 200 }, (_, i) => `-R n/x${i}`).join(" ");
  const q = run(`true # ${slugs}\n@F`);
  assert.ok(q.block.some((b) => /more than 20/.test(b)), JSON.stringify(q.block));
  const nums = Array.from({ length: 51 }, (_, i) => 1000 + i).join(" ");
  const r = run(`gh issue edit ${nums} --add-label review`);
  assert.ok(r.block.some((b) => /more than 50/.test(b)), JSON.stringify(r.block));
  // One dir repeated: dedup keeps the targets under 20, so the count of cd words and the text read cap it.
  for (const c of [`true # ${"cd a ".repeat(50000)}\n@F`, `true # ${"cd a ".repeat(400)}${"x".repeat(200000)}\n@F`]) {
    const s = run(c);
    assert.ok(s.block.some((b) => /500 cd words/.test(b)), JSON.stringify(s.block));
  }
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
});

test("#27 a flip main sees but can't number blocks", () => {
  for (const c of [
    "parallel gh issue edit {} --add-label review ::: 138",
    "if true; then gh issue edit --add-label review; fi",
    "echo 138 | xargs -I{} gh issue edit {} --add-label review",
  ]) assert.ok(run(c).block.length, c);
  const p = run("gh issue edit --add-label review 138");
  assert.deepStrictEqual([p.block, p.gates], [[], [{ n: "138", dir: fx.P }]]);
});

test("#27 the bypass counts only as a prefix or export in a simple script", () => {
  for (const c of [
    "CATALINA_WITNESS_ALLOW=1 gh issue edit 138 --remove-label dev/implement --add-label review",
    "export CATALINA_WITNESS_ALLOW=1; cd @H && gh issue edit 138 --add-label review",
    "gh issue view 138 | CATALINA_WITNESS_ALLOW=1 gh issue edit 138 --add-label review",
    "CATALINA_WITNESS_ALLOW=1 gh -R joshgaskin/hatchery issue edit 138 --add-label review",
  ]) {
    const p = run(c);
    assert.deepStrictEqual([p.simple, p.bypassed, p.gates], [true, ["138"], []], c);
  }
  for (const c of [
    "CATALINA_WITNESS_ALLOW=1 cd @H && gh issue edit 138 --add-label review",
    "(export CATALINA_WITNESS_ALLOW=1); gh issue edit 138 --add-label review",
    "bash -c 'export CATALINA_WITNESS_ALLOW=1'; gh issue edit 138 --add-label review",
    "CATALINA_WITNESS_ALLOW=1 && gh issue edit 138 --add-label review",
    "export CATALINA_WITNESS_ALLOW=1 > /nonexistent/x; gh issue edit 138 --add-label review",
  ]) assert.deepStrictEqual(run(c).bypassed, [], c);
});

test("#27 -R values normalise to owner/name: ssh, https, host and = forms", () => {
  for (const v of ["git@github.com:o/n.git", "git@github.com:o/n", "ssh://git@github.com/o/n.git", "https://github.com/o/n.git", "https://github.com/o/n/", "github.com/o/n", "o/n", "=o/n"]) {
    const [f] = parseFlips(`gh issue edit 9 --add-label review -R ${v}`);
    assert.strictEqual(f.repo, "o/n", v);
  }
  assert.strictEqual(parseFlips("gh -R=o/n issue edit 9 --add-label review")[0].repo, "o/n");
});

test("#27 no flip, no plan", () => {
  for (const c of ["gh issue view 138", "gh issue edit 138 --add-label reviewer", "gh api repos/o/n/issues/138/labels -f 'labels[]=review'"]) {
    const p = run(c);
    assert.deepStrictEqual([p.flip, p.gates, p.block], [false, [], []], c);
  }
});
