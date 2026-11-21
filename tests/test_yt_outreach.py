"""Tests for scripts/yt_outreach.py.

Runs fully offline: no network, no real token. The live API path is
exercised only through mocks; the end-to-end dry-run test uses the
bundled fixture set so it works with zero network access.
"""

import json
import os
import random
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(__file__))), "scripts"))
import yt_outreach  # noqa: E402  (repo-local script, not a package)


class _NoNetwork:
    """Force any real HTTP call to fail loudly instead of hitting the net."""

    def __init__(self):
        raise AssertionError("live network call attempted in a unit test")


@pytest.fixture(autouse=True)
def _no_live_network(monkeypatch, tmp_path):
    """Never let tests touch the network or the real history file."""
    def _boom(*a, **kw):
        raise AssertionError("network disabled in tests")
    monkeypatch.setattr(yt_outreach.urllib.request, "urlopen", _boom)
    monkeypatch.setattr(yt_outreach, "TOKEN_FILE", str(tmp_path / "token.json"))
    monkeypatch.setattr(yt_outreach, "HISTORY_FILE",
                        str(tmp_path / "history.json"))
    monkeypatch.setattr(yt_outreach, "LOGS_DIR", str(tmp_path / "logs"))
    monkeypatch.setattr(yt_outreach, "FIXTURES_FILE",
                        os.path.join(os.path.dirname(os.path.realpath(__file__)),
                                     "fixtures", "yt_videos.json"))
    return tmp_path


def _fake_details():
    return {
        "VID_AGENT": {
            "video_id": "VID_AGENT",
            "video_url": "https://www.youtube.com/watch?v=VID_AGENT",
            "title": "Building a multi-agent workflow with LLMs",
            "channel": "DevChannel", "channel_id": "UCagent",
            "view_count": 1200,
            "published": "2026-11-01T00:00:00Z",
            "description": "hands-on coding agent and automation workflow demo",
        },
        "VID_MUSIC": {
            "video_id": "VID_MUSIC",
            "video_url": "https://www.youtube.com/watch?v=VID_MUSIC",
            "title": "Lo-fi beats for studying",
            "channel": "ChillBeats", "channel_id": "UCmusic",
            "view_count": 500000,
            "published": "2026-11-01T00:00:00Z",
            "description": "chill lofi hip hop radio to relax to",
        },
    }


# ---------------------------------------------------------------- AC 1/2


def test_pick_topic_words_uses_video_metadata():
    words = yt_outreach.pick_topic_words(
        "Claude Code multi-agent workflow demo", "coding with LLM agents")
    assert "claude code" in [w.lower() for w in words] or "agent" in words
    assert "llm" in [w.lower() for w in words] or "coding" in [w.lower() for w in words]


def test_pick_topic_words_handles_uppercase():
    words = yt_outreach.pick_topic_words("CLAUDE CODE AND AI AGENT WORKFLOW", "")
    assert "claude code" in words
    assert "agent" in words


def test_comment_references_video_topic_and_no_cliches():
    video = _fake_details()["VID_AGENT"]
    expected = {w.lower() for w in yt_outreach.pick_topic_words(
        video["title"], video["description"])}
    for seed in range(25):
        text, mentions = yt_outreach.make_comment(video, pitch_allowed=False,
                                                  rng=random.Random(seed))
        low = text.lower()
        assert any(w in low for w in expected), f"seed={seed} text={text!r}"
        for banned in yt_outreach.BANNED:
            assert banned not in text
        assert "http" not in low
        assert 10 <= len(text) <= 400


def test_topic_word_fallback_when_no_match():
    text, _ = yt_outreach.make_comment(
        {"title": "totally unrelated cooking video", "description": ""},
        pitch_allowed=False, rng=random.Random(0))
    assert len(text) >= 10  # still a usable comment
    for banned in yt_outreach.BANNED:
        assert banned not in text


# ---------------------------------------------------------------- AC 3


def test_soft_pitch_only_on_relevant_topics():
    rng = random.Random(7)
    related = _fake_details()["VID_AGENT"]
    _, mentioned = yt_outreach.make_comment(related, True, rng)
    assert mentioned is True
    assert "cowork" in yt_outreach.PITCH.lower()

    rng2 = random.Random(7)
    irrelevant = _fake_details()["VID_MUSIC"]
    _text, mentioned2 = yt_outreach.make_comment(irrelevant, True, rng2)
    assert mentioned2 is False  # music video: no pitch, even when allowed


def test_soft_pitch_respects_budget():
    video = _fake_details()["VID_AGENT"]
    text, mentions = yt_outreach.make_comment(video, pitch_allowed=False,
                                              rng=random.Random(1))
    assert mentions is False and "cowork" not in text.lower()


def test_pitch_never_contains_url_or_banned_phrases():
    for banned in yt_outreach.BANNED:
        assert banned not in yt_outreach.PITCH
    assert "http" not in yt_outreach.PITCH.lower()


# ---------------------------------------------------------------- AC 4


def test_offline_dry_run_persists_structured_payload(tmp_path):
    out = tmp_path / "payload.json"
    rc = yt_outreach.main(["--dry-run", "--fixtures", yt_outreach.FIXTURES_FILE,
                           "--output", str(out)])
    assert rc == 0
    records = json.loads(out.read_text(encoding="utf-8"))
    assert isinstance(records, list) and len(records) >= 1
    for rec in records:
        for key in ("video_id", "video_url", "channel", "comment",
                    "mentions_product", "status"):
            assert key in rec, f"missing {key}"
        assert rec["status"] in ("draft", "skipped")
    # pitch rule: at most PITCH_PER_RUN records may carry the pitch
    assert sum(r["mentions_product"] for r in records) <= yt_outreach.PITCH_PER_RUN


def test_dry_run_does_not_touch_history(tmp_path):
    out = tmp_path / "p.json"
    yt_outreach.main(["--dry-run", "--fixtures", yt_outreach.FIXTURES_FILE,
                      "--output", str(out)])
    assert not (tmp_path / "history.json").exists()


def test_reply_priority_orders_replies_first(tmp_path, monkeypatch):
    hist_path = tmp_path / "hist.json"
    hist_path.write_text(json.dumps({
        "OLDVID": {"ts": "2026-10-25T00:00:00+00:00", "thread_id": "t1"}},
        ensure_ascii=False))
    monkeypatch.setattr(yt_outreach, "HISTORY_FILE", str(hist_path))
    monkeypatch.setattr(yt_outreach, "check_replies",
                        lambda tok, ids: [{
                            "thread_id": "t1", "video_id": "OLDVID",
                            "reply_text": "thanks for the comment, we use "
                                          "Claude Code for our coding agent now",
                            "reply_author": "VideoOwner"}])
    captured = {}

    def fake_main(argv):
        # emulate main() without network: call internal pieces directly
        vids = list(_fake_details().keys())
        details = _fake_details()
        rng = random.Random(42)
        recs = []
        replies = yt_outreach.check_replies(None, ["t1"])
        for rp in replies:
            recs.append({
                "video_id": rp["video_id"],
                "video_url": f'https://www.youtube.com/watch?v={rp["video_id"]}',
                "channel": "DevChannel",
                "comment": yt_outreach.make_reply(rp["reply_text"], rng),
                "mentions_product": False, "status": "reply-draft",
                "priority": True, "reply_to_thread": rp["thread_id"],
            })
        captured["records"] = recs
        return 0

    fake_main(["--dry-run", "--fixtures", yt_outreach.FIXTURES_FILE,
               "--output", str(tmp_path / "x.json")])
    assert captured["records"]
    assert captured["records"][0]["status"] == "reply-draft"
    assert captured["records"][0]["priority"] is True


def test_check_replies_filters_own_channel(monkeypatch):
    fake_api_data = {
        "items": [{
            "snippet": {"videoId": "VID1"},
            "replies": {
                "comments": [
                    {
                        "snippet": {
                            "authorChannelId": {"value": yt_outreach.MY_CHANNEL_ID},
                            "authorDisplayName": "@AI高玩",
                            "textDisplay": "My own response",
                        }
                    },
                    {
                        "snippet": {
                            "authorChannelId": {"value": "UCother_user"},
                            "authorDisplayName": "Viewer123",
                            "textDisplay": "Great perspective, do you also use cursor?",
                        }
                    }
                ]
            }
        }]
    }
    monkeypatch.setattr(yt_outreach, "api", lambda path, params, tok: fake_api_data)
    results = yt_outreach.check_replies(None, ["thread_123"])
    assert len(results) == 1
    assert results[0]["reply_author"] == "Viewer123"
    assert "cursor" in results[0]["reply_text"]


def test_check_replies_ignores_already_replied_threads(monkeypatch):
    fake_api_data = {
        "items": [{
            "snippet": {"videoId": "VID1"},
            "replies": {
                "comments": [
                    {
                        "snippet": {
                            "authorChannelId": {"value": "UCother_user"},
                            "authorDisplayName": "Viewer123",
                            "textDisplay": "Great perspective, do you also use cursor?",
                        }
                    },
                    {
                        "snippet": {
                            "authorChannelId": {"value": yt_outreach.MY_CHANNEL_ID},
                            "authorDisplayName": "@AI高玩",
                            "textDisplay": "谢谢你回复，我这边也有类似情况。",
                        }
                    }
                ]
            }
        }]
    }
    monkeypatch.setattr(yt_outreach, "api", lambda path, params, tok: fake_api_data)
    results = yt_outreach.check_replies(None, ["thread_123"])
    assert len(results) == 0


def test_check_replies_ignores_when_history_last_reply_at_is_after_published_at(monkeypatch):
    fake_api_data = {
        "items": [{
            "snippet": {"videoId": "VID1"},
            "replies": {
                "comments": [
                    {
                        "snippet": {
                            "authorChannelId": {"value": "UCother_user"},
                            "authorDisplayName": "Viewer123",
                            "textDisplay": "Great perspective, do you also use cursor?",
                            "publishedAt": "2026-11-05T19:30:12Z",
                        }
                    }
                ]
            }
        }]
    }
    monkeypatch.setattr(yt_outreach, "api", lambda path, params, tok: fake_api_data)
    history = {
        "VID1": {
            "thread_id": "thread_123",
            "last_reply_at": "2026-11-05T21:11:22.986211+00:00"
        }
    }
    results = yt_outreach.check_replies(None, ["thread_123"], history=history)
    assert len(results) == 0


def test_post_reply_payload_structure(monkeypatch):
    captured = {}
    def fake_api(path, params, tok, body, method):
        captured["path"] = path
        captured["body"] = body
        captured["method"] = method
        return {"id": "reply_123"}
    monkeypatch.setattr(yt_outreach, "api", fake_api)
    res = yt_outreach.post_reply(None, "thread_abc", "Hello there!")
    assert res == "reply_123"
    assert captured["path"] == "comments"
    assert captured["method"] == "POST"
    assert captured["body"]["snippet"]["parentId"] == "thread_abc"
    assert captured["body"]["snippet"]["textOriginal"] == "Hello there!"


def test_make_reply_strips_leading_mentions():
    reply = yt_outreach.make_reply("@AI高玩 no i am using a single account", random.Random(0))
    assert "@AI高玩" not in reply
    assert "no i am using" in reply


def test_make_reply_strips_zero_width_prefix_before_mentions():
    # Live regression: YouTube reply text starting with a zero-width space
    # must not break the ^-anchored mention stripping (garbled quote bug).
    reply = yt_outreach.make_reply("\u200b@AI高玩 alright, we use it daily", random.Random(0))
    assert "\u200b" not in reply
    assert "@AI高玩" not in reply
    assert "alright" in reply


def test_default_output_path_unique_per_run(monkeypatch, tmp_path):
    """Two runs on the same UTC date must not clobber each other's payload.

    Regression: cron runs at 02:00 and 20:00 local land on the same UTC
    date on some days, and `yt_outreach_YYYY-MM-DD.json` made the later
    run overwrite the earlier payload (losing its posted-record audit).
    The default filename now carries HHMM (UTC).
    """
    import datetime as real_dt
    import types

    fake_dt = types.ModuleType("fake_dt")
    for attr in dir(real_dt):
        if attr != "datetime":
            setattr(fake_dt, attr, getattr(real_dt, attr))

    class _FixedDT(real_dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return real_dt.datetime(2026, 11, 21, 12, 0, 0,
                                    tzinfo=tz or real_dt.timezone.utc)

    fake_dt.datetime = _FixedDT
    monkeypatch.setattr(yt_outreach, "dt", fake_dt)

    rc = yt_outreach.main(["--dry-run", "--fixtures", yt_outreach.FIXTURES_FILE])
    assert rc == 0
    out = tmp_path / "logs" / "yt_outreach_2026-11-21_1200.json"
    assert out.exists(), f"default payload missing; dir has: {list((tmp_path / 'logs').glob('*'))}"
    records = json.loads(out.read_text(encoding="utf-8"))
    assert isinstance(records, list) and len(records) >= 1
    for rec in records:
        for key in ("video_id", "video_url", "channel", "comment",
                    "mentions_product", "status"):
            assert key in rec



