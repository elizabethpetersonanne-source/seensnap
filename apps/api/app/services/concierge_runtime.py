"""Request-local time budget and privacy-safe operational evidence.

Check between stages and cap each network operation by the remaining budget.
No prompts, response bodies, credentials or personal title IDs enter logs.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
import logging
import json
import time
import httpx

logger = logging.getLogger("seensnap.concierge")
logger.setLevel(logging.INFO)
_active = ContextVar("concierge_runtime", default=None)


class ConciergeDeadlineExceeded(TimeoutError):
    pass


@dataclass
class Runtime:
    request_id: str
    seconds: float = 75
    started: float = field(default_factory=time.monotonic)
    stages: dict = field(default_factory=dict)
    counts: dict = field(default_factory=dict)

    def remaining(self):
        left = self.seconds - (time.monotonic() - self.started)
        if left <= 0:
            raise ConciergeDeadlineExceeded("concierge_deadline")
        return left


@contextmanager
def request_runtime(request_id, seconds=75):
    runtime = Runtime(str(request_id), seconds)
    token = _active.set(runtime)
    try:
        yield runtime
    finally:
        _active.reset(token)


def check_budget():
    runtime = _active.get()
    if runtime:
        runtime.remaining()


def timeout_for(seconds):
    runtime = _active.get()
    return min(seconds, runtime.remaining()) if runtime else seconds


@contextmanager
def stage(name):
    check_budget()
    started = time.monotonic()
    try:
        yield
    finally:
        runtime = _active.get()
        if runtime:
            runtime.stages[name] = runtime.stages.get(name, 0) + round((time.monotonic() - started) * 1000)


def count_retrieval(name, amount):
    if name not in {"candidate_reviewed", "metadata_failed", "constraint_rejected", "relevance_approved", "relevance_rejected", "relevance_unassessed"}:
        raise ValueError("Unknown retrieval counter")
    runtime = _active.get()
    if runtime:
        runtime.counts[name] = runtime.counts.get(name, 0) + max(0, int(amount))


def report(runtime, *, status, code, count, attempt):
    logger.info(json.dumps({"event": "concierge_request",
        "request_id": runtime.request_id, "status": status, "code": code,
        "result_count": count, "attempt": attempt,
        "elapsed_ms": round((time.monotonic() - runtime.started) * 1000),
        "stages_ms": runtime.stages, "retrieval_counts": runtime.counts,
    }))


def error_code(error):
    if isinstance(error, (ConciergeDeadlineExceeded, httpx.TimeoutException)):
        return "request_timed_out"
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        if status in (401, 403): return "provider_authentication_failed"
        if status == 429: return "provider_rate_limited"
        if status == 404: return "provider_model_unavailable"
    return "provider_request_failed"
