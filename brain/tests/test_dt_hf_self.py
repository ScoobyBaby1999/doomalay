"""v1.10.3 THE SPACE KNOWS ITSELF — dt_hf self/default-repo tests (offline)."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import pytest

import dt_hf


@pytest.fixture(autouse=True)
def _clean_space_env(monkeypatch):
    monkeypatch.delenv("SPACE_ID", raising=False)
    monkeypatch.delenv("HF_SPACE_ID", raising=False)
    yield


def test_default_repo_empty_off_space():
    assert dt_hf._default_repo("") == ""
    assert dt_hf._default_repo("   ") == ""


def test_default_repo_empty_on_space(monkeypatch):
    monkeypatch.setenv("SPACE_ID", "ScoobyBaby1999/doomalay-final-test")
    assert dt_hf._default_repo("") == "ScoobyBaby1999/doomalay-final-test"


def test_default_repo_explicit_wins(monkeypatch):
    monkeypatch.setenv("SPACE_ID", "someone/else")
    assert dt_hf._default_repo(" me/mine ") == "me/mine"
    assert dt_hf._default_repo(" spaces/foo/bar ") == "foo/bar"


def test_self_off_space_names_local_brain():
    out = dt_hf.run_action("self")
    assert "local brain" in out
    assert "cpus:" in out


def test_self_on_space_reports_identity(monkeypatch):
    monkeypatch.setenv("SPACE_ID", "ScoobyBaby1999/doomalay-final-test")
    out = dt_hf.run_action("self")
    assert "ScoobyBaby1999/doomalay-final-test" in out
    assert "https://huggingface.co/spaces/ScoobyBaby1999/doomalay-final-test" in out
    # disk/memory/cpus lines are best-effort but at least one lands on Linux
    assert ("memory:" in out) or ("disk" in out)
    assert "cpus:" in out


def test_space_logs_empty_repo_targets_self(monkeypatch):
    """The D4 acceptance: space_logs with NO repo must call the SPACE_ID repo."""
    monkeypatch.setenv("SPACE_ID", "me/my-space")
    calls = {}

    def fake_rest(method, api_path, token, body=None, ctype="application/json", timeout=30):
        calls["path"] = api_path
        calls["method"] = method
        return 200, "build log line 1\nbuild log line 2"

    monkeypatch.setattr(dt_hf, "_hf_rest", fake_rest)
    monkeypatch.setattr(dt_hf, "_get_token", lambda env: "hf_test_token")
    out = dt_hf.run_action("space_logs", env={}, log_type="build")
    assert calls["path"] == "/api/spaces/me/my-space/logs/build?tail=100"
    assert "build log line" in out


def test_space_logs_no_repo_no_space_id(monkeypatch):
    """Off-space + no repo = the honest missing-repo message, not a crash."""
    out = dt_hf.run_action("space_logs", env={}, log_type="build")
    assert "missing" in out.lower() or "space_logs" in out
