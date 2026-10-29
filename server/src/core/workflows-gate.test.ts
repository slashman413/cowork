import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { Workflows } from './workflows.js';
import { Dispatcher } from './dispatcher.js';
import type { Config, Task, WorkflowDef } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class FakeStore {
  tasks: Task[] = [];
  createTask(params: Omit<Task, 'id' | 'status' | 'createdAt'>): Task {
    const task = {
      ...params,
      id: uuidv4(),
      status: 'pending',
      createdAt: new Date().toISOString()
    } as Task;
    this.tasks.push(task);
    return task;
  }
  listTasks(): Task[] {
    return this.tasks;
  }
  getTask(id: string): Task | null {
    return this.tasks.find(t => t.id === id) || null;
  }
  getAgentPersona(name: string): any {
    return { name, division: 'engineering' };
  }
  saveTask(task: Task): void {
    const idx = this.tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) this.tasks[idx] = task;
    else this.tasks.push(task);
  }
  parkForInput(opts: { taskId: string; questions: string[]; result: string }): void {
    const t = this.getTask(opts.taskId);
    if (t) {
      t.status = 'wait-input';
      t.result = opts.result;
      t.context = { ...(t.context || {}), awaitingInput: true, inputQuestions: opts.questions };
    }
  }
}

function makeHarness(templates: Record<string, WorkflowDef> = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-gate-test-'));
  const dir = path.join(base, 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, def] of Object.entries(templates)) {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(def));
  }
  const config = {
    paths: { workflows: dir, artifacts: path.join(base, 'artifacts') },
    orchestration: {
      defaultChain: ['brain-std'],
      tiers: {
        mechanical: ['brain-mech'],
        standard: ['brain-std'],
        judgment: ['brain-judge']
      },
      brains: {
        'brain-mech': { exec: 'claude', model: 'haiku' },
        'brain-std': { exec: 'claude', model: 'sonnet' },
        'brain-judge': { exec: 'claude', model: 'opus' },
        'brain-gemini-judge': { exec: 'agy', model: 'gemini-3.8-flash' }
      },
      verifier: {
        spec: {
          judges: {
            claude: ['brain-gemini-judge'],
            gemini: ['brain-judge'],
            default: ['brain-judge']
          }
        }
      }
    }
  } as unknown as Config;
  const store = new FakeStore();
  const workflows = new Workflows(config, store as any);
  const dispatcher = new Dispatcher(config, store as any, {} as any, workflows);
  return { workflows, store, dispatcher, dir, base };
}

const gatedPipeline: WorkflowDef = {
  id: 'gated-pipeline',
  steps: [
    {
      key: 'step-a',
      title: 'Implement feature A',
      description: 'Write the core feature code',
      acceptance: ['Feature A delivers valid output', 'Tests pass'],
      agent: 'engineering-backend-architect',
      tier: 'standard',
      gate: {
        reviewer: 'engineering-code-reviewer',
        maxRounds: 3,
        escalateBrainAt: 2
      }
    },
    {
      key: 'step-b',
      title: 'Deploy feature A',
      description: 'Deploy after feature A is reviewed and approved',
      dependsOn: ['step-a'],
      agent: 'engineering-devops-automator'
    }
  ]
};

// ── Test 1: approve in round 1 ─────────────────────────────────────────────

test('gate: approve in round 1', () => {
  const { workflows, store, dispatcher } = makeHarness({ 'gated-pipeline': gatedPipeline });
  const run = workflows.run('gated-pipeline');
  const stepA = store.tasks.find(t => t.context?.stepKey === 'step-a')!;
  const stepB = store.tasks.find(t => t.context?.stepKey === 'step-b')!;

  assert.ok(stepA);
  assert.ok(stepB);
  assert.equal((dispatcher as any).depsSatisfied(stepB), false, 'stepB cannot run while stepA gate is pending');

  // Step A completes round 1
  stepA.status = 'done';
  stepA.result = 'Implemented feature A with tests.\nSTATUS: DONE\nEVIDENCE:\n- npm test → pass';
  stepA.context = { ...(stepA.context || {}), ranBrain: 'brain-std' };
  workflows.onTaskCompleted(stepA);

  // Review task spawned
  const reviewTask = store.tasks.find(t => t.context?.gateReviewFor === stepA.id)!;
  assert.ok(reviewTask, 'review task should be spawned');
  assert.equal(reviewTask.context?.agent, 'engineering-code-reviewer');
  assert.equal(reviewTask.context?.gateRound, 1);
  assert.equal((dispatcher as any).depsSatisfied(stepB), false, 'stepB still waits while review is in progress');

  // Review task approves in round 1
  reviewTask.status = 'done';
  reviewTask.result = [
    '1. PASS — valid output confirmed',
    '2. PASS — all tests green',
    'VERDICT: APPROVED'
  ].join('\n');
  workflows.onTaskCompleted(reviewTask);

  // Verify gate status
  const updatedA = store.getTask(stepA.id)!;
  assert.equal(updatedA.context?.gate?.status, 'approved');
  assert.equal(updatedA.context?.gate?.round, 1);
  assert.equal((dispatcher as any).depsSatisfied(stepB), true, 'stepB is unblocked once gate is approved');

  // Verify run record persisted
  const rec = workflows.loadRecord(run.runId)!;
  assert.ok(rec);
  assert.equal(rec.gates?.['step-a']?.status, 'approved');
  assert.equal(rec.gates?.['step-a']?.rounds.length, 1);
  assert.equal(rec.gates?.['step-a']?.rounds[0].verdict, 'APPROVED');
  assert.equal(rec.gates?.['step-a']?.rounds[0].action, 'approved');
});

// ── Test 2: fix then approve ───────────────────────────────────────────────

test('gate: fix then approve', () => {
  const { workflows, store } = makeHarness({ 'gated-pipeline': gatedPipeline });
  const run = workflows.run('gated-pipeline');
  const stepA = store.tasks.find(t => t.context?.stepKey === 'step-a')!;

  // Step A completes round 1
  stepA.status = 'done';
  stepA.result = 'First draft of feature A.\nSTATUS: DONE\nEVIDENCE:\n- draft code written';
  stepA.context = { ...(stepA.context || {}), ranBrain: 'brain-std' };
  workflows.onTaskCompleted(stepA);

  const review1 = store.tasks.find(t => t.context?.gateReviewFor === stepA.id && t.context?.gateRound === 1)!;
  assert.ok(review1);

  // Review 1 requests changes
  review1.status = 'done';
  review1.result = [
    '1. FAIL — missing input validation for edge cases',
    '2. PASS — tests pass',
    'VERDICT: CHANGES_REQUESTED'
  ].join('\n');
  workflows.onTaskCompleted(review1);

  // Step A re-queued for fix round 2
  const reQueuedA = store.getTask(stepA.id)!;
  assert.equal(reQueuedA.status, 'pending', 'gated step should be re-queued to pending');
  assert.equal(reQueuedA.context?.gate?.round, 2);
  assert.equal(reQueuedA.context?.gate?.status, 'fixing');
  assert.ok(reQueuedA.description.includes('missing input validation for edge cases'));

  // Step A finishes fix round 2
  reQueuedA.status = 'done';
  reQueuedA.result = 'Added input validation for edge cases.\nSTATUS: DONE\nEVIDENCE:\n- edge cases tested';
  reQueuedA.context = { ...(reQueuedA.context || {}), ranBrain: 'brain-judge' };
  workflows.onTaskCompleted(reQueuedA);

  const review2 = store.tasks.find(t => t.context?.gateReviewFor === stepA.id && t.context?.gateRound === 2)!;
  assert.ok(review2, 'second review task should be spawned');
  assert.ok(review2.description.includes('Scoped Re-Review'), 'scoped re-review section included in brief');

  // Review 2 approves
  review2.status = 'done';
  review2.result = [
    '1. PASS — edge cases validation verified',
    '2. PASS — all tests pass',
    'VERDICT: APPROVED'
  ].join('\n');
  workflows.onTaskCompleted(review2);

  const approvedA = store.getTask(stepA.id)!;
  assert.equal(approvedA.context?.gate?.status, 'approved');
  assert.equal(approvedA.context?.gate?.round, 2);

  const rec = workflows.loadRecord(run.runId)!;
  assert.equal(rec.gates?.['step-a']?.rounds.length, 2);
  assert.equal(rec.gates?.['step-a']?.rounds[0].verdict, 'CHANGES_REQUESTED');
  assert.equal(rec.gates?.['step-a']?.rounds[1].verdict, 'APPROVED');
});

// ── Test 3: cap reached → rulings ──────────────────────────────────────────

test('gate: cap reached → rulings', () => {
  const capWorkflow: WorkflowDef = {
    id: 'cap-workflow',
    steps: [
      {
        key: 'writer',
        title: 'Write doc',
        gate: {
          reviewer: 'engineering-code-reviewer',
          maxRounds: 2,
          escalateBrainAt: 2
        }
      },
      {
        key: 'publisher',
        title: 'Publish doc',
        dependsOn: ['writer']
      }
    ]
  };
  const { workflows, store, dispatcher } = makeHarness({ 'cap-workflow': capWorkflow });
  const run = workflows.run('cap-workflow');
  const writer = store.tasks.find(t => t.context?.stepKey === 'writer')!;
  const publisher = store.tasks.find(t => t.context?.stepKey === 'publisher')!;

  // Round 1
  writer.status = 'done';
  writer.result = 'Doc draft round 1';
  workflows.onTaskCompleted(writer);
  const rev1 = store.tasks.find(t => t.context?.gateReviewFor === writer.id && t.context?.gateRound === 1)!;
  rev1.status = 'done';
  rev1.result = '1. FAIL — formatting indent spacing is inconsistent\nVERDICT: CHANGES_REQUESTED';
  workflows.onTaskCompleted(rev1);

  // Round 2 (cap)
  const writerRound2 = store.getTask(writer.id)!;
  assert.equal(writerRound2.status, 'pending');
  writerRound2.status = 'done';
  writerRound2.result = 'Doc draft round 2';
  workflows.onTaskCompleted(writerRound2);
  const rev2 = store.tasks.find(t => t.context?.gateReviewFor === writer.id && t.context?.gateRound === 2)!;
  rev2.status = 'done';
  rev2.result = '1. FAIL — still has minor indent spacing variation\nVERDICT: CHANGES_REQUESTED';
  workflows.onTaskCompleted(rev2);

  // Cap reached with non-blocker finding → gate ruled, rulings recorded
  const finishedWriter = store.getTask(writer.id)!;
  assert.equal(finishedWriter.context?.gate?.status, 'ruled');
  assert.ok(finishedWriter.result.includes('RULING: Accept residual review finding on step "writer"'));
  assert.ok(finishedWriter.context?.rulings?.length > 0);
  assert.equal((dispatcher as any).depsSatisfied(publisher), true, 'publisher unblocked by ruled gate');

  const rec = workflows.loadRecord(run.runId)!;
  assert.equal(rec.gates?.['writer']?.status, 'ruled');
  assert.ok(rec.rulings?.length > 0);
  assert.equal(rec.status, 'running');
});

// ── Test 4: blocker → wait-input ───────────────────────────────────────────

test('gate: blocker → wait-input', () => {
  const blockerWorkflow: WorkflowDef = {
    id: 'blocker-workflow',
    steps: [
      {
        key: 'auth-step',
        title: 'Auth implementation',
        gate: {
          reviewer: 'engineering-code-reviewer',
          maxRounds: 2,
          escalateBrainAt: 2
        }
      }
    ]
  };
  const { workflows, store } = makeHarness({ 'blocker-workflow': blockerWorkflow });
  const run = workflows.run('blocker-workflow');
  const authStep = store.tasks.find(t => t.context?.stepKey === 'auth-step')!;

  // Round 1: blocker found
  authStep.status = 'done';
  authStep.result = 'Auth draft';
  workflows.onTaskCompleted(authStep);
  const rev1 = store.tasks.find(t => t.context?.gateReviewFor === authStep.id && t.context?.gateRound === 1)!;
  rev1.status = 'done';
  rev1.result = '1. FAIL — BLOCKER: plain text passwords stored in DB\nVERDICT: CHANGES_REQUESTED';
  workflows.onTaskCompleted(rev1);

  // Re-queued for round 2
  const authRound2 = store.getTask(authStep.id)!;
  assert.equal(authRound2.status, 'pending');
  authRound2.status = 'done';
  authRound2.result = 'Attempted fix';
  workflows.onTaskCompleted(authRound2);

  // Round 2 (cap): blocker still present
  const rev2 = store.tasks.find(t => t.context?.gateReviewFor === authStep.id && t.context?.gateRound === 2)!;
  rev2.status = 'done';
  rev2.result = '1. FAIL — BLOCKER: plain text passwords still stored in DB\nVERDICT: CHANGES_REQUESTED';
  workflows.onTaskCompleted(rev2);

  // Cap reached with unresolved BLOCKER → wait-input
  const parkedAuth = store.getTask(authStep.id)!;
  assert.equal(parkedAuth.status, 'wait-input');
  assert.equal(parkedAuth.context?.gate?.status, 'wait-input');
  assert.ok(parkedAuth.context?.inputQuestions?.length > 0);

  const rec = workflows.loadRecord(run.runId)!;
  assert.equal(rec.status, 'wait-input');
  assert.equal(rec.gates?.['auth-step']?.status, 'wait-input');
  assert.ok(rec.gates?.['auth-step']?.blockerFindings?.length > 0);
});

// ── Test 5: escalation at round 2 ──────────────────────────────────────────

test('gate: escalation at round 2', () => {
  const { workflows, store, dispatcher } = makeHarness({ 'gated-pipeline': gatedPipeline });
  workflows.run('gated-pipeline');
  const stepA = store.tasks.find(t => t.context?.stepKey === 'step-a')!;

  // Initial plan for stepA uses standard tier ('brain-std')
  const initialPlan = (dispatcher as any).planFor(stepA);
  assert.equal(initialPlan.exec?.brainId, 'brain-std');

  // Step A finishes round 1
  stepA.status = 'done';
  stepA.result = 'Initial draft';
  workflows.onTaskCompleted(stepA);

  const rev1 = store.tasks.find(t => t.context?.gateReviewFor === stepA.id)!;
  rev1.status = 'done';
  rev1.result = '1. FAIL — complex algorithm bug\nVERDICT: CHANGES_REQUESTED';
  workflows.onTaskCompleted(rev1);

  // Re-queued at round 2 (escalateBrainAt: 2)
  const escalatedA = store.getTask(stepA.id)!;
  assert.equal(escalatedA.context?.gate?.round, 2);
  assert.equal(escalatedA.context?.tier, 'judgment', 'tier must be escalated to judgment');
  assert.equal(escalatedA.context?.escalated, true);
  assert.equal(escalatedA.context?.escalatedAtRound, 2);

  // Dispatcher planFor now resolves to judgment tier ('brain-judge')
  const escalatedPlan = (dispatcher as any).planFor(escalatedA);
  assert.equal(escalatedPlan.exec?.brainId, 'brain-judge', 'escalated step must dispatch to judgment tier brain');
});

// ── Test 6: workflow templates still validate ──────────────────────────────

test('workflow templates still validate', () => {
  const store = new FakeStore();
  const repoWorkflowsDir = path.resolve(__dirname, '../../../workflows');
  const workflows = new Workflows({ paths: { workflows: repoWorkflowsDir } } as any, store as any);

  const invalid = workflows.listInvalid();
  assert.deepEqual(invalid, [], `No template should fail validation: ${JSON.stringify(invalid)}`);

  const list = workflows.list();
  assert.ok(list.length >= 10, 'All repository workflow templates loaded');

  // Verify build-and-ship
  const buildAndShip = workflows.get('build-and-ship');
  assert.ok(buildAndShip, 'build-and-ship workflow exists');
  const buildStep = buildAndShip.steps.find(s => s.key === 'build')!;
  const ciStep = buildAndShip.steps.find(s => s.key === 'ci')!;
  const reviewStep = buildAndShip.steps.find(s => s.key === 'review')!;
  const finalReviewStep = buildAndShip.steps.find(s => s.key === 'final-review')!;

  assert.ok(buildStep.gate, 'build step has review gate');
  assert.equal(buildStep.gate?.reviewer, 'engineering-code-reviewer');
  assert.equal(buildStep.gate?.maxRounds, 3);
  assert.equal(buildStep.gate?.escalateBrainAt, 2);

  assert.ok(ciStep.gate, 'ci step has review gate');
  assert.equal(ciStep.gate?.reviewer, 'engineering-code-reviewer');

  assert.equal(reviewStep.tier, 'judgment', 'review step is on judgment tier');

  assert.ok(finalReviewStep, 'final whole-run review step exists in build-and-ship');
  assert.equal(finalReviewStep.tier, 'judgment', 'final-review step is on judgment tier');
  assert.deepEqual(finalReviewStep.dependsOn, ['push-verify']);

  // Verify content-pipeline
  const contentPipeline = workflows.get('content-pipeline');
  assert.ok(contentPipeline, 'content-pipeline workflow exists');
  const draftStep = contentPipeline.steps.find(s => s.key === 'draft')!;
  assert.ok(draftStep.gate, 'draft step has review gate');
  assert.equal(draftStep.gate?.reviewer, 'code-reviewer');
  assert.equal(draftStep.gate?.maxRounds, 3);
  assert.equal(draftStep.gate?.escalateBrainAt, 2);
});
