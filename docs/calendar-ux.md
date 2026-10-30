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

## Visual grammar — "calm by default, loud on exceptions"

Most entries on this calendar are healthy recurring runs. If every one of them is a
boxed, coloured chip, the page turns into a wall of green and the one failure or
overdue fire gets lost. So the default look is quiet, and only states that need a
human get filled colour.

| Signal | Meaning |
|--------|---------|
| **Dot + text** (no box) | a finished run that needs nothing (done / closed without running / cancelled). The dot colour = status |
| **Dashed outline** | projected: a future fire that hasn't happened yet |
| **Thicker dashed outline**, grab cursor | the schedule's **next** fire, the only one you can drag |
| **Tinted fill + 3 px status bar** | needs eyes: queued · running · waiting for input · failed · overdue |
| Week blocks | always a soft tinted body with a status bar, so a run's duration reads as a shape. Projected = dashed body |
| Status colours | indigo scheduled · amber overdue · yellow queued · sky running · purple waiting for input · green done · red failed · grey closed without running / cancelled |
| Repeat icon | recurring series (agenda meta, schedules rail, detail sheet; left off chips to cut noise) |
| `×N` | N fires of one series that day, collapsed (more than 6 in a day; in week view they sit in the **Frequent** band) |
| ⚠ | overdue: the dispatcher should already have released it |
| Red line + time pill | now (week view; the pill sits in the hour gutter) |
| Accent-filled date circle + faint accent tint | today (month cell, week column + header, agenda date) |

The status colours match the Tasks page (`STATUS_COLORS` in `app.js`). The **Show**
toggles double as the legend: each swatch draws what it filters (dashed box =
Upcoming, dot = Scheduled runs / Ad-hoc).

## Layout

- **Toolbar** (one row on desktop): `Today` `‹` `›` **title** … segmented `Month | Week | Agenda` · `+ Schedule task`.
  The title is formatted per view: `October 2026`, `Oct 25 – 31, 2026`, `Oct 25 – Nov 1, 2026`, `Dec 28, 2026 – Jan 3, 2027`.
- **Sub-bar**: Show toggles (legend) on the left, time zone on the right.
- **Main card** + **Schedules rail** (288 px, sticky). Below 1100 px the rail drops under the
  calendar as a multi-column list.
- **Footer**: the drag hint and keyboard shortcuts as `kbd` keys (desktop only).
- **Phone (< 720 px)**: the title row has `Today` `‹` `›` on the right. The switcher fills the width next to a square `+` button.
  The legend scrolls sideways and the time zone is hidden.

## Views

- **Month**: 6×7 grid, up to 4 entries a day, then `N more`. The 1st of each month shows its short month name.
  Days outside the month are dimmed. Clicking the date or `N more` opens that day (week view on desktop).
  **Phone**: entries become up to 4 status dots per day (loud statuses sorted first so a failure is never hidden, `+N` for the rest).
  Tapping a day opens **agenda from that day**.
- **Week**: 24-hour grid, 48 px per hour, with faint half-hour lines. Runs are drawn from start to finish (at least 30 min tall).
  Blocks shorter than 40 px are one line (time + title). With 3 or more overlapping lanes, a block shows only its title, never wrapped per character.
  On load it scrolls to about two hours before now. **Phone**: columns keep 108 px and the grid scrolls sideways (opens on today), with a sticky hour gutter and day header.
- **Agenda**: the next 30 days, grouped by day. Each day has a date column (weekday · big date · month, or "Today").
  Each row has the time, a status bar (dashed = projected), the title (up to 2 lines) and a meta line: status · cadence · duration.
  Rows that need attention get a faint tint. This is the default on screens narrower than 720 px. When it is empty, it shows a "clear 30 days" message with a Schedule button.
- **Empty week/month**: a slim note at the top of the card says nothing is in the period and how to add something.
- **Schedules rail**: each item shows the relative next fire (`in 10 min`) + its absolute time, the title (up to 2 lines), and cadence · last-run dot.
  Run-now and edit icon buttons are dimmed until hover (always shown on phones). The brain is in the tooltip and the detail sheet.

**Motion**: changing view or period fades and slides the grid in (220 ms). The 60-second auto-refresh
does **not** animate. While a fetch is in flight, the old frame dims rather than blanking.
`prefers-reduced-motion` turns off all calendar transitions and animations.

The view and the three **Show** toggles (*Upcoming*, *Scheduled runs*, *Ad-hoc*)
persist in `localStorage['cowork-calendar']`.

## Interactions

| Action | Result |
|--------|--------|
| Click an entry | Detail sheet: status, time (absolute + relative), cadence, brain, next 5 fires, recent runs, and the actions *Open in Tasks*, *Open schedule*, *Edit schedule*, *Run now* (primary). Close with the × or the backdrop |
| Click empty day (month) / slot (week) | New task with **Run at** pre-filled to that time (the slot is snapped to 15 min; a month day uses 09:00). On a phone, tapping a month day opens it in agenda instead |
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
| `server/public/css/calendar.css` | all `.cal-*` styles: theme tokens from `style.css` plus a few `--cal-*` aliases, light + dark |
| `server/public/js/app.js` | route case; `createTaskModal({ scheduledAt })` pre-fill |

## Not in v1 (candidates)

- Pause/resume a series (needs a `paused` state server-side).
- Skip or move a *single* future occurrence (needs per-occurrence exceptions on the recurrence spec).
- Show workflow runs and goal checkpoints as their own layers.
- An iCal feed (`/api/calendar.ics`) to subscribe from Google/Apple Calendar.
- A "next fires" Overview widget for `layout.json`.
