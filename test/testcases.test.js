/**
 * #28 (witness D1): a mutant line names test cases, `<file> > <describe…> > <title>`, and each must be new or changed
 * since the base. lib/testcases.js finds a test's call in the file's text and says whether the diff touches it.
 */
const test = require("node:test");
const assert = require("node:assert");
const { parseName, locate, bodies } = require("../lib/testcases");

const lines = (at) => ({ start: at.start, end: at.end });

const FILE = `import { describe, test, it } from "vitest";
// test("in a comment", () => {})
const s = 'test("in a string", () => {})';
describe("walk", () => {
  test("skips a link", () => {
    expect(walk("a")).toEqual([]); // a ) in a comment
    const re = /\\(/;
  });
  describe.skip("nested", () => {
    it.only('reads "quoted" titles', () => {
      expect(\`\${x} )\`).toBe(")");
    });
  });
});
test("top level", () => {
  expect(1).toBe(1);
});
test.describe("node style", () => {
  test("inner", () => {});
});
`;

test("#28 D1 parseName: file > describe… > title; a bare file or an empty title is refused", () => {
  assert.deepStrictEqual(parseName("src/a.test.ts > walk > skips a link"), { file: "src/a.test.ts", chain: ["walk", "skips a link"] });
  assert.deepStrictEqual(parseName("src/a.test.ts > top level"), { file: "src/a.test.ts", chain: ["top level"] });
  for (const bad of ["src/a.test.ts", "src/a.test.ts > ", " > x", "", null, 5, {}, ["a > b"]]) {
    assert.ok(parseName(bad).error, JSON.stringify(bad));
  }
});

test("#28 D1 locate: the test's lines by its describe chain; comments, strings and regexes don't count", () => {
  assert.deepStrictEqual(lines(locate(FILE, ["walk", "skips a link"])), { start: 5, end: 8 });
  assert.deepStrictEqual(lines(locate(FILE, ["walk", "nested", 'reads "quoted" titles'])), { start: 10, end: 12 });
  assert.deepStrictEqual(lines(locate(FILE, ["top level"])), { start: 15, end: 17 });
  assert.deepStrictEqual(lines(locate(FILE, ["node style", "inner"])), { start: 19, end: 19 });
});

test("#28 D1 locate: a wrong chain, a title in a comment or string, or two matches is an error", () => {
  assert.ok(locate(FILE, ["skips a link"]).error, "the chain must include the describe");
  assert.ok(locate(FILE, ["nested", 'reads "quoted" titles']).error, "the chain starts at the top");
  assert.ok(locate(FILE, ["in a comment"]).error);
  assert.ok(locate(FILE, ["in a string"]).error);
  assert.ok(locate(FILE, ["walk"]).error, "a describe isn't a test");
  const twice = 'test("a", () => {});\ntest("a", () => {});\n';
  assert.match(locate(twice, ["a"]).error, /2 tests/);
});

test("#28 D-static: a test's body ignores comments, whitespace and where it sits; a changed literal or call changes it", () => {
  const base = 'describe("d", () => {\n  test("a", () => {\n    expect(f(1)).toBe(2);\n  });\n  test("b", () => expect(g).toBe(3));\n});\n';
  const body = (text, chain) => locate(text, chain).body;
  const at = bodies(base);
  for (const same of [
    base.replace("expect(f(1)).toBe(2);", "expect(f(1)).toBe(2);   "),
    base.replace("expect(f(1)).toBe(2);", "// pins f\n    expect( f(1) )\n      .toBe(2); /* still */"),
    'describe("d", () => {\n  test("b", () => expect(g).toBe(3));\n  test("a", () => {\n    expect(f(1)).toBe(2);\n  });\n});\n',
    base.replace('describe("d"', 'describe("renamed"').replace('test("a"', 'test("a2"'),
    base.replace("expect(f(1)).toBe(2);", "expect(\n      f(1,),\n    ).toBe(2,);"), // a formatter's trailing commas
  ]) {
    const chain = same.includes("renamed") ? ["renamed", "a2"] : ["d", "a"];
    assert.ok(at.has(body(same, chain)), same);
  }
  for (const changed of [
    base.replace("toBe(2)", "toBe(3)"),
    base.replace("f(1)", "f(1, 2)"),
    base.replace("expect(f(1)).toBe(2);", 'expect(f("1  2")).toBe(2);'),
    base.replace("expect(f(1)).toBe(2);", "expect(f(1)).toBe(2);\n    expect(f(2)).toBe(3);"),
  ]) {
    assert.ok(!at.has(body(changed, ["d", "a"])), changed);
  }
  assert.notStrictEqual(body("test('a', () => { return x });", ["a"]), body("test('a', () => { returnx });", ["a"]), "words stay apart");
});

test("#28 D-static: a name that a computed or templated title could also report is ambiguous (N12)", () => {
  const computed = 'const n = "adds";\ntest(n, () => {});\nif (false) test("adds", () => {});\n';
  assert.match(locate(computed, ["adds"]).error, /a test with a computed title could report the same name/);
  const concat = 'test("a" + "b", () => {});\ntest("a", () => {});\n';
  assert.match(locate(concat, ["a"]).error, /computed title/, "a title built from a literal is computed");
  const each = 'test.each([1, 2])("adds %s", (x) => {});\ntest("adds 1", () => {});\ntest("other", () => {});\n';
  assert.match(locate(each, ["adds 1"]).error, /computed title/);
  assert.deepStrictEqual(lines(locate(each, ["other"])), { start: 3, end: 3 }, "an .each title that can't match isn't ambiguous");
  const deeper = 'describe(name, () => {\n  test("t", () => {});\n});\ndescribe("d", () => {\n  test("t", () => {});\n});\n';
  assert.match(locate(deeper, ["d", "t"]).error, /computed title/, "a computed describe title counts too");
  const nested = 'describe.each([1])("case %d", (n) => {\n  test("t", () => {});\n});\ntest("t", () => {});\n';
  assert.deepStrictEqual(lines(locate(nested, ["t"])), { start: 4, end: 4 }, "a test inside describe.each sits one level down");
  assert.match(locate(nested, ["case %d", "t"]).error, /computed title|no such test/);
  const tagged = "test.each`\n  a | b\n  ${1} | ${2}\n`('adds $a', () => {});\ntest('adds 1', () => {});\n";
  assert.match(locate(tagged, ["adds 1"]).error, /computed title/);
});

test("#28 W08b: a templated title is a pattern of its static parts, not any name", () => {
  const t = "describe('add', () => {\n  for (const [a, b] of rows) test(`adds ${a} and ${b}`, () => {});\n  test('adds big', () => {});\n  test('adds 1 and 2', () => {});\n});\n";
  assert.deepStrictEqual(lines(locate(t, ["add", "adds big"])), { start: 3, end: 3 }, "the pattern can't report 'adds big'");
  assert.match(locate(t, ["add", "adds 1 and 2"]).error, /computed title/, "but it can report 'adds 1 and 2'");
  const nested = "test(`a ${`b ${c}`} d`, () => {});\ntest('a x d', () => {});\ntest('a x e', () => {});\n";
  assert.match(locate(nested, ["a x d"]).error, /computed title/);
  assert.deepStrictEqual(lines(locate(nested, ["a x e"])), { start: 3, end: 3 });
  const each = "test.each(rows)(`adds %s to ${n}`, () => {});\ntest('adds 1 to 2', () => {});\ntest('adds big', () => {});\n";
  assert.match(locate(each, ["adds 1 to 2"]).error, /computed title/);
  assert.deepStrictEqual(lines(locate(each, ["adds big"])), { start: 3, end: 3 });
});

test("#28 W03b: a semicolon is formatting, not a change; one inside a string still is", () => {
  const body = (text) => locate(text, ["a"]).body;
  assert.strictEqual(body("test('a', () => {\n  f(1);\n  g();\n});"), body("test('a', () => {\n  f(1)\n  g()\n});"));
  assert.notStrictEqual(body("test('a', () => { f(';'); });"), body("test('a', () => { f(''); });"));
  assert.notStrictEqual(body("test('a', () => { return x;y });"), body("test('a', () => { return xy });"), "words stay apart");
});
