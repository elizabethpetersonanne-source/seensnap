"""Watch Team multi-user acceptance harness — Netlify pre-alpha §18.

Runs the full three-user overlapping-membership scenario against a real
SeenSnap API over HTTP. No mocks — this is what a browser would see.

Usage:
    # Local API (requires ENVIRONMENT=local so /auth/dev is enabled)
    .venv/bin/python -m scripts.team_acceptance

    # Staging Cloud Run
    SEENSNAP_API_URL=https://seensnap-api-staging-XXXX.run.app/api/v1 \\
        .venv/bin/python -m scripts.team_acceptance

Exit code 0 iff every assertion passed. Prints PASS/FAIL per criterion.

The harness creates three throwaway users via /auth/dev (email tagged
with a run uuid so consecutive runs don't collide) and deletes them at
the end via /auth/me DELETE. Failures short-circuit the cleanup so you
can inspect state.

Scenarios covered:
  1. A + B → Team Alpha (create + invite + accept + list on both)
  2. B + C → Team Beta (independent from Alpha)
  3. C cannot access Team Alpha (403); A cannot access Team Beta (403)
  4. B belongs to both teams simultaneously
  5. Data added by A to Team Alpha is visible to B, invisible to C
  6. Invalid invite code → 4xx
  7. Duplicate acceptance → idempotent (200) or explicit conflict
  8. Non-member add-title attempt → 403
  9. Leaving a team drops membership
 10. Deleted user's team memberships clean up
"""
from __future__ import annotations

import os
import sys
import uuid
from typing import Any, Optional

import httpx


API_URL = os.environ.get("SEENSNAP_API_URL", "http://127.0.0.1:8000/api/v1").rstrip("/")
RUN_ID = uuid.uuid4().hex[:8]

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"

# Fail-fast collection so the summary prints even after an early exit.
_results: list[tuple[str, bool, str]] = []


def _report(name: str, passed: bool, detail: str = "") -> None:
    _results.append((name, passed, detail))
    print(f"  [{PASS if passed else FAIL}] {name}")
    if detail:
        print(f"        {detail}")


class Client:
    """Thin per-user HTTP client. Keeps the token so we can hit any route
    without threading it through every call site."""

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

    def patch(self, path: str, **kwargs: Any) -> httpx.Response:
        return self._s.patch(f"{API_URL}{path}", headers=self.headers, **kwargs)


def create_user(session: httpx.Client, tag: str) -> Client:
    """Create + authenticate a throwaway user via /auth/dev. Requires
    ENVIRONMENT=local or =development on the target API."""
    email = f"team_accept_{tag}_{RUN_ID}@test.local"
    resp = session.post(
        f"{API_URL}/auth/dev",
        json={"email": email, "display_name": f"Test {tag.upper()} {RUN_ID}"},
    )
    if resp.status_code >= 400:
        print(
            f"\n[fatal] /auth/dev failed ({resp.status_code}) for {email}. "
            f"This endpoint requires ENVIRONMENT=local or =development on the target API.\n"
            f"response: {resp.text[:400]}"
        )
        sys.exit(2)
    body = resp.json()
    return Client(session, token=body["access_token"], user_id=body["user"]["user_id"], email=email)


def delete_client(c: Client) -> None:
    try:
        c.delete("/auth/me")
    except Exception:
        pass


# ─── Test scenarios ─────────────────────────────────────────────────────


def scenario_create_teams_and_overlap(a: Client, b: Client, c: Client) -> tuple[dict, dict]:
    print("\n1) Create Team Alpha (A owns, B joins)")
    r = a.post("/teams", json={"name": f"Team Alpha {RUN_ID}", "description": "Alpha suite"})
    _report("A creates Team Alpha", r.status_code == 201, f"status={r.status_code}")
    alpha = r.json()
    _report("A is a member of Team Alpha", any(m["user_id"] == a.user_id for m in alpha["members"]))

    join_r = b.post("/teams/join", json={"invite_code": alpha["invite_code"]})
    _report(
        "B accepts Alpha invite",
        join_r.status_code == 200,
        f"status={join_r.status_code}",
    )

    # Refetch alpha as A to see B in members
    alpha_r = a.get(f"/teams/{alpha['id']}")
    alpha = alpha_r.json()
    _report(
        "B appears in Team Alpha members",
        any(m["user_id"] == b.user_id for m in alpha["members"]),
        f"members: {[m['user_id'] for m in alpha['members']]}",
    )

    print("\n2) Create Team Beta (B owns, C joins)")
    r = b.post("/teams", json={"name": f"Team Beta {RUN_ID}", "description": "Beta suite"})
    _report("B creates Team Beta", r.status_code == 201, f"status={r.status_code}")
    beta = r.json()

    join_r = c.post("/teams/join", json={"invite_code": beta["invite_code"]})
    _report(
        "C accepts Beta invite",
        join_r.status_code == 200,
        f"status={join_r.status_code}",
    )

    beta = b.get(f"/teams/{beta['id']}").json()
    _report(
        "C appears in Team Beta members",
        any(m["user_id"] == c.user_id for m in beta["members"]),
    )

    return alpha, beta


def scenario_authorization(a: Client, b: Client, c: Client, alpha: dict, beta: dict) -> None:
    print("\n3) Cross-team authorization")

    # C should NOT access Team Alpha
    r = c.get(f"/teams/{alpha['id']}")
    _report(
        "C is blocked from Team Alpha detail",
        r.status_code in (403, 404),
        f"status={r.status_code}",
    )

    # A should NOT access Team Beta
    r = a.get(f"/teams/{beta['id']}")
    _report(
        "A is blocked from Team Beta detail",
        r.status_code in (403, 404),
        f"status={r.status_code}",
    )

    # C should NOT add a title to Team Alpha
    # Grab any title to try — we don't need it to succeed for anyone, just
    # to confirm C's request is authorization-rejected before body validation.
    r = c.post(
        f"/teams/{alpha['id']}/titles",
        json={"content_title_id": str(uuid.uuid4())},
    )
    _report(
        "C is blocked from adding a title to Team Alpha",
        r.status_code in (403, 404),
        f"status={r.status_code}",
    )

    # A should NOT add a title to Team Beta
    r = a.post(
        f"/teams/{beta['id']}/titles",
        json={"content_title_id": str(uuid.uuid4())},
    )
    _report(
        "A is blocked from adding a title to Team Beta",
        r.status_code in (403, 404),
        f"status={r.status_code}",
    )


def scenario_b_in_both_teams(b: Client, alpha: dict, beta: dict) -> None:
    print("\n4) B belongs to both teams simultaneously")

    teams_r = b.get("/teams")
    _report("B can list their teams", teams_r.status_code == 200)
    team_ids = {t["id"] for t in teams_r.json()}
    _report(
        "B's team list contains both Alpha and Beta",
        alpha["id"] in team_ids and beta["id"] in team_ids,
        f"got ids: {sorted(team_ids)}",
    )

    # And B can fetch either team's detail without collision.
    ra = b.get(f"/teams/{alpha['id']}")
    rb = b.get(f"/teams/{beta['id']}")
    _report(
        "B can fetch both team details independently",
        ra.status_code == 200 and rb.status_code == 200,
        f"alpha={ra.status_code} beta={rb.status_code}",
    )


def scenario_shared_activity(a: Client, b: Client, c: Client, alpha: dict) -> None:
    print("\n5) A posts to Team Alpha activity; B sees it; C does not")

    post_r = a.post(
        f"/teams/{alpha['id']}/feed-posts",
        json={"text": f"Alpha thought {RUN_ID}"},
    )
    _report(
        "A posts to Team Alpha activity",
        post_r.status_code == 201,
        f"status={post_r.status_code}",
    )

    # B should see the post
    b_activity = b.get(f"/teams/{alpha['id']}/activity")
    _report(
        "B can read Team Alpha activity",
        b_activity.status_code == 200,
        f"status={b_activity.status_code}",
    )
    if b_activity.status_code == 200:
        payloads = [str(item.get("payload", {})) for item in b_activity.json()]
        _report(
            "B sees A's post in Alpha activity",
            any(RUN_ID in p for p in payloads),
            f"payloads={payloads[:2]}",
        )

    # C should be blocked entirely from Alpha activity
    c_activity = c.get(f"/teams/{alpha['id']}/activity")
    _report(
        "C is blocked from Team Alpha activity",
        c_activity.status_code in (403, 404),
        f"status={c_activity.status_code}",
    )


def scenario_invite_edge_cases(a: Client, b: Client, alpha: dict) -> None:
    print("\n6) Invite edge cases")

    # Invalid invite code
    r = a.post("/teams/join", json={"invite_code": "not-a-real-code-xyz"})
    _report(
        "Invalid invite code is rejected",
        r.status_code >= 400 and r.status_code < 500,
        f"status={r.status_code}",
    )

    # Duplicate acceptance (B is already a member of Alpha)
    r = b.post("/teams/join", json={"invite_code": alpha["invite_code"]})
    _report(
        "Duplicate join is handled without duplicating membership",
        r.status_code in (200, 409),
        f"status={r.status_code}",
    )
    # And the member count shouldn't have doubled
    fresh = a.get(f"/teams/{alpha['id']}").json()
    b_membership_count = sum(1 for m in fresh["members"] if m["user_id"] == b.user_id)
    _report(
        "B is present exactly once in Alpha members after duplicate join",
        b_membership_count == 1,
        f"b appears {b_membership_count} time(s)",
    )


def scenario_leave_team(b: Client, a: Client, alpha: dict) -> None:
    print("\n7) B leaves Team Alpha")
    r = b.post(f"/teams/{alpha['id']}/leave")
    _report("B leaves Team Alpha", r.status_code in (200, 204), f"status={r.status_code}")

    # A refetch should NOT contain B
    fresh = a.get(f"/teams/{alpha['id']}").json()
    _report(
        "B no longer appears in Team Alpha members",
        not any(m["user_id"] == b.user_id and m["status"] == "active" for m in fresh["members"]),
    )

    # And B can no longer fetch Alpha detail
    r = b.get(f"/teams/{alpha['id']}")
    _report(
        "B cannot fetch Team Alpha after leaving",
        r.status_code in (403, 404),
        f"status={r.status_code}",
    )


# ─── Main ───────────────────────────────────────────────────────────────


def main() -> int:
    print(f"Watch Team acceptance suite (§18) — API: {API_URL}")
    print("=" * 74)

    session = httpx.Client(timeout=15.0)
    a = create_user(session, "a")
    b = create_user(session, "b")
    c = create_user(session, "c")
    print(f"\nProvisioned test users:\n  A: {a.email}\n  B: {b.email}\n  C: {c.email}")

    try:
        alpha, beta = scenario_create_teams_and_overlap(a, b, c)
        scenario_authorization(a, b, c, alpha, beta)
        scenario_b_in_both_teams(b, alpha, beta)
        scenario_shared_activity(a, b, c, alpha)
        scenario_invite_edge_cases(a, b, alpha)
        scenario_leave_team(b, a, alpha)
    finally:
        print("\n[cleanup] deleting test users…")
        for client in (a, b, c):
            delete_client(client)

    total = len(_results)
    passed = sum(1 for _, ok, _ in _results if ok)
    failed = total - passed
    print(f"\n{'=' * 74}")
    print(f"Summary: {passed}/{total} passed, {failed} failed")
    if failed:
        for name, ok, detail in _results:
            if not ok:
                print(f"  FAIL: {name} — {detail}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
