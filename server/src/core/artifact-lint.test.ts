import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stripCode, lintContent, lintArtifacts, lintReason, summariseSloplint, resolveSloplint } from './artifact-lint.js';

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

  // Quoted or meta mentions of lorem ipsum in prose should NOT trigger critical lorem-ipsum
  const rProseMeta = lintContent('rules.md', 'The linter detects "Lorem ipsum" filler text and rejects empty deliverables.', () => true);
  assert.ok(!rProseMeta.some(i => i.rule === 'lorem-ipsum'));

  // True unquoted filler in markdown prose MUST trigger critical lorem-ipsum
  const rProseFiller = lintContent('draft.md', 'Here is the draft:\nLorem ipsum dolor sit amet, consectetur adipiscing elit.', () => true);
  assert.ok(rProseFiller.some(i => i.severity === 'critical' && i.rule === 'lorem-ipsum'));
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

test('artifact-lint: lintArtifacts also lints final deliverables in outputs/', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-lint-test-'));
  try {
    fs.mkdirSync(path.join(tmp, 'outputs'));
    fs.writeFileSync(path.join(tmp, 'notes.md'), '# Notes\n\nWorking notes.');
    fs.writeFileSync(path.join(tmp, 'outputs', 'report.md'), '   ');
    const rep = lintArtifacts(tmp);
    assert.deepEqual(rep.files.sort(), ['notes.md', 'outputs/report.md']);
    assert.equal(rep.critical.length, 1);
    assert.equal(rep.critical[0].file, 'outputs/report.md');
    assert.equal(rep.critical[0].rule, 'empty-file');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('artifact-lint: summariseSloplint keeps FAIL/REFLEX, skips the Hallmark stamp gate, and is warning-only', () => {
  const json = JSON.stringify({ findings: [
    { gate: '20', grade: 'FAIL', evidence: 'no Hallmark stamp' },
    { gate: '19', grade: 'FAIL', evidence: 'buzzword "Unlock"' },
    { gate: 'F23', grade: 'WARN', evidence: 'lacks lang' },
  ] });
  const issue = summariseSloplint('outputs/page.html', json);
  assert.equal(issue?.severity, 'warning');
  assert.equal(issue?.rule, 'sloplint');
  assert.match(issue!.message, /1 design tell\(s\).*#19 buzzword/);
  assert.equal(summariseSloplint('x.html', JSON.stringify({ findings: [{ gate: '20', grade: 'FAIL', evidence: 's' }] })), null);
  assert.equal(summariseSloplint('x.html', 'not json'), null);
});

test('artifact-lint: lintArtifacts runs sloplint only on outputs/*.html and never adds criticals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-sloplint-'));
  try {
    const script = path.join(dir, 'fake-sloplint.mjs');
    fs.writeFileSync(script, `console.log(JSON.stringify({ findings: [{ gate: '19', grade: 'FAIL', evidence: 'buzzword' }] })); process.exit(1);`);
    fs.mkdirSync(path.join(dir, 'outputs'));
    fs.writeFileSync(path.join(dir, 'outputs', 'page.html'), '<html><body><h1>Real page</h1></body></html>');
    fs.writeFileSync(path.join(dir, 'scratch.html'), '<html><body>scratch</body></html>');
    const r = lintArtifacts(dir, { sloplint: script, ignore: ['fake-sloplint.mjs'] });
    assert.equal(r.critical.length, 0);
    assert.deepEqual(r.warnings.filter(w => w.rule === 'sloplint').map(w => w.file), ['outputs/page.html']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact-lint: resolveSloplint only trusts a hallmark skill installed from Nutlope/hallmark', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-skills-'));
  try {
    const dir = path.join(home, 'hallmark', 'scripts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sloplint.mjs'), '');
    assert.equal(resolveSloplint(home), undefined);                       // no provenance stamp
    fs.writeFileSync(path.join(home, 'hallmark', '.cowork-integration.json'), JSON.stringify({ source: 'evil/hallmark' }));
    assert.equal(resolveSloplint(home), undefined);
    fs.writeFileSync(path.join(home, 'hallmark', '.cowork-integration.json'), JSON.stringify({ source: 'Nutlope/hallmark' }));
    assert.equal(resolveSloplint(home), path.join(dir, 'sloplint.mjs'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
