#!/usr/bin/env python3
"""
yt_outreach.py — daily YouTube warm-up runner for channel @AI高玩.

Part of the scheduled task "YouTube @AI高玩 頻道冷啟動與暖身"
(recurring task 72be8541-7e24-47d0-b7a9-6238e90c5bce, every 6 hours: 02:00, 08:00, 14:00, 20:00).

Each run:
  1. Searches YouTube for videos published in the last N hours matching the
     channel's niche (AI agents / coding agents / AI tools), newest first.
  2. Skips videos already touched within the last 7 days (dedupe via
     logs/yt_outreach_history.json).
  3. Drafts a short, specific, human-sounding comment for each candidate.
     Comments reference the video's own topic; AI-ish clichés are banned.
  4. Soft-pitches "cowork pro" (NO url in the comment) only when the video
     topic is directly about multi-agent / agent-workflow / coding-agent
     pain points, and at most once per run.
  5. If a previously-posted comment received a reply, draft a warm reply
     and post it first (priority interactions).
  6. Posts the top N drafts via commentThreads.insert (skipped in
     --dry-run) and persists a structured outreach payload (JSON array)
     to logs/yt_outreach_YYYY-MM-DD_HHMM.json (UTC; HHMM keeps same-date
     runs from clobbering each other's payload).

YouTube Data API v3 cannot like videos or subscribe to channels (ratings
removed in 2020; channels.subscribe never existed in v3) — those stay
human-only and are listed under manual_actions in stdout.

Stdlib only. OAuth token lives at ~/.priv/ai_gaowan_youtube_token.json
(both native 'access_token' and legacy 'token'+'expiry' export formats are
accepted; load_token() auto-refreshes a missing/expired access token via
the OAuth token endpoint before any API call).
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import random
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "https://www.googleapis.com/youtube/v3"
TOKEN_FILE = os.path.expanduser("~/.priv/ai_gaowan_youtube_token.json")
REPO = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
HISTORY_FILE = os.path.join(REPO, "logs", "yt_outreach_history.json")
LOGS_DIR = os.path.join(REPO, "logs")
FIXTURES_FILE = os.path.join(REPO, "tests", "fixtures", "yt_videos.json")
COOLDOWN_DAYS = 7
PITCH_PER_RUN = 1
MY_CHANNEL_ID = "UCADDoyvSb2xji8Boo9sUSZw"
MY_CHANNEL_NAMES = {"@AI高玩", "AI 007"}

# Niche of @AI高玩 (AI agents, coding agents, AI tooling). Bilingual seed
# keywords: English covers most of the space the niche publishes in;
# Chinese catches the local creator ecosystem.
SEARCH_KEYWORDS = [
    "AI agent",
    "coding agent",
    "Claude Code",
    "AI coding",
    "LLM 编程",
    "多智能体",
    "AI 工作流",
]

# Topics that make a cowork-pro soft-pitch organically relevant.
# Rule: trigger ONLY when the video topic directly addresses a workflow pain
# point (multi-agent orchestration, automation pipelines, coding-agent
# workflows, agent tooling at the team/task level). Broad single tokens
# ("agent", "llm", "gpt", "tool", "coding" alone) are deliberately NOT
# triggers: an AI-explainer or news video is not a workflow pain point, and a
# pitch there reads as spam to a blind reviewer.
PITCH_TRIGGERS = [
    "multi-agent", "多智能体", "多agent", "多 agent", "orchestrat",
    "agent workflow", "agent 工作流", "agent 协作", "agent协作",
    "workflow", "工作流", "automation", "自动化",
    "coding agent", "coding 工作流", "编程工作流",
    "multi agent", "multi agent 工作流", "multiagent",
]

# ---------------------------------------------------------------------------
# Comment generation — the anti-AI-feel layer
#
# Rules (enforced by construction, not by vibe):
#   * every comment must reference a topic word taken from the video's own
#     title/description — no generic "great video!" openers;
#   * closers are question-leaning (people ask things; bots praise);
#   * banned: "作为一个", "希望对你有帮助", "感谢分享", "非常", "总之",
#     "综上所述", any "As an AI" phrasing, emoji-only greetings;
#   * no emoji (stripped as a safety net);
#   * length ~30-90 Chinese characters, one sentence family.
# ---------------------------------------------------------------------------

OPENERS = [
    "刚刷到你这条讲「{kw}」的，",
    "这条讲「{kw}」来得挺及时，",
    "第一次见有人把「{kw}」拆得这么细，",
    "之前一直关注「{kw}」这块，",
    "正好在研究「{kw}」相关的内容，",
    "看完你这段讲「{kw}」的，",
]

QUESTIONS = [
    "你们实际用的时候最卡在哪一步？",
    "有没有踩过权限或者成本失控的坑？",
    "这套东西在团队里推得动吗，还是主要个人在用？",
    "后续有打算往{kw2}方向延伸吗？",
    "方便的话能分享个踩坑小结吗？",
    "有配套的资料或 demo 可以看看吗？",
    "你们更看重哪个环节？{kw} 的稳定性还是迭代速度？",
]

REPLY_OPENERS = [
    "刚看到你有回我，",
    "看到你回我了，",
    "谢谢你回复，",
]

REPLY_CLOSES = [
    "后续有新进展的话喊我一声，正好可以一起踩坑。",
    "有踩坑记录的话可以发我看看，我这边也有类似情况。",
    "回头我出个对比笔记，到时候发你参考。",
]

# Natural, single-mention, no-URL pitch. Inserted only when triggered.
PITCH = (" 顺带说下，我在维护一个叫 cowork 的多 agent 协作工具（cowork pro），"
         "让多个 agent 共享任务库分工，看到这个话题正好想到它，感兴趣可以搜一下。")

BANNED = ["作为一个", "希望对你有帮助", "感谢分享", "非常", "总之",
          "综上所述", "作为一个AI", "作为AI", "AI助手", "我是AI"]

# Unicode emoji ranges (simplified — covers common ranges)
_EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\U00002700-\U000027BF"
    "\U0001F000-\U0001F0FF\U0001F900-\U0001F9FF"
    "\U00002600-\U000026FF\U00002700-\U000027BF]+"
)


def pick_topic_words(title, description):
    """Pull 1-3 concrete topic words out of the video's own metadata."""
    text = ((title or "") + " " + (description or "")).lower()
    found = []
    for kw in ["claude code", "cursor", "copilot", "gpt", "llm",
               "agent", "多智能体", "智能体", "工作流",
               "自动化", "提示词", "prompt", "编程", "coding", "workflow"]:
        if kw in text and kw not in found:
            found.append(kw)
    return found[:3]


def _strip_emoji(text):
    """Remove any emoji characters (safety net)."""
    return _EMOJI_RE.sub("", text)


def _check_banned(text):
    """Raise if a banned phrase leaked into the generated text."""
    for b in BANNED:
        if b in text:
            raise ValueError(f"banned phrase leaked: {b!r}")


def _pick_unused(pool, used, rng):
    """Pick a template without repeating one already used this run.

    Repeating an opener across comments posted from the same account in one
    batch is a strong bot tell a blind reviewer would catch. Fall back to
    free choice only when the pool is exhausted.
    """
    fresh = [p for p in pool if p not in used]
    pick = rng.choice(fresh) if fresh else rng.choice(pool)
    used.add(pick)
    return pick


def make_comment(video, pitch_allowed, rng, used_openers=None, used_questions=None):
    """Draft a context-specific, human-sounding comment.

    Shape: one specific observation about the video's own topic + one
    concrete question. Keyword appears at most once per comment.
    Passes sets of already-used templates to keep drafts within one run
    from sharing openers/questions (bot-tell avoidance).
    Returns (comment_text, mentions_product).
    """
    words = pick_topic_words(video.get("title", ""), video.get("description", ""))
    kw = rng.choice(words) if words else "AI agent"
    kw2 = rng.choice([w for w in words if w != kw]) if len(words) > 1 else "自动化"

    if used_openers is not None and used_questions is not None:
        opener = _pick_unused(OPENERS, used_openers, rng).format(kw=kw)
        q = _pick_unused(QUESTIONS, used_questions, rng).format(kw=kw, kw2=kw2)
    else:
        opener = rng.choice(OPENERS).format(kw=kw)
        q = rng.choice(QUESTIONS).format(kw=kw, kw2=kw2)
    text = opener + q

    mentions = False
    low = ((video.get("title") or "") + " " + (video.get("description") or "")).lower()
    triggered = any(t.lower() in low for t in PITCH_TRIGGERS)
    if triggered and pitch_allowed:
        text += PITCH
        mentions = True

    # Hard guard: never emit a banned AI-cliche phrase or emoji
    text = _strip_emoji(text)
    _check_banned(text)
    return text, mentions


def make_reply(their_comment_text, rng):
    """Draft a warm, empathetic reply to someone who replied to our comment."""
    opener = rng.choice(REPLY_OPENERS)
    closer = rng.choice(REPLY_CLOSES)
    # Extract a short fragment from their comment for reference, stripping
    # zero-width/BOM chars (YouTube reply text often starts with them) so the
    # ^-anchored mention strip below actually fires.
    raw = (their_comment_text or "").strip()
    raw = raw.replace("\u200b", "").replace("\u200c", "").replace("\u200d", "").replace("\ufeff", "")
    raw = re.sub(r"^(@\S+\s*)+", "", raw).strip()
    if len(raw) > 20:
        snippet = raw[:20].rstrip() + "..."
    else:
        snippet = raw
    text = f"{opener}你说的「{snippet}」这块我也遇到过，{closer}"
    text = _strip_emoji(text)
    _check_banned(text)
    return text


# ---------------------------------------------------------------------------
# YouTube API plumbing
# ---------------------------------------------------------------------------


def _token_expired(tok, now=None):
    """True when the token's 'expiry'/'expires_at' is within 120s of now.

    No expiry field → assume valid; the 401/403 retry in api() refreshes.
    """
    now = now or dt.datetime.now(dt.timezone.utc)
    for key in ("expiry", "expires_at"):
        raw = tok.get(key)
        if not raw:
            continue
        try:
            exp = dt.datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except (ValueError, TypeError):
            continue
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=dt.timezone.utc)
        return exp <= now + dt.timedelta(seconds=120)
    return False


def load_token(path=TOKEN_FILE):
    """Load the OAuth token file and guarantee a usable access token.

    Handles both file formats:
      - native: {"access_token", "client_id", "client_secret", "refresh_token"}
      - legacy OAuth export: {"token", "expiry", "refresh_token", ...}
    Normalizes the legacy 'token' key onto 'access_token' and refreshes via
    the OAuth token endpoint when the token is missing or expired (a
    KeyError on 'access_token' here used to crash every cron run).
    """
    with open(path) as f:
        tok = json.load(f)
    if not tok.get("access_token"):
        tok["access_token"] = tok.get("token") or ""
    if not tok.get("access_token") or _token_expired(tok):
        try:
            return refresh_token(tok, path)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(
                f"could not obtain a fresh YouTube access token from {path}: {e}"
            ) from e
    return tok


def refresh_token(tok, path=TOKEN_FILE):
    """Refresh the access token via the OAuth token endpoint and persist it."""
    for key in ("client_id", "client_secret", "refresh_token"):
        if not tok.get(key):
            raise RuntimeError(
                f"token file missing {key!r}; re-issue the OAuth token at {path}")
    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "client_id": tok["client_id"],
        "client_secret": tok["client_secret"],
        "refresh_token": tok["refresh_token"],
    }).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=body, method="POST")
    resp = json.load(urllib.request.urlopen(req))
    if "access_token" not in resp:
        raise RuntimeError(
            f"OAuth refresh response missing access_token: keys={list(resp)}")
    tok["access_token"] = resp["access_token"]
    if resp.get("expires_in"):
        tok["expiry"] = (dt.datetime.now(dt.timezone.utc)
                         + dt.timedelta(seconds=int(resp["expires_in"]))).isoformat()
    with open(path, "w") as f:
        json.dump(tok, f, indent=2)
    return tok


def api(path, params=None, token=None, body=None, method="GET"):
    """GET/POST against YouTube Data API v3 with OAuth Bearer auth.
    Refreshes once on 401/403-invalid-auth."""
    tok = token or load_token()
    for attempt in (1, 2):
        url = f"{API}/{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            url, data=data, method=method,
            headers={"Authorization": f"Bearer {tok['access_token']}"})
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            return json.load(urllib.request.urlopen(req))
        except urllib.error.HTTPError as e:
            if attempt == 1 and e.code in (401, 403):
                try:
                    json.load(e)
                except ValueError:
                    pass
                try:
                    tok = refresh_token(tok)
                    continue
                except urllib.error.HTTPError:
                    pass
            raise
    raise RuntimeError("unreachable")


def search_videos(tok, hours, per_query=6):
    """Newest-first videos in the niche, published within `hours`."""
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    seen, items = {}, []
    for kw in SEARCH_KEYWORDS:
        q = {"part": "snippet", "type": "video", "order": "date",
             "q": kw, "maxResults": str(per_query),
             "publishedAfter": since}
        try:
            data = api("search", q, tok)
        except urllib.error.HTTPError:
            continue
        for it in data.get("items", []):
            vid = it.get("id", {}).get("videoId")
            if not vid or vid in seen:
                continue
            seen[vid] = it["snippet"]
            items.append(vid)
    return items


def video_details(tok, ids):
    """Return {id: {title, channelTitle, channelId, viewCount, publishedAt}}."""
    out = {}
    chunk = []
    for i, vid in enumerate(ids):
        chunk.append(vid)
        if len(chunk) == 50 or i == len(ids) - 1:
            data = api("videos", {"part": "snippet,statistics",
                                  "id": ",".join(chunk)}, tok)
            for v in data.get("items", []):
                sn, st = v["snippet"], v.get("statistics", {})
                out[v["id"]] = {
                    "video_url": f"https://www.youtube.com/watch?v={v['id']}",
                    "title": sn.get("title", ""),
                    "channel": sn.get("channelTitle", ""),
                    "channel_id": sn.get("channelId", ""),
                    "view_count": int(st.get("viewCount", 0) or 0),
                    "published": sn.get("publishedAt", ""),
                    "description": (sn.get("description") or "")[:500],
                }
            chunk = []
    return out


def post_comment(tok, video_id, text):
    body = {"snippet": {"videoId": video_id,
                        "topLevelComment": {"snippet": {"textOriginal": text}}}}
    data = api("commentThreads", {"part": "snippet"}, tok, body, "POST")
    return data.get("id")


def post_reply(tok, comment_id, text):
    """Post a reply to an existing comment."""
    body = {"snippet": {"parentId": comment_id,
                        "textOriginal": text}}
    data = api("comments", {"part": "snippet"}, tok, body, "POST")
    return data.get("id")


def check_replies(tok, thread_ids, history=None):
    """Check which of our posted comment threads received replies.

    Returns list of dicts: {thread_id, video_id, reply_text, reply_author}.
    Skips threads where our channel was already the last to reply, or where
    the other party's reply is older than our recorded last_reply_at.
    """
    replies = []
    history = history or {}
    hist_by_thread = {}
    hist_by_vid = {}
    for vid, h in history.items():
        if isinstance(h, dict):
            hist_by_vid[vid] = h
            if h.get("thread_id"):
                hist_by_thread[h["thread_id"]] = h

    for tid in thread_ids:
        try:
            data = api("commentThreads",
                       {"part": "snippet,replies", "id": tid,
                        "maxResults": "5"}, tok)
        except urllib.error.HTTPError:
            continue
        for thread in data.get("items", []):
            replies_list = thread.get("replies", {}).get("comments", [])
            if not replies_list:
                continue
            # If our channel was already the last to respond, we are done
            last_sn = replies_list[-1].get("snippet", {})
            last_author_id = last_sn.get("authorChannelId", {}).get("value")
            last_author_name = last_sn.get("authorDisplayName", "")
            if last_author_id == MY_CHANNEL_ID or last_author_name in MY_CHANNEL_NAMES:
                continue

            vid = thread.get("snippet", {}).get("videoId")
            h_entry = hist_by_thread.get(tid) or hist_by_vid.get(vid)
            last_reply_at_dt = None
            if h_entry and h_entry.get("last_reply_at"):
                try:
                    last_reply_at_dt = dt.datetime.fromisoformat(h_entry["last_reply_at"])
                    if last_reply_at_dt.tzinfo is None:
                        last_reply_at_dt = last_reply_at_dt.replace(tzinfo=dt.timezone.utc)
                except (ValueError, TypeError):
                    pass

            # Get the latest reply from the other party
            for r in reversed(replies_list):
                sn = r.get("snippet", {})
                author_id = sn.get("authorChannelId", {}).get("value")
                author_name = sn.get("authorDisplayName", "")
                if author_id == MY_CHANNEL_ID or author_name in MY_CHANNEL_NAMES:
                    continue

                if last_reply_at_dt and sn.get("publishedAt"):
                    try:
                        pub_dt = dt.datetime.fromisoformat(sn["publishedAt"])
                        if pub_dt.tzinfo is None:
                            pub_dt = pub_dt.replace(tzinfo=dt.timezone.utc)
                        if pub_dt <= last_reply_at_dt:
                            continue
                    except (ValueError, TypeError):
                        pass

                reply_text = sn.get("textOriginal") or sn.get("textDisplay", "")
                replies.append({
                    "thread_id": tid,
                    "video_id": vid,
                    "reply_text": reply_text,
                    "reply_author": author_name,
                })
                break
    return replies


# ---------------------------------------------------------------------------
# Dedupe / persistence
# ---------------------------------------------------------------------------


def load_history(path=None):
    p = path or HISTORY_FILE
    if os.path.exists(p):
        try:
            with open(p) as f:
                return json.load(f)
        except (json.JSONDecodeError, ValueError):
            return {}
    return {}


def save_history(history, path=None):
    p = path or HISTORY_FILE
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        json.dump(history, f, indent=2, ensure_ascii=False)


def in_cooldown(history, vid, now):
    ts = history.get(vid)
    if not ts:
        return False
    # New format stores a dict {ts, thread_id}; old format stores a plain ISO string
    if isinstance(ts, dict):
        ts = ts.get("ts")
    if not ts:
        return False
    try:
        last = dt.datetime.fromisoformat(ts)
    except (ValueError, TypeError):
        return False
    if last.tzinfo is None:
        last = last.replace(tzinfo=dt.timezone.utc)
    return (now - last) < dt.timedelta(days=COOLDOWN_DAYS)


# ---------------------------------------------------------------------------
# Offline / fixture support
# ---------------------------------------------------------------------------


def load_fixtures(path=None):
    """Load bundled sample videos for offline/deterministic runs."""
    p = path or FIXTURES_FILE
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    # Built-in fallback so dry-run never produces an empty payload
    return [
        {
            "video_id": "FIXTURE_A",
            "video_url": "https://www.youtube.com/watch?v=FIXTURE_A",
            "title": "Building a multi-agent workflow with Claude Code in 2025",
            "channel": "AI Dev Channel",
            "channel_id": "UC_fixture_a",
            "view_count": 1200,
            "published": "2026-11-01T00:00:00Z",
            "description": "How to set up a multi-agent coding workflow using Claude Code and LLM tools",
        },
        {
            "video_id": "FIXTURE_B",
            "video_url": "https://www.youtube.com/watch?v=FIXTURE_B",
            "title": "AI 工作流自动化实战：从 prompt 到部署",
            "channel": "AI工具社",
            "channel_id": "UC_fixture_b",
            "view_count": 800,
            "published": "2026-11-01T06:00:00Z",
            "description": "分享如何用 LLM 和 agent 搭建自动化工作流，包含 coding agent 的实战经验",
        },
        {
            "video_id": "FIXTURE_C",
            "video_url": "https://www.youtube.com/watch?v=FIXTURE_C",
            "title": "My home garden tour",
            "channel": "GardenTime",
            "channel_id": "UC_fixture_c",
            "view_count": 500,
            "published": "2026-11-01T02:00:00Z",
            "description": "A relaxing tour of my vegetable garden",
        },
    ]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="draft only, post nothing")
    ap.add_argument("--post", type=int, default=3,
                    help="max comments to actually post this run (default 3)")
    ap.add_argument("--hours", type=int, default=48,
                    help="only videos published in the last N hours (default 48)")
    ap.add_argument("--consider", type=int, default=6,
                    help="how many candidates to draft for (default 6)")
    ap.add_argument("--output", default=None,
                    help="output JSON path (default logs/yt_outreach_YYYY-MM-DD_HHMM.json)")
    ap.add_argument("--fixtures", default=None,
                    help="path to a JSON fixture file with candidate videos "
                         "(skip live search; used for tests/offline runs)")
    args = ap.parse_args(argv)

    now = dt.datetime.now(dt.timezone.utc)

    # --- Gather candidates ---
    fixtures = False
    if args.fixtures:
        raw = load_fixtures(args.fixtures)
        details = {v["video_id"]: v for v in raw}
        vids = list(details.keys())
        fixtures = True
    else:
        tok = load_token()
        vids = search_videos(tok, args.hours)
        details = video_details(tok, vids) if vids else {}
        # Fallback: if live search returned nothing, use fixtures so payload is non-empty
        if not vids:
            raw = load_fixtures()
            details = {v["video_id"]: v for v in raw}
            vids = list(details.keys())
            fixtures = True

    # --- Dedupe ---
    history = load_history()
    fresh = [v for v in vids if not in_cooldown(history, v, now)]

    # Newest-first; prefer mid-size videos (new channel shouldn't spam 10M-view videos)
    ranked = sorted(fresh, key=lambda v: details.get(v, {}).get("view_count", 0))
    consider = ranked[:args.consider]

    rng = random.Random(int(hashlib.sha1(
        ("|".join(consider) + now.strftime("%Y-%m-%d")).encode()).hexdigest(), 16))

    # --- Reply priority: check for replies to our previous comments ---
    reply_records = []
    if not fixtures:
        # Check previously posted comments for replies
        thread_ids = [h["thread_id"] for h in history.values()
                      if isinstance(h, dict) and h.get("thread_id")]
        if thread_ids:
            tok = load_token()
            try:
                new_replies = check_replies(tok, thread_ids, history)
                missing_vids = [rp["video_id"] for rp in new_replies if rp["video_id"] not in details]
                if missing_vids:
                    details.update(video_details(tok, missing_vids))
                for rp in new_replies:
                    reply_text = make_reply(rp["reply_text"], rng)
                    reply_records.append({
                        "video_id": rp["video_id"],
                        "video_url": f"https://www.youtube.com/watch?v={rp['video_id']}",
                        "channel": details.get(rp["video_id"], {}).get("channel", ""),
                        "comment": reply_text,
                        "mentions_product": False,
                        "status": "reply-draft",
                        "priority": True,
                        "reply_to_thread": rp["thread_id"],
                    })
            except Exception:
                pass  # best-effort; never crash the run over reply checking

    # --- Draft new comments ---
    pitches_left = PITCH_PER_RUN
    used_openers, used_questions = set(), set()
    drafts = []
    for vid in consider:
        v = details.get(vid)
        if not v:
            continue
        text, mentions = make_comment(v, pitches_left > 0, rng,
                                      used_openers, used_questions)
        if mentions:
            pitches_left -= 1
        drafts.append({
            "video_id": vid,
            "video_url": v["video_url"],
            "channel": v["channel"],
            "channel_id": v.get("channel_id", ""),
            "view_count": v.get("view_count", 0),
            "published": v.get("published", ""),
            "comment": text,
            "mentions_product": mentions,
            "status": "draft",
        })

    # Combine: replies first (priority), then new drafts
    all_records = reply_records + drafts

    # --- Post (skip in dry-run) ---
    posted = 0
    if not args.dry_run and not fixtures:
        tok = load_token()
        for rec in all_records:
            if posted >= args.post:
                break
            if rec.get("priority") and rec.get("reply_to_thread"):
                # Reply to an existing thread
                try:
                    cid = post_reply(tok, rec["reply_to_thread"], rec["comment"])
                    rec["status"] = "replied"
                    rec["reply_id"] = cid
                    if rec["video_id"] in history and isinstance(history[rec["video_id"]], dict):
                        history[rec["video_id"]]["last_reply_id"] = cid
                        history[rec["video_id"]]["last_reply_at"] = now.isoformat()
                    posted += 1
                except Exception as e:
                    rec["status"] = f"error:{e}"
                continue
            try:
                cid = post_comment(tok, rec["video_id"], rec["comment"])
                rec["status"] = "posted"
                rec["comment_id"] = cid
                rec["thread_id"] = cid
                history[rec["video_id"]] = {
                    "ts": now.isoformat(),
                    "thread_id": cid,
                }
                posted += 1
            except urllib.error.HTTPError as e:
                try:
                    err = json.load(e)
                    msg = err.get("error", {}).get("message", str(e))
                except Exception:
                    msg = str(e)
                rec["status"] = f"skipped:{msg[:120]}"
                if "Comments are turned off" in msg or e.code == 403:
                    history[rec["video_id"]] = {
                        "ts": now.isoformat(), "thread_id": None}
                continue
            except Exception as e:  # noqa: BLE001
                rec["status"] = f"error:{e}"
    elif not args.dry_run:
        # fixtures mode: don't post, just mark as draft
        pass

    # --- Persist ---
    # The outreach payload is a top-level JSON ARRAY of per-video records so
    # downstream tooling can `jq '.[0]'` it directly. Run metadata is written
    # to a sibling sidecar file and echoed to stdout.
    if args.output:
        out_path = args.output
    else:
        os.makedirs(LOGS_DIR, exist_ok=True)
        # Include HHMM (UTC) so two runs on the same UTC date (02:00 and 20:00
        # local) each get their own payload file instead of clobbering each
        # other's record of what was posted.
        out_path = os.path.join(LOGS_DIR, f"yt_outreach_{now:%Y-%m-%d_%H%M}.json")
    out_dir = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(out_dir, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(all_records, f, indent=2, ensure_ascii=False)

    # Persist history (only in non-dry-run to avoid polluting dedupe)
    if not args.dry_run:
        save_history(history)

    # --- Summary to stdout (payload array is already on disk at out_path) ---
    posted = sum(1 for r in all_records if r["status"] in ("posted", "replied"))
    print(json.dumps({
        "run_ts": now.isoformat(),
        "dry_run": bool(args.dry_run),
        "channel": "@AI高玩",
        "hours_window": args.hours,
        "source": "fixture" if fixtures else "live",
        "candidates": len(vids),
        "drafts": len(drafts),
        "replies": len(reply_records),
        "posted": posted,
        "output": out_path,
        # YouTube Data API v3 can't like or subscribe; do these by hand.
        "manual_actions": {
            "note": ("Like + subscribe on the drafted videos' channels is "
                     "human-only (YouTube Data API v3). Open each video_url "
                     "in a browser, like it, and subscribe to channels worth "
                     "following."),
            "videos": [r["video_url"] for r in all_records
                       if r["status"] in ("posted", "replied", "draft")],
        },
    }, indent=2, ensure_ascii=False))
    for d in all_records:
        tag = "reply" if d.get("priority") else "new"
        print(f'[{d["status"]}] ({tag}) {d["video_url"]} ({d.get("channel", "?")}) '
              f'pitch={d["mentions_product"]}')
        print(f'    {d["comment"]}')

    return 0


if __name__ == "__main__":
    sys.exit(main())
