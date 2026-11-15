/**
 * A `node --test` reporter that writes jest's JSON report shape: vitest's (test/helpers/vitest-json.mjs), but a file
 * with a failed test carries the failures as its `message`, as jest's per-file `failureMessage` does (#28, witness D-J).
 *
 * red_cmd: node --test --test-reporter=<this file> --test-reporter-destination={report} {files}
 */
import { report } from "./vitest-json.mjs";

export default async function* jestJson(source) {
  yield* report(source, { jest: true });
}
