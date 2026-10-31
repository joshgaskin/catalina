// AC11, AC13–AC16: the package's own files — templates, removals, install, doctor, overlays, typecheck.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ROOT, sh } = require("./helpers/repo");
const t = require("../lib/tracking");
const { resolve } = require("../lib/overlay");

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
// A fenced block inside a list item is indented; return its body with that indent removed.
function fenced(text, lang, first = "") {
  const m = text.match(new RegExp("^( *)```" + lang + "\\n((?:\\1.*\\n|\\n)*?)\\1```", "m"));
  if (!m) return null;
  const body = m[2].split("\n").map((l) => l.slice(m[1].length)).join("\n").replace(/\n$/, "");
  return body.startsWith(first) ? body : null;
}

// AC11 — the /spec template and the /witness examples parse the way catalina check reads them
test("AC11: a tracking.md from the /spec template has every section check reads", () => {
  const spec = read("commands/spec.md");
  const tpl = fenced(spec, "markdown", "# Issue #{N}");
  assert.ok(tpl, "the /spec template block");
  assert.ok(/^- \[[ x]\]/m.test(t.section(tpl, "Definition of Done")), "DoD items");
  assert.ok(/^- \[ \] AC1:/m.test(t.section(tpl, "Acceptance Criteria")), "AC ids");
  const pm = t.premortem(tpl);
  assert.ok(pm.present && pm.ids.includes("P1"), `premortem IDs: ${JSON.stringify(pm)}`);
  assert.ok(t.filled(t.section(tpl, "Lessons applied")), "Lessons applied");
  assert.ok(t.section(tpl, "Review History") !== null, "Review History");
  assert.ok(!/Pipeline State/.test(tpl), "no Pipeline State block");
  // The trivial form the template offers is the one check accepts.
  assert.match(spec, /Trivial: <reason>|Trivial: \{reason\}/);
  assert.ok(t.premortem("## Premortem\nTrivial: one-line fix\n").trivial);
});

test("AC11: the /witness verification examples use premortem IDs and a sha on every AC line", () => {
  const witness = read("commands/witness.md");
  const block = fenced(witness, "jsonl");
  assert.ok(block, "the /witness jsonl example");
  const lines = block.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.filter((l) => l.ac).every((l) => l.sha), "every AC line names the sha");
  assert.ok(lines.some((l) => /^P\d+$/.test(l.premortem || "")), "premortem lines carry IDs");
  assert.match(witness, /catalina check \$ARGUMENTS --witness|catalina check <N> --witness/);
  assert.match(read("commands/recall.md"), /## Lessons/);
});

// AC13 — removals
test("AC13: removed hooks are gone and nothing still points at them", () => {
  for (const f of ["phase-transition.js", "suggest-compact.js", "post-edit-console-warn.js", "retry-gate.js"]) {
    assert.ok(!fs.existsSync(path.join(ROOT, "hooks", f)), f);
  }
  const files = ["README.md", "CLAUDE.md", ...["commands", "reference"].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).map((f) => `${d}/${f}`))];
  for (const f of files) {
    const text = read(f);
    for (const word of ["retry-gate", "BOUNCE", "Pipeline State", "phase-transition", "suggest-compact", "console-warn"]) {
      assert.ok(!text.includes(word), `${f} still mentions ${word}`);
    }
  }
});

// install.sh, run against a temporary HOME and project
function install(env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "catalina-home-"));
  const project = path.join(home, "project");
  fs.mkdirSync(project);
  sh("git", ["init", "-q", "-b", "main"], project);
  return {
    home,
    project,
    run: () => spawnSync("bash", [path.join(ROOT, "install.sh")], { cwd: project, encoding: "utf8", env: { ...process.env, HOME: home, CATALINA_SKIP_LABELS: "1", ...env } }),
    settings: () => JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")),
  };
}

test("AC13: install removes settings entries for deleted hooks, keeps the rest, wires typecheck on Stop and format on Edit|Write", () => {
  const i = install();
  fs.mkdirSync(path.join(i.home, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(i.home, ".claude", "settings.json"),
    JSON.stringify({
      model: "opus",
      hooks: {
        PreToolUse: [
          { matcher: "Edit|Write|Bash", hooks: [{ type: "command", command: "node ~/.claude/hooks/phase-transition.js" }] },
          { matcher: "Bash", hooks: [{ type: "command", command: "node ~/.claude/hooks/retry-gate.js" }] },
          { matcher: "Bash", hooks: [{ type: "command", command: "my-own-hook.sh" }] },
        ],
        PostToolUse: [
          { matcher: "Edit", hooks: [{ type: "command", command: "node ~/.claude/hooks/post-edit-format.js" }] },
          { matcher: "Edit", hooks: [{ type: "command", command: "node ~/.claude/hooks/post-edit-console-warn.js" }] },
        ],
      },
    })
  );
  const r = i.run();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const s = i.settings();
  const all = JSON.stringify(s.hooks);
  for (const gone of ["phase-transition", "retry-gate", "console-warn"]) assert.ok(!all.includes(gone), gone);
  assert.ok(all.includes("my-own-hook.sh"), "unrelated hook kept");
  assert.strictEqual(s.model, "opus");
  assert.ok(s.hooks.Stop.some((e) => JSON.stringify(e).includes("post-edit-typecheck.js")), "typecheck on Stop");
  const fmt = s.hooks.PostToolUse.find((e) => JSON.stringify(e).includes("post-edit-format.js"));
  assert.strictEqual(fmt.matcher, "Edit|Write");
  assert.strictEqual(s.hooks.PostToolUse.filter((e) => JSON.stringify(e).includes("post-edit-format.js")).length, 1, "no duplicate");
  // idempotent
  i.run();
  assert.deepStrictEqual(i.settings(), s);
});

test("AC13: typecheck records edited .ts files and checks only those, once, at Stop", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalina-tsc-"));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
  for (const f of ["a.ts", "other.ts", "notes.md"]) fs.writeFileSync(path.join(dir, f), "x");
  const fake = path.join(dir, "fake-tsc.sh");
  fs.writeFileSync(fake, "#!/bin/sh\necho 'a.ts(1,1): error TS1: bad a'\necho 'other.ts(1,1): error TS2: bad other'\nexit 2\n");
  fs.chmodSync(fake, 0o755);
  const hook = path.join(ROOT, "hooks", "post-edit-typecheck.js");
  const env = { ...process.env, CATALINA_TSC: fake, TMPDIR: dir };
  const call = (input) => spawnSync("node", [hook], { cwd: dir, input: JSON.stringify({ session_id: "s1", ...input }), encoding: "utf8", env });
  for (const f of ["a.ts", "notes.md"]) {
    const r = call({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(dir, f) } });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stderr, "", "no typecheck after an edit");
  }
  const stop = call({ hook_event_name: "Stop", stop_hook_active: false });
  const out = JSON.parse(stop.stdout);
  assert.strictEqual(out.decision, "block");
  assert.match(out.reason, /bad a/);
  assert.doesNotMatch(out.reason, /bad other/);
  const again = call({ hook_event_name: "Stop", stop_hook_active: false });
  assert.strictEqual(again.stdout.trim(), "", "list cleared: nothing to check");
});

// AC14 — fixes
test("AC14: one browser rule, both settings files, README matches install, worktrees ignored", () => {
  const rule = /project's browser tool \(`\/browse` by default\)/;
  assert.match(read("CLAUDE.md"), rule);
  assert.match(read("commands/witness.md"), rule);
  assert.doesNotMatch(read("commands/witness.md"), /mcp__claude-in-chrome__tabs_context_mcp/);
  assert.match(read("commands/witness.md"), /~\/\.claude\/settings\.json/);
  assert.match(read("commands/witness.md"), /\.claude\/settings\.json/);
  const readme = read("README.md");
  assert.doesNotMatch(readme, /submodule/);
  assert.match(readme, /git clone https:\/\/github\.com\/joshgaskin\/catalina ~\/\.catalina/);
  assert.match(readme, /git -C ~\/\.catalina pull/);
  assert.match(read(".gitignore"), /^\.claude\/worktrees\/$/m);
});

// AC15 — linked install + doctor
test("AC15: install links hooks and commands; an existing project copy is reported, not overwritten", () => {
  const i = install();
  fs.mkdirSync(path.join(i.project, ".claude", "commands"), { recursive: true });
  fs.writeFileSync(path.join(i.project, ".claude", "commands", "spec.md"), "my own spec\n");
  const r = i.run();
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.lstatSync(path.join(i.home, ".claude", "hooks", "witness-gate.js")).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(i.home, ".claude", "hooks", "lib", "verify-witness.js")).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(i.project, ".claude", "commands", "witness.md")).isSymbolicLink());
  assert.strictEqual(fs.readFileSync(path.join(i.project, ".claude", "commands", "spec.md"), "utf8"), "my own spec\n");
  assert.match(r.stdout, /spec\.md.*overlay/);
  assert.ok(fs.lstatSync(path.join(i.home, ".catalina")).isSymbolicLink());
  const hooksDir = sh("git", ["rev-parse", "--git-path", "hooks"], i.project).trim();
  assert.ok(fs.existsSync(path.join(i.project, hooksDir, "pre-push")), "pre-push installed");
});

test("AC15: doctor exits 1 listing drifted copies, 0 when all are links or identical", () => {
  const i = install();
  i.run();
  const doctor = (...extra) => spawnSync("node", [path.join(ROOT, "bin", "catalina"), "doctor", ...extra], { cwd: i.project, encoding: "utf8", env: { ...process.env, HOME: i.home } });
  assert.strictEqual(doctor().status, 0, doctor().stdout);
  const kit = path.join(i.home, "kit");
  fs.mkdirSync(path.join(kit, "lib"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "hooks", "witness-gate.js"), path.join(kit, "witness-gate.js")); // identical copy: fine
  fs.writeFileSync(path.join(kit, "lib", "verify-witness.js"), "// old copy\n"); // drifted
  const r = doctor("--also", kit);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /kit\/lib\/verify-witness\.js/);
  assert.doesNotMatch(r.stdout, /kit\/witness-gate\.js.*differs/);
});

// AC16 — overlays
test("AC16: a core command takes the project overlay at its marker; without one it is unchanged", () => {
  const core = read("commands/spec.md");
  assert.match(core, /<!-- overlay -->\n!`cat \.claude\/catalina\/spec\.local\.md 2>\/dev\/null \|\| true`/);
  const withOverlay = resolve(core, "Project rule: money paths need a second reviewer.");
  assert.match(withOverlay, /<!-- overlay -->\nProject rule: money paths need a second reviewer\./);
  assert.doesNotMatch(withOverlay, /!`cat/);
  const without = resolve(core, null);
  assert.strictEqual(without, core.replace(/\n!`cat \.claude\/catalina\/spec\.local\.md 2>\/dev\/null \|\| true`/, "\n"));
  for (const c of ["spec", "witness", "groom", "capture", "probe"]) assert.match(read(`commands/${c}.md`), new RegExp(`<!-- overlay -->\\n!\`cat \\.claude/catalina/${c}\\.local\\.md`), c);
});
