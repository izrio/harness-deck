import assert from 'node:assert/strict';
import { gradeChoice, gradeTitle, parseChoice } from './grade.mjs';

assert.equal(parseChoice('{"choice":"code-review"}'), 'code-review');
assert.equal(parseChoice('  code-review  '), 'code-review');
assert.equal(parseChoice('"code-review"'), 'code-review');

assert.deepEqual(gradeChoice({ expected: 'code-review' }, '{"choice":"code-review"}'), {
  pass: true,
  actual: 'code-review',
  expected: 'code-review',
});
assert.equal(gradeChoice({ expected: 'code-review' }, '{"choice":"web-research"}').pass, false);

assert.equal(gradeTitle({ mustInclude: ['WSL', 'npm'], maxLength: 40 }, '修复 WSL 下 npm 全局路径').pass, true);
assert.equal(gradeTitle({ mustInclude: ['WSL', 'npm'], maxLength: 40 }, '修复 npm 路径').pass, false);
assert.equal(gradeTitle({ mustInclude: [], maxLength: 4 }, '这个标题太长了').pass, false);

console.log('eval graders: ok');
