"""test_agent_v0933.py — v0.93.3 THE FRESH-SESSION HARNESS pin.

User report: "when I ask it on a fresh chat it says it can't do it, and
doesn't know what harness.md is or where it is." The v0.89.3 seeding lived
only in StrandsAgentCore.__init__; the CHAT path (_build_tools) never ran
it — the live red-team watched the bot find HARNESS.md only OUTSIDE its
workspace. The seed now rides _build_tools: every fresh workspace gets the
canonical HARNESS.md, copy-if-absent (a bot-edited copy survives).
"""

import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))  # brain/

import agent as ag  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(("  ✓ " if cond else "  ✗ ") + name + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def main():
    print("v0.93.3 fresh-session harness seeding")
    ws = Path("/tmp/v0933-chat-ws")
    if ws.exists():
        shutil.rmtree(ws)
    ws.mkdir(parents=True)

    cb = type("CB", (), {"_emit": staticmethod(lambda ev: None)})()
    tools = ag._build_tools(workspace=str(ws), web_search=True,
                            session_id="v0933-t", callback=cb,
                            model="nvidia/test")
    check("tools built", isinstance(tools, list) and len(tools) > 0)
    seeded = ws / "HARNESS.md"
    check("HARNESS.md seeded into a fresh chat workspace", seeded.is_file())
    if seeded.is_file():
        src = (Path(ag.__file__).parent / "HARNESS.md").read_text(encoding="utf-8", errors="replace")
        check("the seed is the canonical copy", seeded.read_text(encoding="utf-8", errors="replace") == src)

    # a bot-edited copy SURVIVES a later turn (copy-if-absent)
    seeded.write_text("# my annotated harness\n", encoding="utf-8")
    ag._build_tools(workspace=str(ws), web_search=True,
                    session_id="v0933-t", callback=cb, model="nvidia/test")
    check("a bot-edited copy survives (copy-if-absent)",
          seeded.read_text(encoding="utf-8") == "# my annotated harness\n")

    if FAILS:
        print(f"FAILED: {len(FAILS)}")
        sys.exit(1)
    print("OK — fresh chat workspaces carry HARNESS.md")


if __name__ == "__main__":
    main()
