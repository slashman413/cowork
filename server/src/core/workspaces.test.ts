import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from './store.js';
import { EventBus } from './events.js';
import { Dispatcher } from './dispatcher.js';
import { Workspaces, DEFAULT_COWORK_REPO_ROOT } from './workspaces.js';
import { resolveWorkspaceSessionPstackSkills, renderWorkspaceSessionSkillsPrompt } from './pstack-gates.js';
import type { Config } from '../types.js';

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-ws-unit-'));
  const paths: any = {};
  for (const k of ['inbox', 'artifacts', 'inputs', 'status', 'decisions', 'goals', 'workspaces', 'agencyAgents']) {
    paths[k] = path.join(root, k);
    fs.mkdirSync(paths[k], { recursive: true });
  }
  const config = {
    server: { port: 6868, host: '127.0.0.1' },
    paths,
    platforms: {},
    inbox: { maxRetries: 3 },
    orchestration: {
      maxConcurrent: 2,
      agents: {
        'local-cc-opus-5-5': { location: 'local', exec: 'claude', model: 'claude-opus-5-5' },
        'remote-worker-cc': { location: 'remote', host: 'remote-box' },
      },
      roleChains: {},
    },
  } as unknown as Config;

  const eventBus = new EventBus();
  const store = new Store(config, eventBus);
  store.initialize();
  const workspaces = new Workspaces(paths.workspaces, store, eventBus);
  workspaces.attachToEventBus();
  const dispatcher = new Dispatcher(config, store, eventBus);
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, paths, config, eventBus, store, workspaces, dispatcher, cleanup };
}

test('Workspace CRUD persists across restarts and scopes tasks cleanly by workspaceId', () => {
  const { paths, store, eventBus, workspaces, cleanup } = makeEnv();
  try {
    const wsA = workspaces.createWorkspace({ name: 'Alpha', description: 'Core backend work' });
    const wsB = workspaces.createWorkspace({ title: 'Beta', pstackAutoSkills: true });

    const tA = workspaces.createWorkspaceTask(wsA.id, {
      title: 'Design API schema',
      description: 'Architect the data model and types.ts interfaces',
    });
    const tB = workspaces.createWorkspaceTask(wsB.id, {
      title: 'Fix login bug',
      description: 'Debug crash on token refresh and verify fix',
    });
    const tGlobal = store.createTask({
      title: 'Global chore',
      description: 'Unassigned task',
      from: { platform: 'test', agent: 'tester' },
      to: {},
      priority: 'normal',
    });

    assert.equal(tA.workspaceId, wsA.id);
    assert.equal(tA.context?.workspaceId, wsA.id);
    assert.deepEqual(store.listTasks({ workspaceId: wsA.id }).map(t => t.id), [tA.id]);
    assert.deepEqual(store.listTasks({ workspaceId: wsB.id }).map(t => t.id), [tB.id]);
    assert.deepEqual(store.listTasks({ workspaceId: 'unassigned' }).map(t => t.id), [tGlobal.id]);

    // Attach & detach
    workspaces.attachTaskToWorkspace(wsA.id, tGlobal.id);
    assert.equal(store.listTasks({ workspaceId: wsA.id }).length, 2);
    workspaces.detachTaskFromWorkspace(wsA.id, tGlobal.id);
    assert.equal(store.listTasks({ workspaceId: wsA.id }).length, 1);

    // Reload from disk via fresh Workspaces instance
    const reloaded = new Workspaces(paths.workspaces, store, eventBus);
    const listed = reloaded.listWorkspaces();
    assert.equal(listed.length, 2);
    assert.equal(reloaded.getWorkspace(wsA.id)?.name, 'Alpha');

    // Update & delete
    const updated = reloaded.updateWorkspace(wsA.id, { name: 'Alpha v2', pinnedSkills: ['architect'] });
    assert.equal(updated?.name, 'Alpha v2');
    assert.deepEqual(updated?.pinnedSkills, ['architect']);

    const del = reloaded.deleteWorkspace(wsA.id);
    assert.equal(del.deleted, true);
    assert.equal(del.detachedTasks, 1);
    assert.equal(reloaded.getWorkspace(wsA.id), null);
    assert.equal(store.getTask(tA.id)?.workspaceId, undefined);
  } finally {
    cleanup();
  }
});

test('Continuous workspace sessions track multi-turn context, EventBus completion, pause/resume, and fork', async () => {
  const { store, workspaces, cleanup } = makeEnv();
  try {
    const ws = workspaces.createWorkspace({ name: 'Platform', defaultAgent: 'local-cc-opus-5-5' });
    const { session } = workspaces.createSession(ws.id, { title: 'New session' });
    assert.equal(session.status, 'idle');

    // Turn 1: sends prompt, auto-derives session title, creates workspace+session-scoped task
    const turn1 = workspaces.sendMessage(session.id, {
      prompt: 'Architect the workspace persistence layer in TypeScript and write unit tests',
    });
    assert.equal(turn1.session.status, 'working');
    assert.equal(turn1.task.workspaceId, ws.id);
    assert.equal(turn1.task.sessionId, session.id);
    assert.ok(turn1.turn.pstackSkills.length >= 1, 'auto-resolved at least one vendored pstack skill');
    assert.ok(turn1.turn.pstackSkills.includes('architect'), `expected architect skill, got ${turn1.turn.pstackSkills}`);
    assert.notEqual(turn1.session.title, 'New session');

    // Complete Turn 1 task via Store → EventBus syncs session automatically to idle
    await store.completeTask({ taskId: turn1.task.id, result: 'Designed schema and added tests.\nSTATUS: DONE' });
    const afterDone = workspaces.getSession(session.id)!;
    assert.equal(afterDone.status, 'idle');
    assert.equal(afterDone.turns[0].status, 'done');
    assert.match(afterDone.turns[0].response || '', /Designed schema/);

    // Turn 2: carries forward Turn 1 transcript into the new task description
    const turn2 = workspaces.sendMessage(session.id, {
      prompt: 'Now check blast radius of these changes before shipping',
    });
    assert.equal(turn2.turn.index, 2);
    assert.match(turn2.task.description, /Prior Session History/);
    assert.match(turn2.task.description, /Designed schema/);
    assert.ok(turn2.turn.pstackSkills.includes('blast-radius'));

    // Pause & resume active turn
    const paused = workspaces.pauseSession(session.id)!;
    assert.equal(paused.session.status, 'paused');
    assert.equal(store.getTask(turn2.task.id)?.status, 'paused');

    const resumed = workspaces.resumeSession(session.id)!;
    assert.equal(resumed.action, 'resumed-task');
    assert.equal(resumed.session.status, 'working');
    assert.equal(store.getTask(turn2.task.id)?.status, 'pending');

    // Fork session into sibling session within same workspace
    const forked = workspaces.forkSession(session.id, { title: 'Experiment branch' })!;
    assert.equal(forked.workspaceId, ws.id);
    assert.equal(forked.forkedFromSessionId, session.id);
    assert.equal(forked.turns.length, 2);
    assert.equal(workspaces.listSessions(ws.id).length, 2);

    // Resuming an idle session spawns a continuation turn with `recall` auto-injected
    await store.completeTask({ taskId: turn2.task.id, result: 'Blast radius verified.' });
    const continued = workspaces.resumeSession(session.id)!;
    assert.equal(continued.action, 'continued-turn');
    assert.ok(continued.session.turns[2].pstackSkills.includes('recall'));
  } finally {
    cleanup();
  }
});

test('Automatic vendored pstack skill injection into Dispatcher prompts works without manual context.skill', () => {
  const { workspaces, dispatcher, cleanup } = makeEnv();
  try {
    // 1. Direct resolver verification against real vendored catalog
    const resolved = resolveWorkspaceSessionPstackSkills({
      repoRoot: DEFAULT_COWORK_REPO_ROOT,
      prompt: 'Debug this TypeScript crash and add regression tests to prove it works',
      turnIndex: 1,
    });
    assert.ok(resolved.length >= 1, 'should resolve vendored pstack skills');
    for (const s of resolved) {
      assert.ok(fs.existsSync(s.filePath), `resolved SKILL.md must exist on disk: ${s.filePath}`);
    }
    assert.ok(
      resolved.some(s => s.name === 'typescript-best-practices' || s.name === 'principle-fix-root-causes' || s.name === 'tdd'),
      `expected relevant technical pstack skill, got: ${resolved.map(s => s.name).join(', ')}`,
    );

    // 2. End-to-end Dispatcher buildPrompt for a workspace session turn WITHOUT manual context.skill
    const ws = workspaces.createWorkspace({ name: 'Skills-WS', path: '/tmp' });
    const { session } = workspaces.createSession(ws.id, { title: 'Auto skills check' });
    const { task } = workspaces.sendMessage(session.id, {
      prompt: 'Review this architecture design and check blast radius before shipping',
    });
    assert.equal(task.context?.skill, undefined, 'manual context.skill must NOT be required');

    const localPrompt = (dispatcher as any).buildPrompt(task, {
      persona: 'generalist', isRoster: false, exec: 'claude', agentId: 'local-cc-opus-5-5',
    }) as string;
    assert.match(localPrompt, /# Workspace Context/);
    assert.match(localPrompt, /# Pstack Skills \(Workspace Session Auto-Workflow\)/);
    assert.match(localPrompt, /vendor\/pstack\/skills\/[a-z0-9-]+\/SKILL\.md/);

    // 3. Remote agent receives bounded inline skill excerpts instead of local filesystem paths
    const remotePrompt = (dispatcher as any).buildPrompt(task, {
      persona: 'generalist', isRoster: false, exec: 'claude', agentId: 'remote-worker-cc',
    }) as string;
    assert.match(remotePrompt, /# Pstack Skills \(Workspace Session Auto-Workflow\)/);
    assert.match(remotePrompt, /Apply these vendored pstack skills \(excerpts\):/);
    assert.match(remotePrompt, /## Skill:/);

    // 4. Explicit opt-out (autoPstackSkills: false) suppresses auto-injection
    const manualWs = workspaces.createWorkspace({ name: 'Manual-WS', pstackAutoSkills: false });
    const { session: manualSess } = workspaces.createSession(manualWs.id);
    const { task: manualTask } = workspaces.sendMessage(manualSess.id, { prompt: 'Architect a new service' });
    assert.deepEqual(manualTask.context?.pstackSkills, []);
    const manualPrompt = (dispatcher as any).buildPrompt(manualTask, {
      persona: 'generalist', isRoster: false, exec: 'claude', agentId: 'local-cc-opus-5-5',
    }) as string;
    assert.doesNotMatch(manualPrompt, /# Pstack Skills \(Workspace Session Auto-Workflow\)/);

    // 5. renderWorkspaceSessionSkillsPrompt renders cleanly for remote excerpts
    const remoteLines = renderWorkspaceSessionSkillsPrompt({
      repoRoot: DEFAULT_COWORK_REPO_ROOT,
      skills: resolved,
      isLocal: false,
    });
    assert.ok(remoteLines.join('\n').includes('## Skill:'));
  } finally {
    cleanup();
  }
});
