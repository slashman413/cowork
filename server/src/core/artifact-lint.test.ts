import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stripCode, lintContent, lintArtifacts, lintReason } from './artifact-lint.js';

test('artifact-lint: stripCode strips code blocks, inline code and comments', () => {
  const input = [
    'Normal text',
    '```python',
    '# Lorem ipsum in code block',
    '{{template_var}}',
    '```',
    'Inline `TODO: fixme` code',
    '<!-- HTML comment with [TODO] -->',
    'Final text',
  ].join('\n');
  const stripped = stripCode(input);
  assert.ok(stripped.includes('Normal text'));
  assert.ok(stripped.includes('Final text'));
  assert.ok(!stripped.includes('Lorem ipsum'));
  assert.ok(!stripped.includes('template_var'));
  assert.ok(!stripped.includes('TODO: fixme'));
  assert.ok(!stripped.includes('HTML comment'));
});

test('artifact-lint: lintContent flags critical and warning defects', () => {
  // Empty file
  const rEmpty = lintContent('empty.md', '   \n  \t', () => true);
  assert.equal(rEmpty.length, 1);
  assert.equal(rEmpty[0].severity, 'critical');
  assert.equal(rEmpty[0].rule, 'empty-file');

  // JSON parsing
  const rBadJson = lintContent('data.json', '{ "foo": "bar", }', () => true);
  assert.equal(rBadJson.length, 1);
  assert.equal(rBadJson[0].severity, 'critical');
  assert.equal(rBadJson[0].rule, 'invalid-json');

  const rGoodJson = lintContent('data.json', '{ "foo": "bar" }', () => true);
  assert.equal(rGoodJson.length, 0);

  // CSV
  const rEmptyCsv = lintContent('data.csv', 'id,name,value\n', () => true);
  assert.equal(rEmptyCsv.length, 1);
  assert.equal(rEmptyCsv[0].severity, 'warning');
  assert.equal(rEmptyCsv[0].rule, 'empty-table');

  // HTML
  const rHtmlLorem = lintContent('page.html', '<p>Lorem ipsum dolor sit amet</p>', () => true);
  assert.ok(rHtmlLorem.some(i => i.severity === 'critical' && i.rule === 'lorem-ipsum'));

  const rHtmlDeadAnchors = lintContent('page.html', '<a href="#">1</a><a href="#">2</a><a href="#">3</a><a href="#">4</a><a href="#">5</a>', () => true);
  assert.ok(rHtmlDeadAnchors.some(i => i.severity === 'warning' && i.rule === 'dead-anchors'));

  // Markdown prose
  const rProse = lintContent('report.md', 'Here is the report with {{unresolved_var}} and [TODO] items and [link](missing.pdf)', (rel) => rel !== 'missing.pdf');
  assert.ok(rProse.some(i => i.severity === 'critical' && i.rule === 'unresolved-template'));
  assert.ok(rProse.some(i => i.severity === 'warning' && i.rule === 'placeholder'));
  assert.ok(rProse.some(i => i.severity === 'warning' && i.rule === 'broken-link'));
});

test('artifact-lint: lintArtifacts scans directory and ignores runtime files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-lint-test-'));
  try {
    fs.writeFileSync(path.join(tmp, 'result.md'), 'result output with [TODO]');
    fs.writeFileSync(path.join(tmp, 'progress.log'), 'log output with [TODO]');
    fs.writeFileSync(path.join(tmp, 'clean.md'), '# Clean Report\n\nSolid report text.');
    fs.writeFileSync(path.join(tmp, 'bad.json'), 'not valid json');

    const rep = lintArtifacts(tmp);
    assert.deepEqual(rep.files.sort(), ['bad.json', 'clean.md']);
    assert.equal(rep.critical.length, 1);
    assert.equal(rep.critical[0].rule, 'invalid-json');

    const reason = lintReason(rep);
    assert.ok(reason.startsWith('ARTIFACT_QUALITY_GATE_FAILED:'));
    assert.ok(reason.includes('bad.json: JSON does not parse'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
