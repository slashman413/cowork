import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizeLayout, LayoutStore, LAYOUT_TEMPLATE, APP_PAGES } from './layout-config.js';

/**
 * layout.json is hand-edited and hot-reloaded, so the loader must (a) keep the
 * good parts when one page/widget is bad, (b) never let an app page become
 * unreachable by omission, and (c) keep serving the last good layout while the
 * file is mid-edit and fails to parse.
 */

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'layout-'));

test('repo default layout.json is valid and reproduces the built-in nav', () => {
  const v = normalizeLayout(JSON.parse(fs.readFileSync(LAYOUT_TEMPLATE, 'utf-8')), LAYOUT_TEMPLATE);
  assert.deepEqual(v.errors, []);
  assert.equal(v.defaultPage, 'overview');
  assert.deepEqual(v.sections.map((s) => s.label), ['Operations', 'AI Fleet', 'System']);
  assert.deepEqual(v.sections.flatMap((s) => s.pages),
    ['overview', 'portal', 'chat', 'tasks', 'calendar', 'workflows', 'goals', 'routing', 'brains', 'personas', 'workers', 'config']);
  assert.equal(v.pages.overview.type, 'dashboard');
  assert.deepEqual(v.pages.overview.rows!.map((r) => r.widgets.map((w) => w.type)),
    [['sysbar'], ['stats'], ['dispatcher', 'activity'], ['platforms']]);
});

test('bad pages/widgets/options are dropped with an error; good ones survive', () => {
  const v = normalizeLayout({
    brand: { icon: '<svg>' },
    defaultPage: 'nope',
    sections: [{ label: 'Main', pages: ['home', 'ghost', 'models', 'home'] }],
    pages: {
      home: {
        type: 'dashboard',
        rows: [
          [{ type: 'sysbar', tiles: ['cpu', 'disk'] }, { type: 'bogus' }],
          { minWidth: 5, widgets: [{ type: 'activity', limit: 99, color: 'red' }, { type: 'note' }] },
          [{ type: 'services', categories: ['Dev', 3], span: 9 }],
        ],
      },
      models: { type: 'portal', label: 'Models', categories: ['APIs & MCP'] },
      jobs: { type: 'tasks' },             // app page under a foreign id
      'Bad Id': { type: 'dashboard', rows: [] },
      weird: { type: 'iframe' },
    },
  }, 'mem');
  assert.equal(v.brand.icon, 'zap');
  assert.deepEqual(v.sections[0], { label: 'Main', pages: ['home', 'models'] });
  const [r1, r2, r3] = v.pages.home.rows!;
  assert.deepEqual(r1.widgets, [{ type: 'sysbar', tiles: ['cpu'] }]);
  assert.equal(r2.minWidth, undefined);
  assert.deepEqual(r2.widgets, [{ type: 'activity' }]);
  assert.deepEqual(r3.widgets, [{ type: 'services', categories: ['Dev'] }]);
  assert.deepEqual(v.pages.models.categories, ['APIs & MCP']);
  assert.equal(v.pages.jobs, undefined);
  assert.equal(v.defaultPage, 'home');
  // tiles, bogus, minWidth, limit, color, note, span, ghost, dup home, jobs, Bad Id, weird, defaultPage
  assert.equal(v.errors.length, 13, v.errors.join('\n'));
});

test('omitted app pages land in "More"; hidden ones stay routable but off the nav', () => {
  const v = normalizeLayout({
    sections: [{ label: 'Ops', pages: ['overview', 'tasks'] }],
    pages: {
      overview: { type: 'dashboard', rows: [] },
      tasks: {},
      config: { hidden: true },
      extra: { type: 'portal' },
    },
  }, 'mem');
  assert.deepEqual(v.errors, []);
  const more = v.sections.find((s) => s.label === 'More')!;
  assert.ok(more.pages.includes('extra'), 'defined-but-unplaced page is still reachable');
  for (const t of APP_PAGES) {
    assert.ok(v.pages[t], `app page ${t} always routable`);
    if (!['tasks', 'config'].includes(t)) assert.ok(more.pages.includes(t), `${t} appended to More`);
  }
  assert.ok(!v.sections.some((s) => s.pages.includes('config')), 'hidden page is not in the nav');
  assert.equal(v.pages.tasks.label, 'Tasks');
});

test('sections may name app pages without declaring them under "pages"', () => {
  const v = normalizeLayout({
    sections: [{ label: 'Work', pages: ['chat', 'tasks'] }],
    pages: { home: { type: 'dashboard', rows: [] } },
  }, 'mem');
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.sections[0], { label: 'Work', pages: ['chat', 'tasks'] });
  assert.equal(v.pages.chat.label, 'Chat');
  const more = v.sections.find((s) => s.label === 'More')!;
  assert.ok(more.pages.includes('home') && !more.pages.includes('chat'));
});

test('pre-rename app-page ids (inbox/team/roster/connections) migrate to the new ones', () => {
  const v = normalizeLayout({
    defaultPage: 'inbox',
    sections: [{ label: 'Ops', pages: ['inbox', 'team', 'roster', 'connections', 'mine'] }],
    pages: {
      inbox: { label: 'My Tasks' },
      connections: { type: 'connections', icon: 'plug' },
      mine: { type: 'dashboard', rows: [] },
      team: { type: 'dashboard', rows: [] },   // custom page that merely shares an old id
    },
  }, 'mem');
  assert.deepEqual(v.errors, []);
  assert.equal(v.defaultPage, 'tasks');
  assert.deepEqual(v.sections[0].pages, ['tasks', 'team', 'personas', 'workers', 'mine']);
  assert.equal(v.pages.tasks.label, 'My Tasks');
  assert.equal(v.pages.workers.type, 'workers');
  assert.equal(v.pages.team.type, 'dashboard');
  for (const old of ['inbox', 'roster', 'connections']) assert.equal(v.pages[old], undefined);
});

test('store serves the template until a live file exists, then hot-reloads it', () => {
  const dir = tmpDir();
  const live = path.join(dir, 'layout.json');
  const store = new LayoutStore(live);
  assert.equal(store.get().source, 'default');
  assert.equal(fs.existsSync(live), false, 'no seeding: defaults keep flowing to untouched installs');

  fs.writeFileSync(live, JSON.stringify({ brand: { title: 'Spark' }, pages: { home: { type: 'dashboard', rows: [] } } }));
  const v1 = store.get();
  assert.equal(v1.source, 'live');
  assert.equal(v1.brand.title, 'Spark');

  // Mid-edit garbage keeps the last good layout and reports the parse error.
  fs.writeFileSync(live, '{ "brand": ');
  fs.utimesSync(live, new Date(), new Date(Date.now() + 5000));
  const v2 = store.get();
  assert.equal(v2.brand.title, 'Spark');
  assert.equal(v2.errors.length, 1);
  assert.match(v2.errors[0], /layout\.json/);
});
