"""v1.10.2 THE BLACK-HOLE GUARD — brain-side unit tests.

Offline: a local HTTP server plays the provider (answering fast / stalling
past the timeout); SPACE_ID is monkeypatched to simulate the Space context.
"""
import json
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import provider_health


class _Provider(BaseHTTPRequestHandler):
    mode = "ok"  # class attr mutated by the test

    def do_POST(self):  # noqa: N802 — http.server API
        if _Provider.mode == "ok":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"choices":[{"message":{"content":"hi"}}]}')
        elif _Provider.mode == "refuse":
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b'{"error":"bad key"}')
        else:  # stall
            time.sleep(provider_health._PROBE_TIMEOUT + 5)

    def log_message(self, *a):  # silence
        pass


@pytest.fixture()
def fake_provider():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Provider)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/chat/completions"
    srv.shutdown()


@pytest.fixture(autouse=True)
def _space_ctx(monkeypatch):
    monkeypatch.setattr(provider_health, "on_space", lambda: True)
    # keep the suite fast: the production 120s budget (the live-measured
    # NVIDIA queue answers ~29s; the black hole never does) shrinks to 1s
    # here — the stall handler sleeps past whatever budget is set.
    monkeypatch.setattr(provider_health, "_PROBE_TIMEOUT", 1)
    provider_health.reset_cache()
    yield
    provider_health.reset_cache()
    _Provider.mode = "ok"


def test_healthy_provider_passes(fake_provider):
    _Provider.mode = "ok"
    assert provider_health.check("prov", fake_provider, "k", "m") is None


def test_http_error_is_egress_ok(fake_provider):
    # a 401 is a REAL ANSWER — the turn must run and surface the honest error
    _Provider.mode = "refuse"
    assert provider_health.check("prov", fake_provider, "k", "m") is None


def test_stall_fails_fast_then_caches(fake_provider):
    _Provider.mode = "stall"
    t0 = time.time()
    msg = provider_health.check("prov", fake_provider, "k", "m")
    took = time.time() - t0
    assert msg is not None
    assert "did not answer" in msg or "not answering" in msg
    assert took < provider_health._PROBE_TIMEOUT + 10  # fast-fail, not 86400s

    # second call inside the cooldown window: instant, no re-probe
    t1 = time.time()
    msg2 = provider_health.check("prov", fake_provider, "k", "m")
    assert msg2 is not None and "not answering" in msg2
    assert time.time() - t1 < 2


def test_ok_verdict_cached(fake_provider):
    _Provider.mode = "ok"
    assert provider_health.check("prov", fake_provider, "k", "m") is None
    # flip to stall AFTER the ok verdict — the cache must carry the ok
    _Provider.mode = "stall"
    t0 = time.time()
    assert provider_health.check("prov", fake_provider, "k", "m") is None
    assert time.time() - t0 < 2  # no probe ran (would have taken 15s+)


def test_local_brain_never_probes(fake_provider, monkeypatch):
    monkeypatch.setattr(provider_health, "on_space", lambda: False)
    _Provider.mode = "stall"
    assert provider_health.check("prov", fake_provider, "k", "m") is None
