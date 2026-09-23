"""test_dt_hublib.py — offline unit tests for brain/tools/dt_hublib.py.

Covers the plain core only: no strands, no network, no engine, no httpx —
a FakeClient stands in for the engine's hub REST surface (the same response
shapes artifacts.go/hub.go/sessions.go emit), and the "chat_event" emit seam
is a plain collector list.

The three behaviours the user asked to verify get explicit suites here:
  1. browse — items → text list + a hublist event with tappable cards;
  2. download — engine POST → landing confirmation + payload in hand;
  3. THE BOXES — botTemplates/botSkills gate each type, read ON THE FLY
     (every call re-reads the tweaks blob; flipping it changes the answer).

Runs standalone (`python3 tests/test_dt_hublib.py`) AND under pytest.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

# Import the tool module straight from brain/tools/ (no package layout),
# and brain/ itself for dt_registry (the discovery contract).
_TOOLS_DIR = Path(__file__).resolve().parent.parent / "tools"
_BRAIN_DIR = Path(__file__).resolve().parent.parent
for _p in (str(_TOOLS_DIR), str(_BRAIN_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import dt_hublib  # noqa: E402

TDD = {
    "type": "skill", "repo": "someone/doomalay-superpowers",
    "id": "superpowers-tdd-abc123", "name": "superpowers TDD",
    "description": "test-driven development discipline",
    "author": "someone", "tags": ["superpowers-obra", "tdd"],
    "hearts": 3, "downloads": 12,
}
BRAINSTORM = {
    "type": "skill", "repo": "someone/doomalay-superpowers",
    "id": "superpowers-brainstorming-def456", "name": "superpowers brainstorming",
    "description": "idea generation flow",
    "author": "someone", "tags": ["superpowers-obra"],
    "hearts": 1, "downloads": 4,
}
DEEP_RESEARCH = {
    "type": "template", "repo": "other/doomalay-templates",
    "id": "deep-research-987654", "name": "deep research",
    "description": "multi-round web research with citations",
    "author": "other", "tags": ["research"],
    "hearts": 7, "downloads": 40,
}


class FakeClient:
    """The engine's hub REST shapes, in-memory. tweaks is mutable so the
    ON-THE-FLY box tests can flip switches between run() calls."""

    def __init__(self, items=None, tweaks=None, downloads=None):
        self._items = items or []
        self.tweaks_blob = tweaks if tweaks is not None else {}
        self._dl = downloads or []
        self.calls = []

    def libraries(self):
        return {"libraries": [
            {"type": "template", "label": "Template Library", "localCount": 1,
             "desc": "templates"},
            {"type": "skill", "label": "Skill Library", "localCount": 0,
             "desc": "skills"},
            {"type": "persona", "label": "Persona Library", "localCount": 0,
             "desc": "personas"},
        ]}

    def items(self, typ, q="", sort="", tag=""):
        self.calls.append(("items", typ, q, sort, tag))
        hits = [i for i in self._items if i.get("type") == typ]
        if q:
            hits = [i for i in hits
                    if q.lower() in str(i.get("name", "")).lower()
                    or q.lower() in str(i.get("description", "")).lower()]
        if tag:
            hits = [i for i in hits if tag in (i.get("tags") or [])]
        return {"items": hits, "total": len(hits)}

    def detail(self, typ, repo, item_id):
        self.calls.append(("detail", typ, repo, item_id))
        for i in self._items:
            if i["repo"] == repo and i["id"] == item_id:
                return {"item": i, "payload": "# methodology body\nstep one"}
        return {"error": "item not found", "status": 404}

    def download(self, typ, repo, item_id):
        self.calls.append(("download", typ, repo, item_id))
        for i in self._items:
            if i["repo"] == repo and i["id"] == item_id:
                self._dl.append(i)
                return {"item": i, "payload": "# methodology body\nstep one"}
        return {"error": "item not found", "status": 404}

    def downloads(self, typ):
        return {"items": [{"item": i, "payload": "…"}
                           for i in self._dl if i.get("type") == typ]}

    def tweaks(self):
        return {"tweaks": self.tweaks_blob}


@contextmanager
def tmp_state():
    d = Path(tempfile.mkdtemp(prefix="dt-hublib-test-"))
    try:
        yield d
    finally:
        shutil.rmtree(d, ignore_errors=True)


def collector():
    out = []

    def _emit(event: str = "status", **fields):
        out.append(fields.get("ev"))
    return _emit, out


# ── the boxes ────────────────────────────────────────────────────────────

def test_box_absent_means_enabled():
    assert dt_hublib.box_enabled({}, "skill")[0]
    assert dt_hublib.box_enabled(None, "template")[0]
    assert dt_hublib.box_enabled({"unrelated": 1}, "skill")[0]


def test_box_off_refuses_with_actionable_message():
    ok, msg = dt_hublib.box_enabled({"botSkills": False}, "skill")
    assert not ok
    assert "Skills box is OFF" in msg
    assert "tweaks" in msg          # names where the switch lives
    ok, msg = dt_hublib.box_enabled({"botTemplates": False}, "template")
    assert not ok and "Templates box is OFF" in msg


def test_box_true_and_cross_type_isolation():
    assert dt_hublib.box_enabled({"botSkills": True}, "skill")[0]
    # the SKILLS box must not gate templates, nor vice versa
    assert dt_hublib.box_enabled({"botSkills": False}, "template")[0]
    assert dt_hublib.box_enabled({"botTemplates": False}, "skill")[0]


def test_persona_type_is_not_hublibs():
    ok, msg = dt_hublib.box_enabled({}, "persona")
    assert not ok and "persona" in msg.lower()


def test_read_boxes_shapes():
    assert dt_hublib.read_boxes({"tweaks": {"a": 1}}) == {"a": 1}
    assert dt_hublib.read_boxes({}) == {}
    assert dt_hublib.read_boxes(None) == {}
    assert dt_hublib.read_boxes({"tweaks": None}) == {}
    assert dt_hublib.read_boxes("junk") == {}


def test_gate_is_read_on_the_fly():
    """The user's headline requirement: flip the box mid-conversation and
    the NEXT tool call obeys — no caching of the tweak blob anywhere."""
    fc = FakeClient(items=[TDD], tweaks={"botSkills": False})
    assert "Skills box is OFF" in dt_hublib.run(
        "browse", typ="skill", client=fc)
    fc.tweaks_blob = {}                       # the user flips the switch ON
    out = dt_hublib.run("browse", typ="skill", client=fc)
    assert "Skills box is OFF" not in out and "superpowers TDD" in out
    fc.tweaks_blob = {"botSkills": False}     # …and OFF again
    assert "Skills box is OFF" in dt_hublib.run(
        "download", typ="skill", ref="tdd", client=fc)


def test_unreadable_tweaks_default_open():
    class Boom:
        def tweaks(self):
            raise RuntimeError("engine hiccup")
    # run() guards the read: browsing proceeds (default-on), nothing raises
    out = dt_hublib.run("browse", typ="skill", client=Boom())
    assert "hublib error" not in out


# ── the hublist event (the user's tappable cards) ─────────────────────────

def test_event_carries_cards_and_replay_text():
    ev = dt_hublib.build_event("hub · 2 skills",
                               [dt_hublib.card_for_item(TDD),
                                dt_hublib.card_for_item(BRAINSTORM)])
    assert ev["type"] == "hublist"
    assert ev["summary"] == "hub · 2 skills"
    assert [c["name"] for c in ev["items"]] == ["superpowers TDD",
                                               "superpowers brainstorming"]
    replay = json.loads(ev["text"])           # the engine persists text=
    assert replay["summary"] == "hub · 2 skills"
    assert replay["items"][0]["id"] == "superpowers-tdd-abc123"


def test_card_shape_is_renderer_minimal():
    c = dt_hublib.card_for_item(TDD, downloaded=True)
    assert set(c) == {"type", "repo", "id", "name", "description", "author",
                      "tags", "hearts", "downloads", "downloaded"}
    assert c["downloaded"] is True
    assert c["tags"] == ["superpowers-obra", "tdd"]
    assert "payload" not in c                 # bodies never ride the event
    assert dt_hublib.card_for_item("junk").get("name") == "item"


def test_emit_seam_never_raises():
    assert dt_hublib.emit_hub_event(None, "s", [dt_hublib.card_for_item(TDD)]) is False

    def boom(event, **kw):
        raise RuntimeError("downstream gone")
    assert dt_hublib.emit_hub_event(boom, "s", [dt_hublib.card_for_item(TDD)]) is False
    emit, out = collector()
    assert dt_hublib.emit_hub_event(emit, "s", [dt_hublib.card_for_item(TDD)])
    assert out and out[0]["type"] == "hublist"


def test_event_caps_at_twelve_cards():
    many = [dt_hublib.card_for_item({"id": f"x{i}", "name": f"n{i}"})
            for i in range(40)]
    ev = dt_hublib.build_event("big", many)
    assert len(ev["items"]) == dt_hublib.MAX_EVENT_ITEMS == 12


# ── ref resolution ────────────────────────────────────────────────────────

def test_resolve_ref_forms():
    rows = [TDD, BRAINSTORM]
    r = dt_hublib.resolve_ref(rows, "someone/doomalay-superpowers/superpowers-tdd-abc123")
    assert r and r["id"] == "superpowers-tdd-abc123"
    assert dt_hublib.resolve_ref(rows, "tdd")["name"] == "superpowers TDD"
    assert dt_hublib.resolve_ref(rows, "  SUPERPOWERS TDD ")["id"].endswith("abc123")
    assert dt_hublib.resolve_ref(rows, "superpowers") is None   # ambiguous
    assert dt_hublib.resolve_ref(rows, "") is None
    assert dt_hublib.resolve_ref(None, "tdd") is None
    assert dt_hublib.resolve_ref(rows, "nope") is None


# ── actions ───────────────────────────────────────────────────────────────

def test_browse_lists_and_emits():
    fc = FakeClient(items=[TDD, BRAINSTORM, DEEP_RESEARCH])
    emit, out_ev = collector()
    with tmp_state() as d:
        res = dt_hublib.run("browse", typ="skill", client=fc,
                            state_dir=d, emit=emit)
    assert "2 skills" in res
    assert "superpowers TDD" in res and "someone/doomalay-superpowers" in res
    assert "♥3 ⤓12" in res
    assert len(out_ev) == 1 and out_ev[0]["type"] == "hublist"
    assert [c["name"] for c in out_ev[0]["items"]] == [
        "superpowers TDD", "superpowers brainstorming"]
    assert ("items", "skill", "", "", "") in fc.calls


def test_browse_marks_already_downloaded():
    fc = FakeClient(items=[TDD], downloads=[TDD])
    emit, out_ev = collector()
    with tmp_state() as d:
        res = dt_hublib.run("browse", typ="skill", client=fc,
                            state_dir=d, emit=emit)
    assert "downloaded" in res
    assert out_ev[0]["items"][0]["downloaded"] is True


def test_browse_empty_and_tag_and_query():
    fc = FakeClient(items=[TDD, BRAINSTORM])
    assert "no skills" in dt_hublib.run("browse", typ="skill", q="zzz", client=fc)
    res = dt_hublib.run("browse", typ="skill", tag="tdd", client=fc)
    assert "superpowers TDD" in res and "brainstorming" not in res
    assert ("items", "skill", "", "", "tdd") in fc.calls


def test_download_by_bare_name_via_last_json():
    fc = FakeClient(items=[TDD])
    emit, out_ev = collector()
    with tmp_state() as d:
        dt_hublib.run("browse", typ="skill", client=fc, state_dir=d, emit=emit)
        res = dt_hublib.run("download", typ="skill", ref="tdd",
                            client=fc, state_dir=d, emit=emit)
    assert "downloaded 'superpowers TDD'" in res
    assert "methodology body" in res          # the payload lands in hand
    assert "template sheet" in res            # where the user finds it
    assert ("download", "skill", "someone/doomalay-superpowers",
            "superpowers-tdd-abc123") in fc.calls
    assert any(e and e["items"] and e["items"][0]["downloaded"]
               for e in out_ev)                # the confirmation card


def test_download_by_explicit_repo_id():
    fc = FakeClient(items=[TDD])
    res = dt_hublib.run("download", typ="skill",
                        repo="someone/doomalay-superpowers",
                        item_id="superpowers-tdd-abc123", client=fc)
    assert "downloaded 'superpowers TDD'" in res


def test_download_ambiguous_and_unresolvable():
    fc = FakeClient(items=[TDD, BRAINSTORM])
    with tmp_state() as d:
        res = dt_hublib.run("download", typ="skill", ref="superpowers",
                            client=fc, state_dir=d)
    assert "ambiguous" in res
    res = dt_hublib.run("download", typ="skill", ref="nope", client=fc)
    assert "could not resolve" in res or "browse first" in res
    res = dt_hublib.run("download", typ="skill", client=fc)
    assert "ref='name'" in res                 # no address at all → hint


def test_download_error_path():
    fc = FakeClient(items=[])
    res = dt_hublib.run("download", typ="skill", repo="x", item_id="y", client=fc)
    assert "hublib:" in res and "not found" in res


def test_detail_preview():
    fc = FakeClient(items=[TDD])
    res = dt_hublib.run("detail", typ="skill", ref="tdd", client=fc)
    assert "superpowers TDD" in res and "payload preview" in res
    assert "methodology body" in res


def test_downloaded_lists_engine_rows():
    fc = FakeClient(items=[TDD], downloads=[TDD])
    res = dt_hublib.run("downloaded", typ="skill", client=fc)
    assert "superpowers TDD" in res
    assert "no skills" not in res
    assert "no templates" in dt_hublib.run("downloaded", typ="template", client=fc)


def test_libraries_and_help_and_unknown():
    fc = FakeClient()
    assert "Template Library" in dt_hublib.run("libraries", client=fc)
    assert "persona library imports" in dt_hublib.run("libraries", client=fc)
    h = dt_hublib.run("help")
    for verb in ("browse", "detail", "download", "downloaded", "libraries"):
        assert verb in h
    assert "unknown action" in dt_hublib.run("frobnicate", client=fc)


def test_type_must_be_template_or_skill():
    fc = FakeClient(items=[TDD])
    assert "type must be 'template' or 'skill'" in dt_hublib.run(
        "browse", typ="persona", client=fc)
    assert "type must be 'template' or 'skill'" in dt_hublib.run(
        "download", client=fc)               # empty type too


def test_engine_down_degrades_to_strings():
    dead = FakeClient()

    def unreachable(*a, **k):
        return {"error": "engine unreachable at http://x: [err]"}
    dead.items = dead.detail = dead.download = dead.downloads = unreachable
    dead.libraries = unreachable
    assert "engine unreachable" in dt_hublib.run("browse", typ="skill", client=dead)
    assert "engine unreachable" in dt_hublib.run("libraries", client=dead)


def test_run_never_raises_on_broken_client():
    class Exploding:
        def __getattr__(self, k):
            raise RuntimeError("boom")
    for action in ("browse", "detail", "download", "downloaded",
                   "libraries", "help"):
        out = dt_hublib.run(action, typ="skill", client=Exploding())
        assert isinstance(out, str) and out           # a string, never an exception


def test_repo_id_url_encoding():
    """A repo is 'user/name' — it must ride ONE path segment (hubitem.js's
    encodeURIComponent rule), so the Go 1.22 mux sees 3 segments, not 4."""
    from urllib.parse import unquote
    seg = dt_hublib._quote_seg("someone/doomalay-superpowers")
    assert "/" not in seg and unquote(seg) == "someone/doomalay-superpowers"


def test_last_json_survives_garbage():
    with tmp_state() as d:
        (d / "last.json").write_text("not json at all{")
        assert dt_hublib._load_last(d) == {}     # bad file → empty, no raise
        (d / "last.json").write_text(json.dumps(
            {"skill": [dt_hublib.card_for_item(TDD)]}))
        fc = FakeClient(items=[TDD])
        res = dt_hublib.run("download", typ="skill", ref="tdd",
                            client=fc, state_dir=d)
        assert "downloaded 'superpowers TDD'" in res


def test_build_registers_only_with_strands():
    import dt_registry
    ctx = dt_registry.ToolContext(workspace=Path(tempfile.mkdtemp()))
    try:
        import strands  # noqa: F401
        have_strands = True
    except Exception:
        have_strands = False
    built = dt_hublib.build(ctx)
    if have_strands:
        assert built and getattr(built[0], "tool_name", None) == "hublib" \
            or (built and len(built) == 1)
    else:
        assert built == []                      # dt_spec rule 1: register nothing


def test_registry_discovers_the_module():
    import dt_registry
    names = [p.name for p in dt_registry.discover()]
    assert "dt_hublib.py" in names
    manifest = dt_registry.tool_manifest()
    assert manifest.get("dt_hublib", {}).get("names") == ["hublib"]


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  PASS {name}")
            except AssertionError as exc:
                failures += 1
                print(f"  FAIL {name}: {exc}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"  ERROR {name}: {type(exc).__name__}: {exc}")
    print("ALL TESTS PASSED" if not failures else f"{failures} FAILURES")
    sys.exit(0 if not failures else 1)
