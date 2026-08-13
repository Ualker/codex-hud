import assert from 'node:assert/strict';

import { parseJsLiteral, findJsStringContaining } from '../../dist/utils/js-literal.js';

// ---- the shape codex actually writes --------------------------------------
// `tools.exec_command({cmd: "…", workdir: "…"})`: unquoted keys, so JSON.parse
// throws and the tool row lost its command on every call.
{
  const value = parseJsLiteral('{cmd: "rg -n pattern src", workdir: "/repo"}');
  assert.deepEqual(value, { cmd: 'rg -n pattern src', workdir: '/repo' });
}

// Multi-line with trailing commas and comments, as the model formats it.
{
  const value = parseJsLiteral(`{
    cmd: "nl -ba file | sed -n '1,20p'",   // read the head
    workdir: "/Users/zyb/Desktop/prj",
    timeout_ms: 30000,
  }`);
  assert.equal(value.cmd, "nl -ba file | sed -n '1,20p'");
  assert.equal(value.workdir, '/Users/zyb/Desktop/prj');
  assert.equal(value.timeout_ms, 30000);
}

// ---- escapes are decoded, not echoed --------------------------------------
// A command is written as one JS string with \n between the lines; leaving the
// escapes in place would put a literal backslash-n on screen.
{
  const value = parseJsLiteral('{cmd: "test -e a\\ntest -e b", q: "say \\"hi\\""}');
  assert.equal(value.cmd, 'test -e a\ntest -e b');
  assert.equal(value.q, 'say "hi"');
}

// ---- template literals keep their text ------------------------------------
// Commands built per host arrive as backtick strings. The interpolation cannot
// be resolved, but the command around it is still worth showing.
{
  const value = parseJsLiteral('{cmd: `ssh -n ${host} "docker ps"`}');
  assert.equal(value.cmd, 'ssh -n ${host} "docker ps"');
}

// ---- an unreadable entry costs only itself --------------------------------
// This is the property that makes a tolerant reader worth having: a computed
// or variable argument must not take the command down with it.
{
  const value = parseJsLiteral('{cmd: "npm test", timeout: computeTimeout(), env: {...base}}');
  assert.equal(value.cmd, 'npm test');
  assert.equal('timeout' in value, false);
}

// ---- nested structures ----------------------------------------------------
{
  const value = parseJsLiteral(`{
    plan: [
      { step: "read the parser", status: "completed" },
      { step: "fix the row", status: "in_progress" },
    ]
  }`);
  assert.equal(value.plan.length, 2);
  assert.deepEqual(value.plan[1], { step: 'fix the row', status: 'in_progress' });
}

// ---- it declines anything that is not a literal ---------------------------
// The caller tries strict JSON first and falls back here, so returning
// undefined must stay the answer for input this reader does not model.
{
  assert.equal(parseJsLiteral('patch'), undefined);
  assert.equal(parseJsLiteral(''), undefined);
  assert.equal(parseJsLiteral(undefined), undefined);
  assert.equal(parseJsLiteral('await tools.exec_command(x)'), undefined);
}

// ---- real JSON still parses through the same path -------------------------
{
  assert.deepEqual(parseJsLiteral('{"cmd": "ls", "n": 2}'), { cmd: 'ls', n: 2 });
}

// ---- unterminated input terminates ----------------------------------------
// Rollout tails are read while codex is still writing them.
{
  assert.deepEqual(parseJsLiteral('{cmd: "ls'), {});
  assert.deepEqual(parseJsLiteral('{cmd: "ls", '), { cmd: 'ls' });
}

// ---- finding a string by content ------------------------------------------
// `tools.apply_patch(patch)` passes a variable; the patch is assigned above.
{
  const source =
    'const patch = "*** Begin Patch\\n*** Update File: /repo/a.ts\\n@@\\n-x\\n+y\\n*** End Patch";\n' +
    'const r = await tools.apply_patch(patch);';
  const patch = findJsStringContaining(source, '*** Begin Patch');
  assert.ok(patch, 'the patch body is found');
  assert.match(patch, /^\*\*\* Begin Patch\n/, 'and decoded, not left escaped');
  assert.match(patch, /^\*\*\* Update File: \/repo\/a\.ts$/m);
  assert.equal(findJsStringContaining(source, 'no such marker'), undefined);
  assert.equal(findJsStringContaining(undefined, 'x'), undefined);
}

console.log('test-js-literal: PASS');
