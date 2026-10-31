/**
 * Hook: TypeScript check, once per turn.
 *
 * PostToolUse (Edit|Write): records each edited .ts/.tsx file — no compile, so edits stay fast.
 * Stop: runs `tsc --noEmit` once per tsconfig the recorded files belong to, reports only
 * errors in those files, and clears the list. Errors block the stop once so Claude fixes
 * them; if they are still there on the follow-up stop, they are printed and allowed.
 *
 * CATALINA_TSC overrides the compiler command (tests).
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  if (data.length < 1024 * 1024) data += c;
});

const stateFile = (session) => path.join(os.tmpdir(), `catalina-typecheck-${String(session || "default").replace(/[^\w-]/g, "")}.json`);
const readList = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return [];
  }
};

function tsconfigDir(file) {
  let dir = path.dirname(file);
  for (let i = 0; i < 20 && dir !== path.parse(dir).root; i++, dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "tsconfig.json"))) return dir;
  }
  return null;
}

function compile(dir) {
  const [cmd, args] = process.env.CATALINA_TSC ? [process.env.CATALINA_TSC, []] : ["npx", ["tsc", "--noEmit", "--pretty", "false"]];
  try {
    execFileSync(cmd, args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    return "";
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}`;
  }
}

process.stdin.on("end", () => {
  let input = {};
  try {
    input = JSON.parse(data);
  } catch {
    process.exit(0);
  }
  const file = stateFile(input.session_id);

  if (input.hook_event_name !== "Stop") {
    const p = input.tool_input?.file_path;
    if (p && /\.(ts|tsx)$/.test(p) && fs.existsSync(p)) {
      const list = readList(file);
      const abs = path.resolve(p);
      if (!list.includes(abs)) fs.writeFileSync(file, JSON.stringify([...list, abs]));
    }
    process.exit(0);
  }

  const list = readList(file);
  fs.rmSync(file, { force: true });
  if (!list.length) process.exit(0);
  const byDir = new Map();
  for (const f of list) {
    const d = tsconfigDir(f);
    if (d) byDir.set(d, [...(byDir.get(d) || []), f]);
  }
  const errors = [];
  for (const [dir, files] of byDir) {
    const names = new Set(files.flatMap((f) => [f, path.relative(dir, f)]));
    for (const line of compile(dir).split("\n")) {
      const m = line.match(/^(.+?)\(\d+,\d+\): error/);
      if (m && names.has(m[1])) errors.push(line);
    }
  }
  if (!errors.length) process.exit(0);
  const reason = `TypeScript errors in files edited this turn:\n${errors.slice(0, 20).join("\n")}`;
  if (input.stop_hook_active) process.stderr.write(`[typecheck] ${reason}\n`);
  else process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
});
