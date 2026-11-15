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
  assert.deepStrictEqual(f.gitC, ["/w"]);
});

test("#27 AC5: several numbers are all gated; flag values aren't numbers", () => {
  assert.deepStrictEqual(one("gh issue edit 170 171 --add-label review --milestone 3").numbers, ["170", "171"]);
  assert.deepStrictEqual(one("gh issue edit --add-label review").numbers, []);
});
