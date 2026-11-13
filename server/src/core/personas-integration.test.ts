import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Integrations, detectRepo, DEFAULT_INTEGRATIONS } from './integrations.js';
import { Roster } from './roster.js';
import { matchPersona } from './persona-match.js';
import type { PersonaCard } from '../types.js';

/**
 * Personas moved from the agency-agents git submodule into integrations
 * (2026-11-13): a persona pack is detected as kind "persona", installing it
 * registers its clone as a Roster source, and the 9 default integrations are
 * provisioned once on first run.
 */
function personaPack(dir: string): void {
  const write = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
  write('README.md', '# Agency\n\nA collection of specialised AI agent personas for every team.\n');
  write('divisions.json', JSON.stringify({ engineering: { label: 'Engineering' }, design: { label: 'Design' } }));
  write('engineering/engineering-frontend-developer.md', '---\nname: Frontend Developer\ndescription: React, Vue and CSS UI implementation\n---\n# Frontend\nbody');
  write('engineering/engineering-backend-architect.md', '---\nname: Backend Architect\ndescription: Scalable APIs, databases and cloud infrastructure\n---\nbody');
  write('engineering/engineering-sre.md', '---\nname: SRE\ndescription: SLOs, observability, incident response\n---\nbody');
  write('design/design-ui-designer.md', '---\nname: UI Designer\ndescription: Visual design systems and component libraries\n---\nbody');
  write('design/design-brand-guardian.md', '---\nname: Brand Guardian\ndescription: Brand identity and consistency\n---\nbody');
  write('examples/sample-output.md', '---\nname: not a persona\ndescription: sample\n---\n');
  write('engineering/notes.md', 'just notes, no frontmatter');
}

function hubIn(tmp: string): Integrations {
  return new Integrations({
    root: path.join(tmp, 'integrations'), registry: path.join(tmp, 'integrations.json'),
    skillsHome: path.join(tmp, 'skills'), clientSkillDirs: [], defaults: [],
  }, { portalFile: path.join(tmp, 'portal.json') });
}

function register(hub: Integrations, id: string, dir: string) {
  (hub as any).put({
    id, source: id.replace('__', '/'), input: id.replace('__', '/'), url: `https://github.com/${id.replace('__', '/')}.git`, dir,
    addedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), status: 'fetched',
    detected: { kinds: ['library'], skills: [] },   // what the old detector recorded for agency-agents
    audit: { verdict: 'pass', counts: { critical: 0, high: 0, medium: 0 }, scannedFiles: 1, findings: [], at: new Date().toISOString() },
    installed: { skills: [] },
  });
}

test('detectRepo: an agency-agents style tree is a persona pack', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-detect-'));
  personaPack(tmp);
  const det = detectRepo(tmp);
  assert.ok(det.kinds.includes('persona'), `kinds=${det.kinds}`);
  assert.equal(det.personas?.count, 5);
  assert.deepEqual(det.personas?.divisions, ['design', 'engineering']);
  assert.ok(!det.kinds.includes('library'));
});

test('detectRepo: test fixtures are not skills, and the canonical skills/ copy wins', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-detect-'));
  const skill = (rel: string, name: string, desc: string) => { fs.mkdirSync(path.join(tmp, rel), { recursive: true }); fs.writeFileSync(path.join(tmp, rel, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n`); };
  skill('.cursor/skills/alpha', 'alpha', 'tool copy');
  skill('skills/alpha', 'alpha', 'canonical');
  skill('test/fixtures/fake', 'fake', 'fixture');
  for (let i = 0; i < 60; i++) skill(`skills/s${i}`, `s${i}`, 'x');
  const det = detectRepo(tmp);
  assert.equal(det.skills.find(s => s.name === 'alpha')?.description, 'canonical');
  assert.ok(!det.skills.some(s => s.name === 'fake'));
  assert.equal(det.skills.length, 61, 'no 50-skill cap');
});

test('installing a persona pack makes the Roster read it; uninstall removes it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-install-'));
  const hub = hubIn(tmp);
  const id = 'msitarzewski__agency-agents';
  const dir = path.join(tmp, 'integrations', id);
  personaPack(dir);
  register(hub, id, dir);
  const roster = new Roster(() => hub.personaRoots());
  assert.equal(roster.loadAll().length, 0, 'not installed yet');

  hub.rescan(id);
  const e = hub.install(id);
  assert.equal(e.status, 'installed');
  assert.equal(e.installed.personas?.count, 5);
  roster.reload();
  const slugs = roster.loadAll().map(p => p.slug).sort();
  assert.deepEqual(slugs, ['design-brand-guardian', 'design-ui-designer', 'engineering-backend-architect', 'engineering-frontend-developer', 'engineering-sre']);
  assert.equal(roster.getDivisions().engineering.label, 'Engineering');
  assert.match(roster.getPersona('engineering-sre')!.persona, /body/);

  hub.uninstall(id);
  roster.reload();
  assert.equal(roster.loadAll().length, 0);
});

test('ensureDefaults: re-detects + fully installs a present default once; verifyDefaults reports it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-defaults-'));
  const hub = new Integrations({
    root: path.join(tmp, 'integrations'), registry: path.join(tmp, 'integrations.json'),
    skillsHome: path.join(tmp, 'skills'), clientSkillDirs: [], defaults: ['msitarzewski/agency-agents'],
  }, { portalFile: path.join(tmp, 'portal.json') });
  const id = 'msitarzewski__agency-agents';
  const dir = path.join(tmp, 'integrations', id);
  personaPack(dir);
  register(hub, id, dir);
  assert.equal(hub.verifyDefaults()[0].ok, false);

  const out = await hub.ensureDefaults();
  assert.equal(out[0].ok, true, JSON.stringify(out[0]));
  assert.equal(out[0].personas, 5);

  // Seeded once: an operator uninstall is respected on the next boot.
  hub.uninstall(id);
  await hub.ensureDefaults();
  assert.equal(hub.get(id)!.status, 'fetched');
});

test('DEFAULT_INTEGRATIONS lists the nine first-run repos', () => {
  assert.equal(DEFAULT_INTEGRATIONS.length, 9);
  for (const r of ['msitarzewski/agency-agents', 'garrytan/gbrain', 'addyosmani/agent-skills', 'anthropics/skills', 'vercel-labs/agent-browser',
    'backnotprop/pstack', 'pbakaus/impeccable', 'Nutlope/hallmark', 'multica-ai/andrej-karpathy-skills']) {
    assert.ok(DEFAULT_INTEGRATIONS.includes(r), r);
  }
});

test('matchPersona picks the persona the brief describes, or nothing on a weak match', () => {
  const personas = [
    { slug: 'engineering-frontend-developer', name: 'Frontend Developer', description: 'React, Vue and CSS UI implementation', division: 'engineering' },
    { slug: 'marketing-seo-specialist', name: 'SEO Specialist', description: 'Technical SEO, keyword research, organic search ranking', division: 'marketing' },
    { slug: 'finance-tax-strategist', name: 'Tax Strategist', description: 'Tax optimization and multi-jurisdiction compliance', division: 'finance' },
  ] as PersonaCard[];
  assert.equal(matchPersona('Improve organic search ranking: SEO audit + keyword research for the blog', personas)?.slug, 'marketing-seo-specialist');
  assert.equal(matchPersona('Fix the React frontend: CSS layout breaks on mobile', personas)?.slug, 'engineering-frontend-developer');
  assert.equal(matchPersona('hello there', personas), null);
});
