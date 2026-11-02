# Tasks page performance

Why the Tasks page was slow, what was fixed, and what each fix buys. Measured on
the GB10 host, 2026-11-02, in headless Chromium against the live server.

## 1. Per-task artifact lists were uncapped (f8f93d5)

One task stored 61,720 artifact paths (`node_modules` from a cloned repo). Every
reload of the list fetched 5.4 MB and built ~317k DOM nodes, about 1 s per render.
The dispatcher now caps the stored list at 300 entries, the API trims older
records, and a card shows 40 chips. Re-render went from ~1 s to ~50 ms, and the
New-task dialog from ~1.8 s to under 0.1 s.

## 2. SSE events patch one card, not the whole list

Before: every task event (claimed / completed / "taskCreated" nudges, which the
store also emits on edits) re-fetched `/inbox?limit=51` (~400 KB), rebuilt all
~50 cards with `innerHTML`, re-bound every button and re-hydrated every icon in
the document. Each event cost ~50 ms of main-thread work plus a 400 KB download.

Now `handleSSEEvent` collects the task ids an event names (`payload.task.id` /
`payload.taskId`). After the same 800 ms debounce, `patchInboxTasks(ids)` runs:

- `GET /inbox/:id` for each id (a few KB), then replace that card's node in place,
  remove it (deleted, or it no longer matches the status filter), or slot a new
  task in by `createdAt` (newest first). Cards for later pages are skipped.
- re-binds only the fresh card (`bindTaskCards(card)`), hydrates only its icons
  (`createIcons(card)`), carries the live progress log over, refreshes the pill
  counts from `/status`, and re-applies the title search.
- leaves a card alone while the user is typing in it (it is retried on the next
  event). Typing elsewhere, such as the search box, no longer blocks updates.
- falls back to a full `renderInbox()` when the list is empty, a fetch fails, or a
  new card can't be placed.

Events that name no task (agent registered, …) no longer touch the list. Other
views still do a full re-render, as before.

| per SSE event | before | after |
|---|---|---|
| network | `/inbox?limit=51` ≈ 400 KB | `/inbox/:id` (a few KB) + `/status` (0.2 KB) |
| DOM rebuilt | ~50 cards, ~9.7k nodes | 1 card |
| time (3 runs) | 47–59 ms (`renderInbox`) | 12–14 ms (`patchInboxTasks`, mostly the fetch) |

Check script: `artifacts/2c613e95-…/scripts/patch_check.py`. It tags every card
node, fires one event, and asserts that only the target node changed.

## 3. HTTP compression (`server/src/core/compression.ts`)

**Mechanism.** The client lists the encodings it can decode in `Accept-Encoding`.
The `compression` middleware picks one (br > gzip > deflate) and pipes the body
through a zlib stream. It sets `Content-Encoding`, drops `Content-Length` (the
response goes out chunked), and adds `Vary: Accept-Encoding` so caches keep the
variants apart. The browser decodes the body before JS sees it, so nothing
changes in the app code.

- gzip = DEFLATE (LZ77 back-references over a 32 KB window + Huffman coding) in a
  gzip frame, level 6. Browsers get brotli at quality 4: a similar ratio for JSON,
  slightly better, and less CPU. `curl -H 'Accept-Encoding: gzip'` gets gzip.
- Bodies under 1 KB are sent as-is, because framing overhead would eat the gain.
  Images and other non-text types are skipped (`compression.filter`, by MIME type).
- **SSE (`/api/events`) and `/mcp` are never compressed.** zlib holds output until
  its buffer fills, so a gzipped event stream would sit on "Connecting…" and the
  MCP streamable-HTTP transport would stall. They are excluded by path and by
  `Content-Type: text/event-stream`.
- `compression` skips HEAD requests. We run HEAD as the GET it mirrors (Node still
  sends no body for HEAD), so `curl -I` shows the same encoding a GET gets.

**What it improves: bytes on the wire, which means time on slow links.** It does
not cut server or render time: the browser still parses the same JSON and JS.
On this host over loopback the gain is near zero. Over Tailscale, or a phone on
LTE, transfer time dominates.

| payload | raw | gzip-6 | ratio | gzip CPU | br-4 | br CPU |
|---|---|---|---|---|---|---|
| `/api/inbox?limit=51` | 398 KB | 139 KB | 2.9× | 4.6 ms | 122 KB | 2.8 ms |
| `app.js` | 252 KB | 71 KB | 3.5× | 3.1 ms | 71 KB | 1.8 ms |
| `lucide.js` | 601 KB | 110 KB | 5.5× | 6.1 ms | 109 KB | 2.8 ms |
| `style.css` | 42 KB | 9.5 KB | 4.5× | 0.4 ms | 10 KB | 0.2 ms |
| `/api/status` | 0.2 KB | n/a (< 1 KB, sent raw) | | | | |

A cold Tasks-page load is ~1.4 MB raw and ~0.35 MB compressed, about 4× smaller.
Over a 10 Mbit/s mobile link that is ~1.1 s → ~0.3 s of transfer. Each full list
refresh (filter click, load-more) drops from ~400 KB to ~120–140 KB.

**CPU trade-off.** Compressing costs ~5–10 ms of server CPU per MB at these
settings. That is one core-millisecond or so per request on the GB10, versus 30–300
ms saved in transfer on a remote client. Browser-side decompression is under 1 ms.
Static files are re-compressed on every request (no pre-compressed cache). At this
traffic level (one operator) that costs nothing measurable. If it ever shows up,
pre-compress `public/` at build time. Server benchmark: `scripts/gzip_bench.mjs`
in the same artifacts folder.
