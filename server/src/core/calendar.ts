/**
 * Calendar — project the task store onto a time axis for the dashboard's
 * Calendar page (GET /api/calendar).
 *
 * Two kinds of entries, so past and future read on ONE timeline:
 *   - `planned` — a FUTURE fire of a `scheduled` task. A one-shot contributes its
 *     `scheduledAt`; a recurring scheduler is expanded with the SAME
 *     {@link nextRunAt} the dispatcher uses to re-arm it, so the calendar can
 *     never disagree with what will actually run.
 *   - `run` — something that already happened (or is happening): any
 *     non-scheduled task, placed at its intended launch time (`scheduledAt`, else
 *     `createdAt` — a recurring run-child is created at its fire time), spanning
 *     to `completedAt` when finished. Run-children carry `seriesId` (their
 *     scheduler's id) so a series' history and future line up.
 *
 * A scheduled task whose `scheduledAt` has already passed is flagged `overdue`:
 * the dispatcher should have released it, so it is stuck (e.g. dispatcher down).
 *
 * PURE: no I/O, the caller passes the tasks and `now`.
 */
import type { Task } from '../types.js';
import { normalizeRecurrence, recurrenceFromLegacyHours, nextRunAt, describeRecurrence, type TaskRecurrence } from './recurrence.js';
import { isFailedTask, isClosedWithoutRunning } from './store.js';

export type CalendarStatus =
  | 'scheduled' | 'overdue' | 'queued' | 'running' | 'wait-input'
  | 'done' | 'failed' | 'skipped' | 'cancelled';

export interface CalendarEvent {
  /** Unique per entry: the task id, or `<taskId>@<iso>` for a projected fire. */
  id: string;
  /** The task to open / act on (for a projected fire: the scheduler). */
  taskId: string;
  title: string;
  kind: 'planned' | 'run';
  status: CalendarStatus;
  /** ISO start: the fire time (planned) or intended launch time (run). */
  start: string;
  /** ISO end for a finished run (its completedAt). */
  end?: string;
  /** Scheduler id this entry belongs to (the scheduler itself, or a run-child's parent). */
  seriesId?: string;
  /** Human cadence label for recurring entries ("every day at 08:00"). */
  cadence?: string;
  priority?: Task['priority'];
  brain?: string;
  /** Only on the FIRST projected fire of a series: it is the task's real
   *  `scheduledAt`, so it can be dragged / run-now. Later fires are virtual. */
  head?: boolean;
}

/** One `scheduled` task, independent of the window — the "Schedules" list. */
export interface CalendarSeries {
  taskId: string;
  title: string;
  next: string | null;
  cadence: string;
  recurring: boolean;
  overdue: boolean;
  priority?: Task['priority'];
  brain?: string;
  tags?: string[];
  /** Outcome of the most recent finished run of this series, if any. */
  lastRun?: { taskId: string; status: CalendarStatus; at: string };
  /** Fires in the requested window (after capping). */
  firesInWindow: number;
  /** True when the window held more fires than {@link MAX_FIRES_PER_SERIES}. */
  truncated?: boolean;
}

export interface CalendarData {
  from: string;
  to: string;
  now: string;
  events: CalendarEvent[];
  series: CalendarSeries[];
}

/** Hard cap on projected fires per series per request — an every-minute cadence
 *  over a month would otherwise be 40k entries. The client renders a truncated
 *  series as a dense band and shows the cadence instead of individual chips. */
export const MAX_FIRES_PER_SERIES = 400;
/** A scheduled task this far past its launch time is reported as overdue (the
 *  dispatcher ticks far more often than this). */
const OVERDUE_GRACE_MS = 2 * 60 * 1000;

function cadenceOf(task: Task): TaskRecurrence | undefined {
  try {
    return task.recurrence ? normalizeRecurrence(task.recurrence) : recurrenceFromLegacyHours(task.loopIntervalHours);
  } catch {
    return undefined;   // a garbled spec is shown as a one-shot rather than breaking the page
  }
}

/** Map a non-scheduled task to its calendar status. */
export function runStatus(task: Task): CalendarStatus {
  if (isFailedTask(task)) return 'failed';
  switch (task.status as string) {
    case 'pending': case 'claimed': return 'queued';
    case 'in-progress': return 'running';
    case 'wait-input': return 'wait-input';
    case 'done': return isClosedWithoutRunning(task) ? 'skipped' : 'done';
    default: return 'cancelled';   // 'cancelled' and legacy/unknown statuses
  }
}

function brainOf(task: Task): string | undefined {
  const c = task.context || {};
  return c.ranBrain || (c.brainAuto ? undefined : c.brain) || undefined;
}

/**
 * Build the calendar for [from, to). Malformed timestamps are skipped, never thrown.
 */
export function buildCalendar(tasks: Task[], from: Date, to: Date, now: Date = new Date()): CalendarData {
  const fromMs = from.getTime(), toMs = to.getTime(), nowMs = now.getTime();
  const events: CalendarEvent[] = [];
  const series: CalendarSeries[] = [];
  const lastRuns = new Map<string, { taskId: string; status: CalendarStatus; at: string; ms: number }>();

  // History first: every task that is not parked on `scheduled`.
  for (const task of tasks) {
    if (!task || !task.id || task.status === 'scheduled') continue;
    const startIso = task.scheduledAt || task.createdAt;
    const startMs = Date.parse(String(startIso ?? ''));
    if (!Number.isFinite(startMs)) continue;
    const status = runStatus(task);
    const parent = task.context?.scheduledParentId as string | undefined;
    if (parent && ['done', 'failed', 'skipped'].includes(status)) {
      const prev = lastRuns.get(parent);
      if (!prev || startMs > prev.ms) lastRuns.set(parent, { taskId: task.id, status, at: new Date(startMs).toISOString(), ms: startMs });
    }
    const endMs = Date.parse(String(task.completedAt ?? ''));
    // In the window when the [start, end] span overlaps it.
    const spanEnd = Number.isFinite(endMs) ? Math.max(endMs, startMs) : startMs;
    if (spanEnd < fromMs || startMs >= toMs) continue;
    events.push({
      id: task.id, taskId: task.id, title: task.title, kind: 'run', status,
      start: new Date(startMs).toISOString(),
      ...(Number.isFinite(endMs) ? { end: new Date(endMs).toISOString() } : {}),
      ...(parent ? { seriesId: parent } : {}),
      priority: task.priority, brain: brainOf(task),
    });
  }

  // Future: expand every scheduled task.
  for (const task of tasks) {
    if (!task || !task.id || task.status !== 'scheduled') continue;
    const rec = cadenceOf(task);
    const cadence = rec ? describeRecurrence(rec) : '';
    const firstMs = Date.parse(String(task.scheduledAt ?? ''));
    const overdue = Number.isFinite(firstMs) && firstMs < nowMs - OVERDUE_GRACE_MS;
    const base = { taskId: task.id, title: task.title, kind: 'planned' as const, priority: task.priority, brain: brainOf(task) };
    let fires = 0, truncated = false;

    if (Number.isFinite(firstMs)) {
      let at: Date | null = new Date(firstMs);
      let head = true;
      while (at && at.getTime() < toMs) {
        if (at.getTime() >= fromMs) {
          if (fires >= MAX_FIRES_PER_SERIES) { truncated = true; break; }
          events.push({
            ...base, id: head ? task.id : `${task.id}@${at.toISOString()}`,
            status: head && overdue ? 'overdue' : 'scheduled',
            start: at.toISOString(), seriesId: task.id,
            ...(cadence ? { cadence } : {}), ...(head ? { head: true } : {}),
          });
          fires++;
        }
        if (!rec) break;
        // nextRunAt is strictly after both anchor and `now`; anchoring each step
        // on the previous fire walks the series exactly as the dispatcher will.
        // An overdue head fires on release, then the next slot is after real now.
        const stepNow: Date = head && overdue ? now : at;
        at = nextRunAt(rec, at, stepNow);
        head = false;
      }
    }

    const last = lastRuns.get(task.id);
    series.push({
      taskId: task.id, title: task.title,
      next: Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : null,
      cadence: cadence || 'once', recurring: !!rec, overdue,
      priority: task.priority, brain: brainOf(task), tags: task.tags,
      ...(last ? { lastRun: { taskId: last.taskId, status: last.status, at: last.at } } : {}),
      firesInWindow: fires, ...(truncated ? { truncated: true } : {}),
    });
  }

  events.sort((a, b) => a.start.localeCompare(b.start));
  series.sort((a, b) => (a.next || '9').localeCompare(b.next || '9'));
  return { from: from.toISOString(), to: to.toISOString(), now: now.toISOString(), events, series };
}
