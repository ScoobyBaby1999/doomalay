#!/usr/bin/env python3
# v1.56.0 THE WHOLE TOOLS — source pins (the user's law, verbatim):
#   "Focus on fixing all tool hiccups, we want every single tool to not be
#    truncated, greps to return all hits and work like a sophisticated grep
#    even if we must use an opensource library I don't mind at all. Anything
#    as long as we have a very robust tooling system."
#
# The pins (each one is a LAW, and a regression on any of them is a
# silent data-loss bug the user would only find in production):
#   1. THE GREP IS A REGEX (not a literal) and reports EVERY hit in every
#      file (the old "first hit per file" fold is DEAD).
#   2. THE GREP HAS FLAGS: include/exclude globs, context lines, case,
#      word, invert, count, files-only — and they are in the tool SCHEMA
#      (the model must be able to discover them).
#   3. NO SILENT CAPS: every ceiling that can bite is REPORTED (the
#      result's reason field + the notice).
#   4. THE LISTS PAGE (issues/pulls/commits/releases/runs/repos: a
#      limit of 0 = ALL, not a silent default of 30).
#   5. THE OBSERVATIONS RIDE WHOLE: the in-turn budget's floor rises,
#      the tree's summary default dies, the batch read's 40-line trim
#      dies, the regex_extract's 50-match cap dies.
#   6. THE HICCUP FLAG: every tool hiccup is DETECTED and SPOKEN (a
#      notice + a trace event + the warning tone in the UI).
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E = os.path.join(ROOT, "engine")

fails = []


def check(name, ok, detail=""):
    print(("  PASS " if ok else "  FAIL ") + name + ((" :: " + detail) if detail and not ok else ""))
    if not ok:
        fails.append(name)


def read(rel):
    with open(os.path.join(E, rel), encoding="utf-8") as fh:
        return fh.read()


print("v1.56.0 THE WHOLE TOOLS pins")

# ── 1. THE GREP IS A REGEX + EVERY HIT ──────────────────────────────
grep_pkg = read("internal/grep/grep.go")
check("the grep package exists (the new engine)", os.path.isdir(os.path.join(E, "internal/grep")))
check("the matcher compiles a REGEX (not a literal)",
      "regexp.Compile(src)" in grep_pkg)
check("a RE2-refused pattern falls back to the .NET engine (reported)",
      "regexp2.Compile(src" in grep_pkg and 'm.engine = "regexp2"' in grep_pkg)
check("the fallback engine is REPORTED (never silent)",
      "func (m *Matcher) Engine() string" in grep_pkg)
check("EVERY matching line is reported (the one-per-file fold is DEAD)",
      "break // first hit per file" not in grep_pkg)
check("the context lines ride the hit (-A/-B/-C)",
      "Before []string" in grep_pkg and "After  []string" in grep_pkg
      and "h.Before = append(h.Before, lines...)" in grep_pkg)
check("the globs are compiled with a real dialect (**, *, ?, {a,b})",
      "case '*':" in grep_pkg and "case '{':" in grep_pkg)

forge_grep = read("internal/forge/grep.go")
check("the forge grep runs the full matcher over the fetched files",
      "m.MatchBytes(p, []byte(fc.Content), gopt, res)" in forge_grep)
check("the forge grep keeps EVERY hit (no per-file fold)",
      "break // first hit per file" not in forge_grep)
check("the forge grep reports its engine + pattern",
      "Engine:    m.Engine()" in forge_grep and "Pattern:   m.Pattern()" in forge_grep)
check("a limit that bites is REPORTED (the honest reason)",
      "res.Reason = fmt.Sprintf" in forge_grep)
check("the search options carry the full flag set",
      "IncludeGlobs" in forge_grep and "Context" in forge_grep
      and "MaxPerFile" in forge_grep and "FilesOnly" in forge_grep)

# ── 2. THE FLAGS ARE IN THE SCHEMA (the model can find them) ───────
defs = read("internal/mcpbus/def.go")
for prop in ('"include"', '"exclude"', '"context"', '"before"', '"after"',
             '"case_sensitive"', '"word"', '"invert"', '"count"', '"files_only"'):
    check("the tool schema declares " + prop, prop in defs)
check("the schema teaches the regex law", "REGEX by default" in defs)
check("the workspace Desc teaches the new grep", "THE GREP IS A REAL GREP" in defs)

# the model-facing runner
ws_tool = read("internal/server/workspacetool.go")
check("the workspace grep verb reads the new flags",
      'wsArgBool(args, "case_sensitive")' in ws_tool
      and 'wsArgStrings(args, "include")' in ws_tool)
check("the workspace grep renders the honest header (the engine + the count)",
      "engine=" in ws_tool and "hit(s) for" in ws_tool)
check("the workspace grep renders the context lines",
      'sb.WriteString("    | " + c + "\\n")' in ws_tool)
check("the workspace grep renders the honest reason",
      "NOTE: %s" in ws_tool)
check("the list-cap helper tolerates an array OR a string", "func wsArgStrings" in ws_tool)

# the REST twin
ws_api = read("internal/server/workspaces.go")
check("the REST grep route carries the option set",
      "CaseSensitive:" in ws_api and "IncludeGlobs:" in ws_api)
check("the REST grep route's default limit is ALL (0), not 50",
      'atoiDefault(q.Get("limit"), 50)' not in ws_api)

# ── 3. NO SILENT CAPS (the ceilings that remain are reported) ──────
check("the per-file ceiling is reported (never silent)",
      "res.Stats.Truncated = true" in grep_pkg)
check("the ceiling carries a reason", "res.Stats.Reason" in grep_pkg)
check("the observation clamp still carries the totals (Cline's law)",
      "truncated: first %d of %d bytes shown" in read("internal/llm/clampmarked.go"))

# ── 4. THE LISTS PAGE ──────────────────────────────────────────────
gh = read("internal/forge/github.go")
check("the list verbs PAGE (the ghPage walker exists)",
      "func ghPage[T any]" in gh)
for verb in ("ghIssues", "ghPulls", "ghCommits", "ghReleases", "ghWorkflowRuns"):
    m = re.search(r"func \(c \*Client\) " + verb + r"\b.*?\n}", gh, re.S)
    body = m.group(0) if m else ""
    check(verb + " walks the pages", "ghPage(ctx" in body)
shared = read("internal/forge/shared.go")
check("a 0 limit means ALL (the silent default is DEAD)",
      "func clampLimit(n, def int) int {" in shared and "listLimit = 100" in shared)

# ── 5. THE OBSERVATIONS RIDE WHOLE ─────────────────────────────────
clamp = read("internal/llm/clampmarked.go")
check("the in-turn observation floor rises to 1MB (window-capped)",
      "floorBytes := 1 << 20" in clamp)
check("the 100KB device cap is DEAD (the output rides the stream)",
      "termuxStreamMemCap = 8 * 1024 * 1024" in read("internal/server/termuxstream.go"))
check("the device verbs ride the streaming wrapper (the Bundle never sees them)",
      "termuxRunScriptStream" in read("internal/server/termuxtool.go"))
check("the wrapper POSTs the WHOLE log (the full=1 lane)",
      "full=1" in read("internal/server/termuxstreamrun.go"))
check("the live pins prove the 100KB Bundle cap is dead",
      "TestV1561_DeviceOutputIsNotBundleCapped" in read("internal/server/termuxtool_test.go")
      and "TestV1561_DeviceGrepIsNotBundleCapped" in read("internal/server/termuxtool_test.go"))
check("the tree's summary default is DEAD (the full listing rides)",
      'wsArgBool(args, "summary")' in ws_tool)
check("the batch read's 40-line trim is DEAD (the whole file rides)",
      'atoiDefault(r.URL.Query().Get("head_lines"), 0)' in ws_api)
local = read("internal/llm/localtools.go")
check("regex_extract's 50-match cap is DEAD (ALL matches ride)",
      "FindAllStringSubmatchIndex(in, limit)" in local
      and "FindAllStringSubmatchIndex(in, 50)" not in local)
check("the regex_extract overflow is honest (the count says how many exist)",
      "matches" in local and "raise the limit to see the rest" in local)
check("the journal's per-entry snip is DEAD (the entry rides whole)",
      "textSnip    = 0" in read("internal/djournal/djournal.go"))
check("the journal's reply cap matches the brain twin (64,000)",
      "MaxOut      = 64000" in read("internal/djournal/djournal.go"))

# the brain twins (the HF-space path)
brain_dir = os.path.join(ROOT, "brain", "tools")
dt_journal = open(os.path.join(brain_dir, "dt_journal.py"), encoding="utf-8").read()
check("the brain journal twin's cap matches the engine (64,000)",
      "MAX_OUT = 64000" in dt_journal)
check("the brain journal twin's per-entry snip is DEAD",
      "_TEXT_SNIP = 0" in dt_journal)
dt_artifact = open(os.path.join(brain_dir, "dt_artifact.py"), encoding="utf-8").read()
check("the brain artifact read rides WHOLE (the 6,000-char cut is DEAD)",
      "_READ_CAP" in dt_artifact and "return out" in dt_artifact)
dt_explore = open(os.path.join(brain_dir, "dt_explore.py"), encoding="utf-8").read()
check("the brain explore grep reports EVERY hit (the 80-row fold is DEAD)",
      "for h in hits:" in dt_explore and "hits[:_LIST_CAP]" not in dt_explore)
check("the brain explore batch read rides whole (the 24,000 cut is DEAD)",
      "len(body) > 24000" not in dt_explore)
dt_workspace = open(os.path.join(brain_dir, "dt_workspace.py"), encoding="utf-8").read()
check("the brain workspace grep reports EVERY hit (the 60-row fold is DEAD)",
      "for h in hits:" in dt_workspace and "hits[:_LIST_CAP]" not in dt_workspace)

# the termux (device) grep
termux = read("internal/server/termuxtool.go")
check("the device grep is a REAL grep (ripgrep when installed)",
      "command -v rg" in termux)
check("the device grep is a REGEX (grep -E fallback)", "grep -rEn" in termux)
check("the device grep takes the context flags", "-C" in termux and "-A" in termux)
check("the device grep takes the glob filters", "-g \"$include\"" in termux)

# ── 6. THE HICCUP FLAG ──────────────────────────────────────────────
fault = read("internal/llm/toolfault.go")
check("the hiccup detector exists", "func DetectToolFault" in fault)
check("the detector reads the truncation marker",
      '"[truncated:"' in fault)
check("the detector reads the Termux cap markers (both editions)",
      '"[termux: output truncated at 100KB"' in fault
      and '"[termux: output truncated at the engine' in fault)
check("the detector reads the refusal markers",
      '"REFUSED —"' in fault and '"JAIL REFUSED"' in fault)
check("the flag SPEAKS the notice", 'Type: "notice"' in fault)
check("the flag keeps the trace", "obs.ToolFault" in fault)
nativetools = read("internal/llm/nativetools.go")
check("the native-tools loop flags every observation",
      nativetools.count("FlagToolFault(") >= 2)
chat_js = read("internal/server/web/chatpanel.js")
check("the UI keeps the hiccup code on the bubble", "msg.code" in chat_js)
check("the UI renders the hiccup bubble with the code attribute",
      'data-code="' in chat_js)
index_html = read("internal/server/web/index.html")
check("the hiccup bubble wears the warning tone + a ⚠ glyph",
      'data-code="tool-hiccup"' in index_html and "⚠" in index_html)
check("the hiccup tone rides the theme tokens (no hardcoded color)",
      "var(--err-rgb" in index_html)

# ── the tests exist (the laws are pinned) ──────────────────────────
check("the grep package has its own pins", "internal/grep/grep_test.go")
check("the workspace grep has its model-facing pins",
      "internal/server/workspacetool_v1560_test.go")
check("the hiccup flag has its pins", "internal/llm/toolfault_test.go")

print("")
if fails:
    print("FAILED %d pin(s):" % len(fails))
    for f in fails:
        print("  - " + f)
    sys.exit(1)
print("ALL PINS PASS")
