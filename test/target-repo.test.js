/**
 * #27: reading a Bash command the way the shell and gh do, so the witness gate checks the repo gh edits.
 * parseFlips is pure: it returns each `gh issue edit … --add-label review` with what came before it.
 */
const test = require("node:test");
const assert = require("node:assert");
const { parseFlips } = require("../hooks/lib/target-repo");

const one = (command) => {
  const flips = parseFlips(command);
  assert.strictEqual(flips.length, 1, `${command} → ${JSON.stringify(flips)}`);
  return flips[0];
};

test("#27 AC1: a leading cd is the flip's dir, in order, quote-aware", () => {
  assert.deepStrictEqual(one("cd /a && gh issue edit 138 --remove-label dev/implement --add-label review").cds, ["/a"]);
  assert.deepStrictEqual(one("(cd ../x; gh issue edit #5 --add-label=dev/x,review)").cds, ["../x"]);
  assert.deepStrictEqual(one("cd '/my repo' && cd sub && gh issue edit 5 --add-label review").cds, ["/my repo", "sub"]);
  assert.deepStrictEqual(one('git commit -m "cd /a && x" && gh issue edit 9 --add-label review').cds, []);
  assert.deepStrictEqual(one('gh issue edit 9 --body "cd /x && y" --add-label review').cds, []);
  assert.deepStrictEqual(parseFlips('git commit -m "cd /a && gh issue edit 9 --add-label review"'), []);
});

test("#27 AC1: each flip in a command gets the dir it runs in", () => {
  const flips = parseFlips("cd /a && gh issue edit 1 --add-label review && cd /b && gh issue edit 2 --add-label review");
  assert.deepStrictEqual(flips.map((f) => [f.numbers, f.cds]), [[["1"], ["/a"]], [["2"], ["/a", "/b"]]]);
});

test("#27 AC2: -R/--repo and an issue URL name the repo", () => {
  for (const c of [
    "gh -R o/n issue edit 9 --add-label review",
    "gh --repo o/n issue edit 9 --add-label review",
    "gh issue edit 9 -R o/n --add-label review",
    "gh issue edit 9 --repo=o/n --add-label review",
    "gh issue edit 9 -R github.com/o/n --add-label review",
    "gh issue edit https://github.com/o/n/issues/9 --add-label review",
  ]) {
    const f = one(c);
    assert.strictEqual(f.repo, "o/n", c);
    assert.deepStrictEqual(f.numbers, ["9"], c);
  }
  assert.strictEqual(one("gh issue edit 9 --add-label review").repo, null);
});

test("#27 AC2: gh -R … issue edit is a flip; other edits are not", () => {
  assert.deepStrictEqual(parseFlips("gh issue edit 9 --add-label reviewed"), []);
  assert.deepStrictEqual(parseFlips("gh issue edit 9 --remove-label review"), []);
  assert.deepStrictEqual(parseFlips("gh issue view 9"), []);
  assert.deepStrictEqual(one("gh issue edit 9 --add-label bug --add-label review").numbers, ["9"]);
});

test("#27 AC3: the bypass counts as a prefix, through env, or from an earlier export, and nowhere else", () => {
  for (const c of [
    "CATALINA_WITNESS_ALLOW=1 gh issue edit 9 --add-label review",
    "X=1 CATALINA_WITNESS_ALLOW=1 gh issue edit 9 --add-label review",
    "env CATALINA_WITNESS_ALLOW=1 gh issue edit 9 --add-label review",
    "export CATALINA_WITNESS_ALLOW=1 && gh issue edit 9 --add-label review",
    "cd /a && CATALINA_WITNESS_ALLOW=1 gh issue edit 9 --add-label review",
  ]) assert.strictEqual(one(c).allow, true, c);
  for (const c of [
    "CATALINA_WITNESS_ALLOW=0 gh issue edit 9 --add-label review",
    "CATALINA_WITNESS_ALLOW=1 true && gh issue edit 9 --add-label review",
    'git commit -m "CATALINA_WITNESS_ALLOW=1" && gh issue edit 9 --add-label review',
    'gh issue edit 9 --body "CATALINA_WITNESS_ALLOW=1" --add-label review',
  ]) assert.strictEqual(one(c).allow, false, c);
});

test("#27 AC4: git -C is remembered, not taken as gh's dir", () => {
  const f = one("git -C /w log -1 && gh issue edit 9 --add-label review");
  assert.deepStrictEqual(f.cds, []);
  assert.deepStrictEqual(f.gitC, [{ cds: [], dir: "/w" }]);
  assert.deepStrictEqual(one("cd /a && git -C . status && gh issue edit 9 --add-label review").gitC, [{ cds: ["/a"], dir: "." }], "with the dir it runs in");
});

test("#27 AC5: several numbers are all gated; flag values aren't numbers", () => {
  assert.deepStrictEqual(one("gh issue edit 170 171 --add-label review --milestone 3").numbers, ["170", "171"]);
  assert.deepStrictEqual(one("gh issue edit --add-label review").numbers, []);
});

test("#27 AC5: a bash -c script is read as a child shell of where it runs", () => {
  const f = one(`cd /a && CATALINA_WITNESS_ALLOW=1 bash -lc "cd b && gh issue edit 9 --add-label review"`);
  assert.deepStrictEqual([f.cds, f.allow, f.numbers], [["/a", "b"], true, ["9"]]);
  assert.strictEqual(one(`sh -c 'gh issue edit 9 --add-label review'`).allow, false);
});

test("#27 witness fix 2: a cd inside ( … ) or $( … ) doesn't leak to later commands", () => {
  assert.deepStrictEqual(one("(cd ../h && git pull -q) && gh issue edit 9 --add-label review").cds, []);
  assert.deepStrictEqual(one("X=$(cd ../h && pwd) && gh issue edit 9 --add-label review").cds, []);
  assert.deepStrictEqual(one("echo `cd ../h` && gh issue edit 9 --add-label review").cds, []);
  assert.deepStrictEqual(one("(cd ../x; gh issue edit 5 --add-label review)").cds, ["../x"], "inside, it counts");
  assert.deepStrictEqual(one("(cd ../x; (cd y); gh issue edit 5 --add-label review)").cds, ["../x"]);
  assert.deepStrictEqual(one("{ cd /a && true; } && gh issue edit 5 --add-label review").cds, ["/a"], "a { } group is not a subshell");
  assert.strictEqual(one("(export CATALINA_WITNESS_ALLOW=1) && gh issue edit 5 --add-label review").allow, false);
  assert.strictEqual(one("echo $(gh issue edit 5 --add-label review)").numbers[0], "5", "a flip inside $( ) is still read");
});

test("#27 witness fix 1: a cd the parser can't resolve is kept as written, for resolveFlip to refuse", () => {
  assert.deepStrictEqual(one('WT=/x; cd "$WT" && gh issue edit 9 --add-label review').cds, ["$WT"]);
  assert.match(one("cd $(git rev-parse --show-toplevel) && gh issue edit 9 --add-label review").cds[0], /\u0000/);
});

test("#27 witness fix 3: gh behind a path or a wrapper is still a flip", () => {
  for (const c of [
    "/opt/homebrew/bin/gh issue edit 9 --add-label review",
    "timeout 60 gh issue edit 9 --add-label review",
    "command gh issue edit 9 --add-label review",
    "env -u FOO gh issue edit 9 --add-label review",
    "nohup gh issue edit 9 --add-label review",
    "sudo -E gh issue edit 9 --add-label review",
    "timeout 60 bash -c 'gh issue edit 9 --add-label review'",
    'eval "gh issue edit 9 --add-label review"',
  ]) assert.deepStrictEqual(one(c).numbers, ["9"], c);
  assert.deepStrictEqual(one("echo 9 | xargs -I{} gh issue edit {} --add-label review").numbers, [], "no number: the gate blocks");
  assert.deepStrictEqual(one("env -C /a gh issue edit 9 --add-label review").cds, ["/a"]);
  assert.strictEqual(one("timeout 60 env CATALINA_WITNESS_ALLOW=1 gh issue edit 9 --add-label review").allow, true);
});

test("#27 witness fix 5: GH_REPO names the repo, below -R and a URL", () => {
  assert.strictEqual(one("GH_REPO=o/n gh issue edit 9 --add-label review").repo, "o/n");
  assert.strictEqual(one("env GH_REPO=github.com/o/n gh issue edit 9 --add-label review").repo, "o/n");
  assert.strictEqual(one("export GH_REPO=o/n; gh issue edit 9 --add-label review").repo, "o/n");
  assert.strictEqual(one("export GH_REPO=o/n; unset GH_REPO; gh issue edit 9 --add-label review").repo, null);
  assert.strictEqual(one("GH_REPO=o/n gh -R p/q issue edit 9 --add-label review").repo, "p/q");
  assert.strictEqual(one("GH_REPO=o/n gh issue edit https://github.com/p/q/issues/9 --add-label review").repo, "p/q");
  assert.strictEqual(one("GH_REPO=o/n true && gh issue edit 9 --add-label review").repo, null, "a prefix on another command");
});

test("#27 witness fixes 1 and 4: resolveFlip keeps the last dir it could resolve, and reads git -C from where it runs", () => {
  const fs = require("fs");
  const { makeRepo } = require("./helpers/repo");
  const { resolveFlip } = require("../hooks/lib/target-repo");
  const s = makeRepo();
  const t = makeRepo();
  const here = fs.realpathSync(s.cwd);
  for (const c of [
    `WT=${t.cwd}; cd $WT && gh issue edit 9 --add-label review`,
    `WT=${t.cwd}; cd "$WT" && gh issue edit 9 --add-label review`,
    "cd $(git rev-parse --show-toplevel) && gh issue edit 9 --add-label review",
    "cd /no/such/dir; gh issue edit 9 --add-label review",
    `cd ${t.cwd}/nope && gh issue edit 9 --add-label review`,
  ]) {
    const r = resolveFlip(one(c), s.cwd);
    assert.strictEqual(r.dir, here, c);
    assert.ok(r.notes.some((n) => /can't resolve `cd/.test(n)), `${c}: ${JSON.stringify(r.notes)}`);
  }
  const ok = resolveFlip(one(`cd ${t.cwd} && cd /no/such && gh issue edit 9 --add-label review`), s.cwd);
  assert.strictEqual(ok.dir, fs.realpathSync(t.cwd), "the last dir it could resolve");
  const quiet = resolveFlip(one(`cd ${t.cwd} && git -C . status && gh issue edit 9 --add-label review`), s.cwd);
  assert.deepStrictEqual([quiet.dir, quiet.notes], [fs.realpathSync(t.cwd), []], "git -C . after the cd names the gated repo");
  const loud = resolveFlip(one(`cd ${t.cwd} && git -C ${s.cwd} status && gh issue edit 9 --add-label review`), s.cwd);
  assert.ok(loud.notes.some((n) => /git -C/.test(n)), JSON.stringify(loud.notes));
  const dyn = resolveFlip(one("gh -R $REPO issue edit 9 --add-label review"), s.cwd);
  assert.strictEqual(dyn.dir, here, "a -R the parser can't read gates the cwd repo");
  assert.ok(dyn.notes.length, "and says so");
});
