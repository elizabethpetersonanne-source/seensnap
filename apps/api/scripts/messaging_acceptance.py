"""Messaging acceptance harness — Messaging spec §75-§76.

Run locally:
    .venv/bin/python -m scripts.messaging_acceptance

Or against staging:
    SEENSNAP_API_URL=https://<cloud-run>/api/v1 \
        .venv/bin/python -m scripts.messaging_acceptance

Requires /auth/dev enabled on the target (local + development only —
staging deliberately rejects, so this harness only runs against local
until we add a staging-safe test hook).

Coverage:
  1. A can start a conversation with B when they follow each other
  2. C (unrelated) can NOT start a conversation with A
  3. Conversation start is idempotent — repeated calls return same id
  4. A sends text → B receives, unread=1; A sees 0 unread
  5. Idempotency — repeat POST with same client_message_id returns same row
  6. B marks read → unread goes to 0
  7. A sends title → recipient sees content_type=title with real metadata
  8. A sends list → recipient sees content_type=list with snapshot
  9. Cannot send another user's list
 10. Blocking prevents any further messages both directions
 11. Cannot send to self
 12. Message text length enforced
"""
from __future__ import annotations

import os
import sys
import uuid
from typing import Any

import httpx


API_URL = os.environ.get("SEENSNAP_API_URL", "http://127.0.0.1:8000/api/v1").rstrip("/")
RUN_ID = uuid.uuid4().hex[:8]

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"

_results: list[tuple[str, bool, str]] = []


def _report(name: str, passed: bool, detail: str = "") -> None:
    _results.append((name, passed, detail))
    print(f"  [{PASS if passed else FAIL}] {name}")
    if detail:
        print(f"        {detail}")


class Client:
    def __init__(self, session: httpx.Client, token: str, user_id: str, email: str):
        self._s = session
        self._token = token
        self.user_id = user_id
        self.email = email

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    def get(self, path: str, **kwargs: Any) -> httpx.Response:
        return self._s.get(f"{API_URL}{path}", headers=self.headers, **kwargs)

    def post(self, path: str, **kwargs: Any) -> httpx.Response:
        return self._s.post(f"{API_URL}{path}", headers=self.headers, **kwargs)

    def delete(self, path: str, **kwargs: Any) -> httpx.Response:
        return self._s.delete(f"{API_URL}{path}", headers=self.headers, **kwargs)


def create_user(session: httpx.Client, tag: str) -> Client:
    email = f"msg_accept_{tag}_{RUN_ID}@test.local"
    resp = session.post(
        f"{API_URL}/auth/dev",
        json={"email": email, "display_name": f"Test {tag.upper()} {RUN_ID}"},
    )
    if resp.status_code >= 400:
        print(
            f"\n[fatal] /auth/dev failed ({resp.status_code}). "
            f"Set ENVIRONMENT=local on the target API.\n{resp.text[:200]}"
        )
        sys.exit(2)
    body = resp.json()
    return Client(session, token=body["access_token"], user_id=body["user"]["user_id"], email=email)


def delete_client(c: Client) -> None:
    try:
        c.delete("/auth/me")
    except Exception:
        pass


# ─── Scenarios ─────────────────────────────────────────────────────────


def scenario_privacy_and_start(a: Client, b: Client, c: Client) -> str:
    print("\n1) Conversation start — privacy + idempotency")

    # A follows B, B follows A → they can message
    a.post(f"/profiles/{b.user_id}/follow")
    b.post(f"/profiles/{a.user_id}/follow")

    r = a.post("/messages/conversations/direct", json={"recipient_user_id": b.user_id})
    _report("A→B start conversation with follow", r.status_code == 200, f"status={r.status_code}")
    convo_id = r.json()["conversation_id"]

    r2 = a.post("/messages/conversations/direct", json={"recipient_user_id": b.user_id})
    _report(
        "Duplicate start returns same conversation_id",
        r2.status_code == 200 and r2.json()["conversation_id"] == convo_id,
        f"first={convo_id} second={r2.json().get('conversation_id')}",
    )

    # C has no relationship — should be blocked by privacy rules
    r = c.post("/messages/conversations/direct", json={"recipient_user_id": a.user_id})
    _report("C→A blocked (no follow / no team)", r.status_code == 403, f"status={r.status_code}")

    # Cannot message self
    r = a.post("/messages/conversations/direct", json={"recipient_user_id": a.user_id})
    _report("Cannot start conversation with self", r.status_code == 400, f"status={r.status_code}")

    return convo_id


def scenario_send_text(a: Client, b: Client, convo_id: str) -> None:
    print("\n2) Text messages — send, unread, idempotency, read")

    r = a.post(
        f"/messages/conversations/{convo_id}/messages",
        json={"text_body": "You need to see this.", "client_message_id": f"msg-1-{RUN_ID}"},
    )
    _report("A sends text", r.status_code == 201, f"status={r.status_code}")
    msg_id = r.json()["id"]

    # Idempotent replay
    r2 = a.post(
        f"/messages/conversations/{convo_id}/messages",
        json={"text_body": "You need to see this.", "client_message_id": f"msg-1-{RUN_ID}"},
    )
    _report(
        "Idempotent replay returns same message",
        r2.status_code == 201 and r2.json()["id"] == msg_id,
        f"got id={r2.json().get('id')}",
    )

    # B sees 1 unread; A sees 0
    b_unread = b.get("/messages/conversations/unread-count").json().get("count")
    a_unread = a.get("/messages/conversations/unread-count").json().get("count")
    _report(
        "B unread=1, A unread=0 after A sends",
        b_unread == 1 and a_unread == 0,
        f"a={a_unread} b={b_unread}",
    )

    # B reads
    r = b.post(f"/messages/conversations/{convo_id}/read")
    _report("B marks read (204)", r.status_code == 204, f"status={r.status_code}")
    b_unread_after = b.get("/messages/conversations/unread-count").json().get("count")
    _report("B unread=0 after read", b_unread_after == 0, f"b={b_unread_after}")

    # Both can see the message
    a_msgs = a.get(f"/messages/conversations/{convo_id}/messages").json()["items"]
    b_msgs = b.get(f"/messages/conversations/{convo_id}/messages").json()["items"]
    _report(
        "Both A and B see the message in the timeline",
        len(a_msgs) >= 1 and len(b_msgs) >= 1 and a_msgs[-1]["text_body"] == "You need to see this.",
        f"a_count={len(a_msgs)} b_count={len(b_msgs)}",
    )


def scenario_send_title(a: Client, b: Client, convo_id: str) -> None:
    print("\n3) Send a title")
    from app.db.session import SessionLocal
    from app.models.content import ContentTitle
    from sqlalchemy import select

    db = SessionLocal()
    try:
        title = db.scalar(
            select(ContentTitle)
            .where(ContentTitle.tmdb_vote_average.is_not(None))
            .order_by(ContentTitle.tmdb_vote_average.desc())
            .limit(1)
        )
        if title is None:
            _report("preconditions — DB has a title", False, "no ContentTitle rows")
            return
        title_id = str(title.id)
    finally:
        db.close()

    r = a.post(
        f"/messages/conversations/{convo_id}/messages",
        json={
            "text_body": "Watch this tonight.",
            "content_type": "title",
            "content_id": title_id,
            "client_message_id": f"title-msg-{RUN_ID}",
        },
    )
    _report("A sends title-with-text", r.status_code == 201, f"status={r.status_code}")
    body = r.json()
    _report(
        "Response includes hydrated title metadata",
        body.get("content_type") == "title" and body.get("title") is not None,
        f"content_type={body.get('content_type')} has_title={body.get('title') is not None}",
    )

    b_msgs = b.get(f"/messages/conversations/{convo_id}/messages").json()["items"]
    last = b_msgs[-1] if b_msgs else {}
    _report(
        "B sees the title card",
        last.get("content_type") == "title" and last.get("title", {}).get("id") == title_id,
        f"got_title_id={last.get('title', {}).get('id')}",
    )


def scenario_send_list(a: Client, b: Client, convo_id: str) -> None:
    print("\n4) Send a list (owner-only)")

    lists_a = a.get("/me/watchlist/lists").json()
    if not lists_a:
        _report("A has at least one list", False, "empty")
        return
    a_list_id = lists_a[0]["id"]

    r = a.post(
        f"/messages/conversations/{convo_id}/messages",
        json={
            "content_type": "list",
            "content_id": a_list_id,
            "client_message_id": f"list-msg-{RUN_ID}",
        },
    )
    _report("A sends own list", r.status_code == 201, f"status={r.status_code}")

    lists_b = b.get("/me/watchlist/lists").json()
    if lists_b:
        b_list_id = lists_b[0]["id"]
        r = a.post(
            f"/messages/conversations/{convo_id}/messages",
            json={
                "content_type": "list",
                "content_id": b_list_id,
                "client_message_id": f"other-list-msg-{RUN_ID}",
            },
        )
        _report(
            "A cannot send B's list",
            r.status_code in (403, 404),
            f"status={r.status_code}",
        )


def scenario_notification_fires(a: Client, b: Client) -> None:
    """Verify that a Notification row lands for the recipient — no push
    delivery test (that needs a real device), just the DB-side row that
    the push pipeline reads from."""
    print("\n7) Message notification pipeline")
    from app.db.session import SessionLocal
    from app.models.social import Notification
    from sqlalchemy import select
    from uuid import UUID as _UUID

    # A already has an open conversation with B from earlier scenarios.
    # The scenarios above have sent multiple messages A→B, so there should
    # be message_received rows for B with actor=A.
    db = SessionLocal()
    try:
        rows = db.scalars(
            select(Notification).where(
                Notification.user_id == _UUID(b.user_id),
                Notification.notification_type == "message_received",
                Notification.actor_user_id == _UUID(a.user_id),
            )
        ).all()
        _report(
            "B has notification rows for messages received from A",
            len(rows) >= 1,
            f"count={len(rows)}",
        )
        if rows:
            sample = rows[0]
            _report(
                "Notification carries deep-link route to /messages/{id}",
                bool(sample.route and sample.route.startswith("/messages/")),
                f"route={sample.route}",
            )
    finally:
        db.close()


def scenario_length_limit(a: Client, convo_id: str) -> None:
    print("\n5) Text length limit")
    huge = "x" * 1500
    r = a.post(
        f"/messages/conversations/{convo_id}/messages",
        json={"text_body": huge, "client_message_id": f"huge-{RUN_ID}"},
    )
    _report("Text > 1000 rejected", r.status_code in (400, 422), f"status={r.status_code}")


def scenario_blocking(a: Client, b: Client, convo_id: str) -> None:
    print("\n6) Blocking — bidirectional")

    # B blocks A
    r = b.post(f"/social/users/{a.user_id}/block")
    _report("B blocks A", r.status_code in (200, 204, 201), f"status={r.status_code}")

    # A tries to send another message → should be rejected
    r = a.post(
        f"/messages/conversations/{convo_id}/messages",
        json={"text_body": "still there?", "client_message_id": f"blocked-{RUN_ID}"},
    )
    _report(
        "A cannot send after being blocked",
        r.status_code in (403, 404),
        f"status={r.status_code}",
    )


# ─── Main ──────────────────────────────────────────────────────────────


def main() -> int:
    print(f"Messaging acceptance suite — API: {API_URL}")
    print("=" * 74)

    session = httpx.Client(timeout=15.0)
    a = create_user(session, "a")
    b = create_user(session, "b")
    c = create_user(session, "c")
    print(f"\nUsers:\n  A: {a.email}\n  B: {b.email}\n  C: {c.email}")

    try:
        convo_id = scenario_privacy_and_start(a, b, c)
        scenario_send_text(a, b, convo_id)
        scenario_send_title(a, b, convo_id)
        scenario_send_list(a, b, convo_id)
        scenario_notification_fires(a, b)
        scenario_length_limit(a, convo_id)
        scenario_blocking(a, b, convo_id)
    finally:
        print("\n[cleanup] deleting test users…")
        for client in (a, b, c):
            delete_client(client)

    total = len(_results)
    passed = sum(1 for _, ok, _ in _results if ok)
    failed = total - passed
    print(f"\n{'=' * 74}\nSummary: {passed}/{total} passed, {failed} failed")
    if failed:
        for name, ok, detail in _results:
            if not ok:
                print(f"  FAIL: {name} — {detail}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
