#!/usr/bin/env python3
"""
yt_outreach_kwc1933.py — 8-hourly YouTube cold-start/warm-up runner for channel @kwc1933 (KWC News).

Part of the scheduled task "YouTube 新頻道冷啟動與暖身 @kwc1933"
(recipe rcp-268d52fc, every 8 hours).

Channel niche: global trending news, breaking events, viral internet culture and
curated Reddit stories, plus the two daily series "全球大事件晨報" (morning news)
and "Reddit 金融快報" (finance express shorts).

Each run:
  1. Searches YouTube for finance/news videos published in the last N hours
     matching the channel's niche (newest first).
  2. Skips videos already touched within the last 7 days (dedupe via
     logs/yt_outreach_kwc1933_history.json).
  3. If any previously-posted comment (recorded in the history file) has received
     a reply, drafts a warm reply and posts it FIRST (priority interactions).
  4. Drafts a short, specific, human-sounding Traditional-Chinese comment per
     candidate. Comments reference the video's own topic; AI-ish clichés are
     banned and emoji are stripped (safety net).
  5. Soft-promotes the owner's digital products (LINE stickers / KDP ebooks /
     Gumroad / blog) via a no-URL single-mention pitch, at most once per run,
     and only when the video topic actually matches a trigger.
  6. Posts the top N records via commentThreads.insert / comments.insert and
     persists a structured outreach payload (JSON array) to
     logs/yt_outreach_kwc1933_YYYY-MM-DD_HHMM.json (UTC).

YouTube Data API v3 cannot like videos or subscribe to channels — those stay
human-only and are listed under manual_actions in stdout.

Stdlib only. OAuth token lives at ~/.priv/kwc1933_youtube_token.json.
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
TOKEN_FILE = os.path.expanduser("~/.priv/kwc1933_youtube_token.json")
REPO = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
HISTORY_FILE = os.path.join(REPO, "logs", "yt_outreach_kwc1933_history.json")
LOGS_DIR = os.path.join(REPO, "logs")
COOLDOWN_DAYS = 7
PITCH_PER_RUN = 1
MY_CHANNEL_ID = "UCguodm0SnQDkHwWRp_cgxYw"
MY_CHANNEL_NAMES = {"KWC News", "@kwc1933", "kwc1933"}

# Niche of @kwc1933 (KWC News): global news, finance, Reddit-driven stories.
# Bilingual seed keywords: Chinese covers the local creator ecosystem the
# channel publishes in; English catches the WSB/Reddit finance space.
SEARCH_KEYWORDS = [
    "美股",
    "台股",
    "港股",
    "A股",
    "財報",
    "個人理財",
    "wallstreetbets",
    "Fed 利率",
]

# Topics that make a digital-product soft-pitch organically relevant.
# A pitch is appended ONLY when the video topic matches one of these triggers.
# Broad single tokens ("market", "news" alone) are deliberately not triggers.
PITCH_TRIGGERS = [
    "投資", "理財", "財報", "股票", "美股", "台股", "港股", "A股",
    "ETF", "配息", "選擇權", "options", "dividend", "wallstreetbets",
    "自媒體", "內容創作", "prompt", "數位產品", "AI 工具",
]

# Natural, single-mention, no-URL pitches. A brand-new channel may not be
# allowed to post links yet, so we name the product surface instead of a URL.
PITCHES = [
    " 對了，我最近有在 LINE 貼圖市場上發一套貼圖集，也在寫一本放在 KDP 上賣的書，"
    "有空可以來逛一下，覺得實用再回來留言跟我說。",
    " 順帶一提，我的幾款數位產品（prompt 庫、課程素材）放在 Gumroad 上，"
    "部落格也寫著相關整理，有興趣可以搜尋看看。",
    " 我自己也在經營一個部落格，常把這類話題整理成筆記，"
    "另外 LINE 貼圖與 KDP 電子書也持續在更新，歡迎來翻翻。",
]

# ---------------------------------------------------------------------------
# Comment generation — the anti-AI-feel layer
#
# Rules (enforced by construction, not by vibe):
#   * every comment must reference a topic word taken from the video's own
#     title/description — no generic "great video!" openers;
#   * closers are question-leaning (people ask things; bots praise);
#   * banned: AI-ish clichés;
#   * no emoji (stripped as a safety net);
#   * length ~30-90 characters, one sentence family, warm and empathetic.
# ---------------------------------------------------------------------------

OPENERS = [
    "剛刷到你這則「{kw}」的影片，",
    "這則講「{kw}」的影片出得很應景，",
    "第一次見有人把「{kw}」拆得這麼細緻，",
    "一直關注「{kw}」這個領域，",
    "正好在研究「{kw}」相關的內容，",
    "看完你這段講「{kw}」的分析，",
]

QUESTIONS = [
    "目前的市場環境下，你的組合配置會怎麼調整？",
    "有沒有在估值或成本端踩過坑？",
    "這份財報之後，你會怎麼跟進？",
    "你認為目前市場比較適合防禦還是進攻？",
    "方便的話，能分享你的踩坑總結嗎？",
    "有沒有相關的資料或數據可以看看？",
    "你們比較重視策略的穩定性還是迭代速度？",
    "這波行情裡，你最擔心哪一種風險？",
]

REPLY_OPENERS = [
    "剛看到你有回我，",
    "看到你回覆我了，",
    "感謝你的回覆，",
]

REPLY_CLOSES = [
    "後續有新進展的話歡迎同步，正好可以一起跟進。",
    "有踩坑記錄的話歡迎發我看看，我這邊也有類似情況。",
    "回頭我出一篇對比筆記，到時候發你參考。",
]

BANNED = ["作為一個", "作為AI", "AI助手", "我是AI", "希望對你有幫助",
          "感謝分享", "非常棒", "總之", "綜上所述", "大家好",
          "首先", "其次", "最後"]

TOPIC_WORDS = [
    "財報", "财报", "美股", "台股", "港股", "A股", "ETF", "配息", "分红",
    "選擇權", "估值", "wallstreetbets", "GameStop", "投資組合", "投資",
    "投资", "理財", "理财", "股票", "股市", "利率",
    "Fed", "AI", "市場",
]

# Unicode emoji ranges (simplified — covers common ranges)
_EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\U00002700-\U000027BF"
    "\U0001F000-\U0001F0FF\U0001F900-\U0001F9FF"
    "\U00002600-\U000026FF\U00002700-\U000027BF]+"
)


def pick_topic_words(title, description):
    """Pull 1-3 concrete topic words out of the video's own metadata.

    CJK keywords match as substrings; pure-ASCII keywords (AI, Fed, ETF...)
    match on word boundaries so e.g. "ai" inside "daily"/"gain" does not
    count as the AI topic.
    """
    text = ((title or "") + " " + (description or "")).lower()
    found = []
    for kw in TOPIC_WORDS:
        if kw not in found:
            kw_l = kw.lower()
            if kw_l.isascii():
                if re.search(r"(?<![a-z0-9])" + re.escape(kw_l) + r"(?![a-z0-9])", text):
                    found.append(kw)
            elif kw_l in text:
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


def make_comment(video, rng, used_openers=None, used_questions=None,
                 pitch_allowed=True, rng_pitch=None):
    """Draft a context-specific, human-sounding comment.

    Shape: one specific observation about the video's own topic + one
    concrete question. Keyword appears at most once per comment.
    Passes sets of already-used templates to keep drafts within one run
    from sharing openers/questions (bot-tell avoidance).
    Returns (comment_text, mentions_product).
    """
    words = pick_topic_words(video.get("title", ""), video.get("description", ""))
    # Always quote the most-specific topic word that appears in the video's own
    # metadata (TOPIC_WORDS is ordered specific-first). Variety comes from the
    # opener/question pools; the keyword itself must stay accurate.
    kw = words[0] if words else "市場"

    if used_openers is not None and used_questions is not None:
        opener = _pick_unused(OPENERS, used_openers, rng).format(kw=kw)
        q = _pick_unused(QUESTIONS, used_questions, rng)
    else:
        opener = rng.choice(OPENERS).format(kw=kw)
        q = rng.choice(QUESTIONS)
    text = opener + q

    mentions = False
    low = ((video.get("title") or "") + " " + (video.get("description") or "")).lower()
    triggered = any(t.lower() in low for t in PITCH_TRIGGERS)
    if triggered and pitch_allowed:
        rng_pitch = rng_pitch or rng
        text += rng_pitch.choice(PITCHES)
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
    now = dt.datetime.now(dt.timezone.utc)
    tok["expires_at"] = int(now.timestamp()) + int(resp.get("expires_in", 3599))
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
# Main
# ---------------------------------------------------------------------------


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                   help="draft only, post nothing")
    ap.add_argument("--post", type=int, default=4,
                   help="max records to actually post this run (default 4)")
    ap.add_argument("--hours", type=int, default=48,
                   help="only videos published in the last N hours (default 48)")
    ap.add_argument("--consider", type=int, default=8,
                   help="how many candidates to draft for (default 8)")
    ap.add_argument("--output", default=None,
                   help="output JSON path (default logs/yt_outreach_kwc1933_YYYY-MM-DD_HHMM.json)")
    ap.add_argument("--skip", default="",
                   help="comma-separated video IDs to exclude from this run")
    args = ap.parse_args(argv)

    now = dt.datetime.now(dt.timezone.utc)

    # --- Gather candidates ---
    tok = load_token()
    vids = search_videos(tok, args.hours)
    skip = {s.strip() for s in args.skip.split(",") if s.strip()}
    if skip:
        vids = [v for v in vids if v not in skip]
    details = video_details(tok, vids) if vids else {}
    if not vids:
        print(json.dumps({"error": "no candidates found in live search",
                          "hours_window": args.hours}, indent=2))
        return 1

    # --- Dedupe ---
    history = load_history()
    fresh = [v for v in vids if not in_cooldown(history, v, now)]

    # Newest-first; prefer mid-size videos (new channel shouldn't spam huge channels)
    ranked = sorted(fresh, key=lambda v: details.get(v, {}).get("view_count", 0))
    consider = ranked[:args.consider]

    rng = random.Random(int(hashlib.sha1(
        ("|".join(consider) + now.strftime("%Y-%m-%d")).encode()).hexdigest(), 16))

    # --- Reply priority: check for replies to our previous comments ---
    reply_records = []
    thread_ids = [h["thread_id"] for h in history.values()
                  if isinstance(h, dict) and h.get("thread_id")]
    if thread_ids:
        try:
            new_replies = check_replies(tok, thread_ids, history)
            missing_vids = [rp["video_id"] for rp in new_replies if rp["video_id"] not in details]
            if missing_vids:
                details.update(video_details(tok, missing_vids))
            for rp in new_replies:
                if rp["video_id"] in skip:
                    continue
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
                    "replied_to_author": rp.get("reply_author", ""),
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
        text, mentions = make_comment(v, rng, used_openers, used_questions,
                                      pitch_allowed=(pitches_left > 0))
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
    if not args.dry_run:
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
                except urllib.error.HTTPError as e:
                    try:
                        err = json.load(e)
                        msg = err.get("error", {}).get("message", str(e))
                    except Exception:
                        msg = str(e)
                    rec["status"] = f"error:{msg[:120]}"
                except Exception as e:  # noqa: BLE001
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

    # --- Persist ---
    if args.output:
        out_path = args.output
    else:
        os.makedirs(LOGS_DIR, exist_ok=True)
        out_path = os.path.join(
            LOGS_DIR, f"yt_outreach_kwc1933_{now:%Y-%m-%d_%H%M}.json")
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
        "channel": "@kwc1933 (KWC News)",
        "hours_window": args.hours,
        "source": "live",
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
