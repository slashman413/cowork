#!/usr/bin/env python3
"""
yt_outreach.py — daily YouTube warm-up runner for channel @AI高玩.

Part of the scheduled task "YouTube @AI高玩 頻道冷啟動與暖身"
(recurring task 72be8541-7e24-47d0-b7a9-6238e90c5bce, daily at 20:00).

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
  5. Posts the top N drafts via commentThreads.insert (skipped in
     --dry-run) and persists a structured outreach payload to
     logs/yt_outreach_YYYY-MM-DD.json.

YouTube Data API v3 cannot like videos or subscribe to channels (ratings
removed in 2020; channels.subscribe never existed in v3) — those stay
human-only and are listed under manual_actions in the daily log.

Stdlib only. OAuth token lives at ~/.priv/ai_gaowan_youtube_token.json.
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://www.googleapis.com/youtube/v3"
TOKEN_FILE = os.path.expanduser("~/.priv/ai_gaowan_youtube_token.json")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HISTORY_FILE = os.path.join(REPO, "logs", "yt_outreach_history.json")
LOGS_DIR = os.path.join(REPO, "logs")
COOLDOWN_DAYS = 7
PITCH_PER_RUN = 1

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

# Topics that make a cowork-pro soft-pitch organically relevant
# (workflow / multi-agent / automation pain points).
PITCH_TRIGGERS = [
    "agent", "multi-agent", "多智能体", "多agent", "orchestrat",
    "workflow", "工作流", "automation", "自动化", "coding", "编程",
    "claude", "cursor", "copilot", "llm", "gpt", 
    "prompt", "提示词", "tool", "工具", "task", "任务",
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
#   * length ~30-90 Chinese characters, one sentence family.
# ---------------------------------------------------------------------------

OPENERS = [
    "刚刷到你这条讲「{kw}」的，",
    "这条来得挺及时，",
    "第一次见有人把「{kw}」拆得这么细，",
    "之前一直关注「{kw}」这块，",
    "正好在研究「{kw}」相关的内容，",
    "看完你这段，",
]

QUESTIONS = [
    "你们实际用的时候最卡在哪一步？",
    "有没有踩过权限或者成本失控的坑？",
    "这套东西在团队里推得动吗，还是主要个人在用？",
    "后续有打算往{kw2}方向延伸吗？",
    "方便的话求个踩坑小结，",
    "有配套的资料或 demo 可以看看吗？",
    "你们更看重哪个环节？{kw} 的稳定性还是迭代速度？",
]

# Natural, single-mention, no-URL pitch. Inserted only when triggered.
PITCH = (" 顺带说下，我在维护一个叫 cowork 的多 agent 协作工具（cowork pro），"
         "让多个 agent 共享任务库分工，看到这个话题正好想到它，感兴趣可以搜一下。")

BANNED = ["作为一个", "希望对你有帮助", "感谢分享", "非常", "总之",
          "综上所述", "作为一个AI", "作为AI", "AI助手", "我是AI"]


def pick_topic_words(title, description):
    """Pull 1-3 concrete topic words out of the video's own metadata."""
    text = (title or "") + " " + (description or "").lower()
    found = []
    for kw in ["claude code", "cursor", "copilot", "gpt", "llm",
               "agent", "多智能体", "智能体", "工作流",
               "自动化", "提示词", "prompt", "编程", "coding", "workflow"]:
        if kw in text and kw not in found:
            found.append(kw)
    return found[:3]


def make_comment(video, pitch_allowed, rng):
    """Draft a context-specific, human-sounding comment.

    Shape: one specific observation about the video's own topic + one
    concrete question. Keyword appears at most once per comment.
    Returns (comment_text, mentions_product).
    """
    words = pick_topic_words(video.get("title", ""), video.get("description", ""))
    kw = rng.choice(words) if words else "AI agent"
    kw2 = rng.choice([w for w in words if w != kw]) if len(words) > 1 else "自动化"

    opener = rng.choice(OPENERS).format(kw=kw)
    q = rng.choice(QUESTIONS).format(kw=kw, kw2=kw2)
    text = opener + q

    mentions = False
    low = ((video.get("title") or "") + " " + (video.get("description") or "")).lower()
    triggered = any(t.lower() in low for t in PITCH_TRIGGERS)
    if triggered and pitch_allowed:
        text += PITCH
        mentions = True
    # hard check: never emit a banned AI-cliche phrase
    for b in BANNED:
        assert b not in text, f"banned phrase leaked: {b}"
    return text, mentions


# ---------------------------------------------------------------------------
# YouTube API plumbing
# ---------------------------------------------------------------------------


def load_token(path=TOKEN_FILE):
    with open(path) as f:
        return json.load(f)


def refresh_token(tok, path=TOKEN_FILE):
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
    tok["access_token"] = resp["access_token"]
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
                # stale access token: refresh once and retry, else re-raise
                try:
                    json.load(e)
                except ValueError:
                    pass
                try:
                    tok = refresh_token(tok)
                    continue
                except urllib.error.HTTPError:
                    pass  # refresh failed; fall through to re-raise below
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
            continue  # one failing keyword shouldn't kill the run
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


# ---------------------------------------------------------------------------
# Dedupe / persistence
# ---------------------------------------------------------------------------


def load_history():
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, ValueError):
            return {}
    return {}


def in_cooldown(history, vid, now):
    ts = history.get(vid)
    if not ts:
        return False
    last = dt.datetime.fromisoformat(ts)
    return (now - last) < dt.timedelta(days=COOLDOWN_DAYS)


def main():
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
                    help="output JSON path (default logs/yt_outreach_YYYY-MM-DD.json)")
    args = ap.parse_args()

    now = dt.datetime.now(dt.timezone.utc)
    tok = load_token()

    vids = search_videos(tok, args.hours)
    details = video_details(tok, vids)

    history = load_history()
    fresh = [v for v in vids if not in_cooldown(history, v, now)]

    # Newest-first is the search order; among those, prefer mid-size videos
    # (commenting on 10M-view videos from a new channel is spam-class).
    ranked = sorted(fresh, key=lambda v: (details.get(v, {}).get("view_count", 0)))
    consider = ranked[:args.consider]

    rng = random.Random(int(hashlib.sha1(
        ("|".join(consider) + now.strftime("%Y-%m-%d")).encode()).hexdigest(), 16))

    pitches_left = PITCH_PER_RUN
    drafts = []
    for vid in consider:
        v = details.get(vid)
        if not v:
            continue
        text, mentions = make_comment(v, pitches_left > 0, rng)
        if mentions:
            pitches_left -= 1
        drafts.append({
            "video_id": vid,
            "video_url": v["video_url"],
            "channel": v["channel"],
            "channel_id": v["channel_id"],
            "view_count": v["view_count"],
            "published": v["published"],
            "comment": text,
            "mentions_product": mentions,
            "status": "draft",
        })

    if not args.dry_run:
        posted = 0
        for d in drafts:
            if posted >= args.post:
                break
            try:
                cid = post_comment(tok, d["video_id"], d["comment"])
                d["status"] = "posted"
                d["comment_id"] = cid
                history[d["video_id"]] = now.isoformat()
                posted += 1
            except urllib.error.HTTPError as e:
                err = json.load(e)
                msg = err.get("error", {}).get("message", str(e))
                d["status"] = f"skipped:{msg[:120]}"
                if "Comments are turned off" in msg or e.code == 403:
                    history[d["video_id"]] = now.isoformat()  # don't retry
                continue
            except Exception as e:  # noqa: BLE001
                d["status"] = f"error:{e}"

    # persist daily log + history
    os.makedirs(LOGS_DIR, exist_ok=True)
    out_path = args.output or os.path.join(
        LOGS_DIR, f"yt_outreach_{now:%Y-%m-%d}.json")
    payload = {
        "run_ts": now.isoformat(),
        "dry_run": bool(args.dry_run),
        "channel": "@AI高玩",
        "hours_window": args.hours,
        "candidates_found": len(vids),
        "drafts": drafts,
        "posted": sum(1 for d in drafts if d["status"] == "posted"),
        "manual_actions": {
            # Data API v3: ratings (likes) removed 2020, no subscribe endpoint.
            "note": ("Like + subscribe on the drafted videos' channels is "
                     "human-only (YouTube Data API v3). Checklist: open each "
                     "video_url in a browser and click like; subscribe to "
                     "channels worth following."),
            "videos": [d["video_url"] for d in drafts
                       if d["status"] in ("posted", "draft")],
        },
    }
    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    with open(HISTORY_FILE, "w") as f:
        json.dump(history, f, indent=2, ensure_ascii=False)

    print(json.dumps({
        "candidates": len(vids),
        "drafts": len(drafts),
        "posted": payload["posted"],
        "output": out_path,
    }, indent=2))
    for d in drafts:
        print(f'[{d["status"]}] {d["video_url"]} ({d["channel"]}) '
              f'pitch={d["mentions_product"]}')
        print(f'    {d["comment"]}')


if __name__ == "__main__":
    main()
