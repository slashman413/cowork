# @AI高玩 (AI 007) — YouTube cold-start / warm-up outreach system

Owner task: recurring cowork task 72be8541-7e24-47d0-b7a9-6238e90c5bce (every 6 h).
Runner: `scripts/yt_outreach.py` (stdlib only, OAuth token at `~/.priv/ai_gaowan_youtube_token.json`).

## What each run does
1. Searches YouTube for niche videos published in the last 48 h (bilingual seed
   keywords: `AI agent`, `coding agent`, `Claude Code`, `AI coding`, `LLM 編程`,
   `多智能體`, `AI 工作流`), newest first.
2. Dedupes against `logs/yt_outreach_history.json` (7-day cooldown per video).
3. Drafts one context-specific comment per candidate (≤6 considered per run).
4. Replies to our previously-posted comments that received a reply —
   replies are ordered FIRST (priority interactions).
5. Posts at most 3 items per run (`--post 3`), persists the structured payload.

## Comment style rules (anti-AI-feel, enforced in code + tests)
- Every comment references a concrete topic word pulled from the video's own
  title/description (`pick_topic_words`) — no generic "great video!" openers.
- Closer is question-leaning (people ask things; bots praise).
- Banned phrases (hard check, `ValueError` if leaked): `作为一个`, `希望对你有帮助`,
  `感谢分享`, `非常`, `总之`, `综上所述`, `As an AI`, `AI助手`, `我是AI`, …
- No emoji (regex-stripped safety net), no images, no links in the comment body.
- Length ~30–90 characters, one sentence family, warm and specific.
- Tests: `tests/test_yt_outreach.py` (15 tests, `python3 -m pytest tests/test_yt_outreach.py`).

## cowork pro promotion guideline (conditional soft-pitch)
- **Rule:** mention `cowork pro` **only** when the video's topic directly
  addresses a multi-agent / agent-workflow / automation / coding-agent pain
  point. Trigger keywords (in title or description): `agent`, `multi-agent`,
  `多智能体`, `orchestrat`, `workflow`, `工作流`, `automation`, `自动化`,
  `coding`, `編程`, `claude`, `cursor`, `copilot`, `llm`, `gpt`, `prompt`,
  `提示词`, `tool`, `工具`, `task`, `任務`.
- **Budget:** at most **1 pitch per run** (`PITCH_PER_RUN = 1`).
- **Form:** single natural mention appended to an otherwise normal comment,
  e.g. "顺带说下，我在维护一个叫 cowork 的多 agent 协作工具（cowork pro），
  让多个 agent 共享任务库分工，看到这个话题正好想到它，感兴趣可以搜一下。"
  — **no URL**, no hard sell, no discount code; discovery is left to search.
- **Never** pitch when the trigger set does not match; the `mentions_product`
  flag in the payload records which comments carry the pitch.

## Scheduling
- crontab (installed 2026-11-01, user wayne):
  `0 2,8,14,20 * * * flock -n /tmp/yt_outreach.lock /usr/bin/python3 .../scripts/yt_outreach.py --hours 48 --consider 6 --post 3`
  → daily (in fact 4×/day) live runs; logs to `logs/yt_outreach_cron.log`.
- Payload per run: `logs/yt_outreach_YYYY-MM-DD.json` — JSON array of records
  with `video_id, video_url, channel, channel_id, comment, mentions_product,
  status (draft | posted | replied | skipped:… | error:…)`.

## Human-only actions (YouTube Data API v3 limitations)
- Like + subscribe on the target channels cannot be done via API v3;
  each run prints `manual_actions.videos` for browser-based like/subscribe.
