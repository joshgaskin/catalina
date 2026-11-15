/**
 * A `node --test` reporter that writes vitest's JSON report shape, so a fixture can use `red_parser: "vitest"` without
 * vitest installed. Per file: `{name, status, message, assertionResults: [{ancestorTitles, title, fullName, status,
 * failureMessages}]}`. A file that fails as a whole (it threw at load, or the process exited) has no assertion results
 * and its stderr as the message, as vitest reports a file that fails to load.
 *
 * red_cmd: node --test --test-reporter=<this file> --test-reporter-destination={report} {files}
 *
 * `report(source, { jest: true })` gives jest's shape instead (test/helpers/jest-json.mjs): a file with a failed test
 * also carries every failure as its `message`, as jest's `failureMessage` does.
 */
import path from "node:path";

export default async function* vitestJson(source) {
  yield* report(source);
}

export async function* report(source, { jest = false } = {}) {
  const files = new Map();
  const file = (f) => {
    if (!files.has(f)) files.set(f, { stack: [], tests: [], whole: null, stderr: "" });
    return files.get(f);
  };
  for await (const e of source) {
    const d = e.data || {};
    if (!d.file) continue;
    const f = file(path.resolve(d.file));
    if (e.type === "test:stderr") f.stderr += d.message || "";
    if (e.type === "test:start") f.stack[d.nesting] = d.name;
    if (e.type !== "test:pass" && e.type !== "test:fail") continue;
    const err = d.details?.error;
    const isFile = d.nesting === 0 && path.resolve(d.name) === path.resolve(d.file);
    if (isFile) {
      if (e.type === "test:fail") f.whole = String(err?.cause?.message || err?.message || "failed");
      continue;
    }
    if (d.details?.type === "suite") continue;
    const ancestorTitles = f.stack.slice(0, d.nesting);
    f.tests.push({
      ancestorTitles,
      title: d.name,
      fullName: [...ancestorTitles, d.name].join(" "),
      status: e.type === "test:pass" ? "passed" : "failed",
      failureMessages: e.type === "test:fail" ? [String(err?.cause?.message || err?.message || "failed")] : [],
    });
  }
  const testResults = [...files].map(([name, f]) => {
    const failed = f.whole !== null || f.tests.some((t) => t.status === "failed");
    const whole = f.whole !== null && !f.tests.length ? `${f.whole}\n${f.stderr}`.trim() : "";
    const each = jest ? f.tests.flatMap((t) => t.failureMessages).join("\n") : "";
    return {
      name,
      status: failed ? "failed" : "passed",
      message: whole || each,
      assertionResults: f.whole !== null && !f.tests.length ? [] : f.tests,
    };
  });
  yield JSON.stringify({ numFailedTests: testResults.flatMap((r) => r.assertionResults).filter((t) => t.status === "failed").length, testResults });
}
