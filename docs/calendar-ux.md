# Calendar — UX & architecture

The **Calendar** page (`#calendar`, Operations section) shows tasks on a time axis.
It is built for **scheduled** work: when will each scheduled task fire, did its recent
runs succeed, and what is stuck. One-off ad-hoc tasks can be shown too, but are off by
default.

## Questions it answers

| Question | Where |
|----------|-------|
| What fires next, and when? | **Schedules** rail (sorted by next fire, with a relative time) · Agenda view |
| What does my week look like? Do runs pile up? | Week view (time grid, overlapping entries share the column) |
| Did the daily job run on each day, and did it pass? | Month view: a solid green or red chip per past run |
| Is anything stuck? | Amber **overdue** banner + ⚠ chips: a scheduled task past its launch time |
| How noisy is a cadence? | Dense series collapse to one `×N` chip (week: in the **dense** band) |

## Visual grammar

| Signal | Meaning |
|--------|---------|
| **Dashed outline** | projected: a future fire that hasn't happened yet |
| **Solid tint** | a real run (queued / running / done / failed …) |
| Left bar colour | status: indigo scheduled · amber overdue · yellow queued · sky running · purple waiting for input · green done · red failed · grey closed without running / cancelled |
| 🔁 icon | entry belongs to a recurring series |
| `×N` | N fires of one series that day, collapsed (more than 6 in a day) |
| ⚠ | overdue — the dispatcher should already have released it |
| Red line | now (week view) |

The status colours match the Tasks page (`STATUS_COLORS` in `app.js`).

## Views

- **Month**: 6×7 grid, up to 4 chips a day, then `+N more`. Clicking the date or `+N more` opens that week.
- **Week**: 24-hour grid with 44 px per hour. Runs are drawn from start to finish (at least 30 min tall). It scrolls to about two hours before now.
- **Agenda**: the next 30 days as a list grouped by day. This is the default on screens narrower than 720 px.

The view and the three **Show** toggles (*Upcoming*, *Scheduled runs*, *Ad-hoc tasks*)
persist in `localStorage['cowork-calendar']`.

## Interactions

| Action | Result |
|--------|--------|
| Click an entry | Detail sheet: status, time (absolute + relative), cadence, brain, next 5 fires, recent runs, and the actions *Open in Tasks*, *Open schedule*, *Edit schedule*, *Run now* |
| Click empty day (month) / slot (week) | New task with **Run at** pre-filled to that time (the slot is snapped to 15 min; a month day uses 09:00) |
| Drag an upcoming entry (draggable = the task's **next** fire) | Confirm, then `POST /inbox/:id/edit {scheduledAt}`. In month view it keeps the time of day; in week view it snaps to 15 min. |
| Detail sheet → *Reschedule* | Same as dragging, with a datetime field |
| *Run now* (rail or sheet) | Confirm, then `POST /inbox/:id/run-now`. A recurring task runs this cycle and re-arms. |
| `←` `→` / `T` / `M` `W` `A` | previous / next period, today, switch view |

**Only the next fire is movable.** Later fires of a recurring task are virtual. They are
computed from the cadence, and cowork has no per-occurrence exceptions. Moving the next
fire changes the task's `scheduledAt`. Later fires keep the cadence's phase, so a
fixed-time cadence ("every day at 08:00") snaps back after that run. To change every
run, edit the cadence.

## Data contract — `GET /api/calendar?from=ISO&to=ISO`

The default window is 7 days back to 35 days ahead, capped at 100 days. Logic lives in
`server/src/core/calendar.ts` (pure, unit-tested in `calendar.test.ts`).

```jsonc
{
  "from": "…", "to": "…", "now": "…",
  "events": [{
    "id": "<taskId> | <taskId>@<iso>",   // unique per entry
    "taskId": "…",                        // task to open/act on (scheduler for projected fires)
    "title": "…",
    "kind": "planned | run",
    "status": "scheduled|overdue|queued|running|wait-input|done|failed|skipped|cancelled",
    "start": "ISO", "end": "ISO?",        // end = completedAt for finished runs
    "seriesId": "…?",                     // the scheduler this entry belongs to
    "cadence": "every day at 08:00?",     // planned recurring only
    "head": true,                         // the movable next fire
    "priority": "…", "brain": "…"
  }],
  "series": [{                            // one per `scheduled` task, window-independent
    "taskId", "title", "next", "cadence" /* or "once" */, "recurring", "overdue",
    "lastRun": { "taskId", "status", "at" }, "firesInWindow", "truncated?"
  }]
}
```

- **Projection uses the dispatcher's own `nextRunAt`** (`core/recurrence.ts`) and steps
  from each fire, so the calendar matches what will run. An overdue recurring head
  re-phases after *now*, the same way `releaseDueScheduled` does.
- **Runs** are placed at `scheduledAt ?? createdAt`. A recurring run-child is created
  at its fire time and linked back through `context.scheduledParentId`.
- **Each series is capped at 400 fires per request** (`truncated: true`), so an
  every-minute cadence can't produce 40k entries.
- Status mapping reuses `isFailedTask` / `isClosedWithoutRunning` from `store.ts`. The
  page therefore agrees with the Tasks page on failed vs. closed-without-running.

## Files

| File | Role |
|------|------|
| `server/src/core/calendar.ts` (+ `.test.ts`) | projection: tasks → events + series |
| `server/src/api/router.ts` | `GET /api/calendar` |
| `server/src/core/layout-config.ts`, `layout.json` | `calendar` app page (nav: Operations, after Tasks) |
| `server/public/js/calendar.js` | the page (extends `App.prototype`; loaded after `app.js`) |
| `server/public/css/style.css` | `.cal-*` styles (theme tokens only, light + dark) |
| `server/public/js/app.js` | route case; `createTaskModal({ scheduledAt })` pre-fill |

## Not in v1 (candidates)

- Pause/resume a series (needs a `paused` state server-side).
- Skip or move a *single* future occurrence (needs per-occurrence exceptions on the recurrence spec).
- Show workflow runs and goal checkpoints as their own layers.
- An iCal feed (`/api/calendar.ics`) to subscribe from Google/Apple Calendar.
- A "next fires" Overview widget for `layout.json`.
