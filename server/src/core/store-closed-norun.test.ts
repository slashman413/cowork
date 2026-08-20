import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isClosedWithoutRunning, isFailedTask } from './store.js';
import type { Task } from '../types.js';

/**
 * isClosedWithoutRunning distinguishes a `done` task that was CLOSED
 * administratively (superseded scheduled duplicate, pre-empted cancel) from a
 * real "done (ran)" task. Such a task never entered the dispatcher's run path,
 * so it has no artifacts dir and no result.md — on the dashboard that empty
 * artifacts list reads like a silent failure unless it is badged distinctly.
 * This pins the two detection signals and the failed-takes-precedence rule, and
 * MUST stay in lockstep with the frontend isTaskClosedNoRun (public/js/app.js).
 */
function mk(t: Partial<Task>): Task {
  return {
    id: 'x', title: 't', description: 'd',
    from: { platform: 'p', agent: 'a' }, to: {},
    priority: 'normal', status: 'done', createdAt: '2026-08-20T00:00:00.000Z',
    ...t,
  } as Task;
}

test('closed marker in the result flags a superseded, un-run task', () => {
  // The exact shape of the real incident: task 41ab0744, a scheduled G3 render
  // duplicate closed 58s after creation, ~19h before its own scheduledAt.
  const superseded = mk({
    completedAt: '2026-08-20T00:22:38.899Z',
    scheduledAt: '2026-08-20T19:00:00.000Z',
    result: 'SUPERSEDED — do not run. G3 is DONE via 9dcd2be4; this scheduled copy is closed.',
  });
  assert.equal(isClosedWithoutRunning(superseded), true, 'marker + completedAt<scheduledAt');
  assert.equal(isFailedTask(superseded), false, 'a closed task is not a failed task');

  for (const word of ['CLOSED', 'SKIPPED', 'CANCELLED', 'CANCELED', 'DUPLICATE', "WON'T FIX", 'NO-OP']) {
    assert.equal(
      isClosedWithoutRunning(mk({ result: `${word}: not needed.` })), true, `marker ${word}`,
    );
  }
});

test('marked done at/before its own scheduledAt is structurally un-run', () => {
  // No close marker, but it was completed before the dispatcher could release it.
  assert.equal(isClosedWithoutRunning(mk({
    completedAt: '2026-08-20T00:22:38.899Z',
    scheduledAt: '2026-08-20T19:00:00.000Z',
    result: 'closing this out',
  })), true);
});

test('a real "done (ran)" task is NOT classified as closed', () => {
  // Ran to completion: no marker, and (if scheduled) completed after launch.
  assert.equal(isClosedWithoutRunning(mk({
    completedAt: '2026-08-20T21:00:00.000Z',
    scheduledAt: '2026-08-20T19:00:00.000Z',
    result: 'Episode assembled; ffprobe verified.',
    artifacts: ['g3-assembly.md'],
  })), false, 'completed after launch, no marker');

  assert.equal(isClosedWithoutRunning(mk({
    completedAt: '2026-08-20T00:05:00.000Z',
    result: 'Done. Report in artifacts.',
  })), false, 'immediate done with no scheduledAt and no marker is a normal run');
});

test('failed takes precedence over closed', () => {
  const failed = mk({ failed: true, result: 'FAILED after 2 attempt(s) (chain exhausted).' });
  assert.equal(isFailedTask(failed), true);
  assert.equal(isClosedWithoutRunning(failed), false, 'failed is not re-labelled as closed');
});

test('only `done` tasks can be closed-without-running', () => {
  for (const status of ['pending', 'scheduled', 'in-progress', 'wait-input'] as const) {
    assert.equal(
      isClosedWithoutRunning(mk({ status, result: 'SUPERSEDED' })), false,
      `status ${status} is not a done-close`,
    );
  }
});
