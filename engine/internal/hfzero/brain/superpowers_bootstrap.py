"""superpowers_bootstrap.py — Superpowers session bootstrap for doomalay v0.42.

Ported from obra/superpowers (github.com/obra/superpowers), MIT (c) 2025 Jesse
Vincent, adapted for doomalay by the Doomalay team. The upstream integration
model (docs/porting-to-a-new-harness.md in that repo) has three components:

  1. **Skills** — harness-agnostic SKILL.md files (prose names ACTIONS, never
     tool names). In doomalay these live in ``brain/agent_skills/`` — fifteen
     ``superpowers-*`` skills ported verbatim-minus-tool-names, alongside the
     pre-existing ``conscious`` and ``workspace-artifacts`` skills.
  2. **Tool mapping** — per-harness translation of the action vocabulary.
     doomalay's mapping: "invoke a skill" -> load the SKILL.md (the AgentSkills
     loader surfaces name+description; loading = reading the body);
     "dispatch a subagent" -> the ``delegate`` tool (sub-agent turn, same
     workspace); "create a todo" -> the plan checklist; specs/plans/ledgers
     are ordinary files in the per-session workspace.
  3. **Bootstrap** — the ONE non-negotiable invariant: at the start of every
     session, the using-superpowers core is injected into the model's context
     (wrapped in <EXTREMELY_IMPORTANT> upstream; we keep the emphasis tags),
     with no per-session opt-in. Without the bootstrap the skill files are
     inert — present on disk, never loaded. That is this module's job.

# What lives here (three public callables, zero agent_core imports)

This module is deliberately STANDALONE: stdlib only, no imports from
agent_core / agent / server, so wave-3's Strands upgrade (task 6-a, the
AgentSkills plugin) and wave-4's template seeding can wire it in however
they like without import cycles. Integration points:

  * ``get_bootstrap_prompt(skills_index)`` — the always-on system-prompt
    block: the skill-check-before-ANY-response rule, the Red Flags table,
    process-before-domain priority, and the progressive-disclosure index of
    available skills. Re-inject after every context compaction — the
    bootstrap is what the compacted context forgets first, and an agent
    that loses it stops checking for skills entirely (see the compaction
    note in the prompt itself).
  * ``build_skills_index(skills_dir)`` — scans a skills directory, parses
    each ``<name>/SKILL.md`` frontmatter (simple ``---`` block parser; we
    do NOT depend on PyYAML because frontmatter here is flat name+description
    lines, and Android/Chaquopy deps stay minimal), and returns the
    [{name, description, location}] index for progressive disclosure:
    the index rides the system prompt (~a dozen lines), the 25k-word skill
    bodies load on demand, NEVER inline.
  * ``SUPERPOWERS_CREDIT`` — the attribution string. MIT requires the
    copyright + permission notice travel with copies/substantial portions;
    we surface it in the bootstrap footer and in docs/CREDITS.md.

# Why the description rule matters (the SDO insight)

Upstream's evals found that a description which SUMMARIZES the skill's
workflow teaches the model to follow the summary and skip the body (one
review instead of two, one phase instead of four). Descriptions therefore
carry ONLY triggering conditions ("Use when ..."). ``build_skills_index``
preserves the ported descriptions untouched; do not "improve" them into
summaries.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Attribution (MIT obligation + credit)
# ---------------------------------------------------------------------------

SUPERPOWERS_CREDIT = (
    "Superpowers: derived from obra/superpowers by Jesse Vincent "
    "(MIT (c) 2025 Jesse Vincent), ported to doomalay v0.42 by the "
    "Doomalay team. Original: github.com/obra/superpowers"
)

# ---------------------------------------------------------------------------
# Frontmatter parsing (yaml-free, stdlib-only)
# ---------------------------------------------------------------------------

# A SKILL.md frontmatter block is a fenced `---` ... `---` region of flat
# `key: value` lines (name + description, per the agentskills.io spec the
# ported skills follow). Full YAML would pull PyYAML into the Android
# build for two fields, so we parse the flat subset: quoted or bare
# single-line values, plus continuation lines for wrapped descriptions.
_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)
_KEY_VALUE_RE = re.compile(r"^([A-Za-z0-9_-]+):\s*(.*)$")


def parse_frontmatter(text: str) -> dict[str, str]:
    """Parse the leading ``---`` frontmatter block of a SKILL.md.

    Returns {} when the file has no frontmatter block. Only the flat
    ``key: value`` subset is supported (deliberate — see module docstring);
    unknown shapes degrade to whatever keys did parse, never an exception,
    because a malformed skill file must never take the agent down.
    """
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}
    fields: dict[str, str] = {}
    current_key: str | None = None
    for line in m.group(1).splitlines():
        if not line.strip():  # blank line ends any wrapped value
            current_key = None
            continue
        km = _KEY_VALUE_RE.match(line)
        if km:
            current_key = km.group(1)
            fields[current_key] = _strip_quotes(km.group(2))
        elif line.startswith((" ", "\t")) and current_key:
            # continuation of a wrapped value (indented follow-on line)
            fields[current_key] = (fields.get(current_key, "") + " " + line.strip()).strip()
    return fields


def _strip_quotes(value: str) -> str:
    """Strip one matching pair of surrounding single/double quotes."""
    v = value.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
        return v[1:-1]
    return v


def build_skills_index(skills_dir: str | Path) -> list[dict[str, Any]]:
    """Scan a skills directory and build the progressive-disclosure index.

    ``skills_dir`` layout: ``<skills_dir>/<skill-name>/SKILL.md`` (the
    agentskills.io layout used by brain/agent_skills/). Each entry carries:

      * ``name``        — frontmatter name (must equal the directory name;
                          mismatches are skipped with the skill listed under
                          ``"__skipped__"`` diagnostics only, not an error —
                          a bad skill file must not break the bootstrap)
      * ``description`` — the "Use when ..." trigger line, passed through
                          VERBATIM (see the SDO note in the module docstring)
      * ``location``    — the SKILL.md path, so the loader/model can read the
                          full body on demand

    Entries are sorted by name for a stable, cacheable index. The two
    pre-existing doomalay skills (conscious, workspace-artifacts) are indexed
    exactly like the fifteen ported superpowers-* skills — one namespace,
    one loader.
    """
    root = Path(skills_dir)
    index: list[dict[str, Any]] = []
    if not root.is_dir():
        return index
    for skill_md in sorted(root.glob("*/SKILL.md")):
        try:
            text = skill_md.read_text(encoding="utf-8")
        except OSError:
            continue
        fields = parse_frontmatter(text)
        name = fields.get("name", "")
        if not name:
            continue
        if name != skill_md.parent.name:
            # Frontmatter name must match its directory (loader invariant);
            # skip rather than guess which identifier the skills tool uses.
            continue
        index.append({
            "name": name,
            "description": fields.get("description", ""),
            "location": str(skill_md),
        })
    return index


# ---------------------------------------------------------------------------
# The bootstrap prompt (adapted using-superpowers core)
# ---------------------------------------------------------------------------

# The Red Flags table is upstream's eval-hardened rationalization killer:
# each row is a thought the model catches itself thinking right before it
# skips the skill check. Kept essentially intact — this table is the
# behavior-shaping core of the whole system.
_RED_FLAGS_TABLE = """| Thought | Reality |
|---------|---------|
| "This is just a simple question" | Questions are tasks. Check for skills. |
| "I need more context first" | Skill check comes BEFORE clarifying questions. |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first. |
| "I can check git/files quickly" | Files lack conversation context. Check for skills. |
| "Let me gather information first" | Skills tell you HOW to gather information. |
| "This doesn't need a formal skill" | If a skill exists, use it. |
| "I remember this skill" | Skills evolve. Read current version. |
| "This doesn't count as a task" | Action = task. Check for skills. |
| "The skill is overkill" | Simple things become complex. Use it. |
| "I'll just do this one thing first" | Check BEFORE doing anything. |
| "This feels productive" | Undisciplined action wastes time. Skills prevent this. |
| "I know what that means" | Knowing the concept ≠ using the skill. Load it. |"""

_BOOTSTRAP_TEMPLATE = """<EXTREMELY_IMPORTANT>
If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST load the skill.

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.

This is not negotiable. You cannot rationalize your way out of this.
</EXTREMELY_IMPORT>

## The Rule

**Load relevant or requested skills BEFORE any response or action** — including clarifying questions, exploring the codebase, or checking files. If it turns out wrong for the situation, you don't have to use it.

**Before entering plan mode:** if you haven't already brainstormed, load the superpowers-brainstorming skill first.

Then announce "Using [skill] to [purpose]" and follow the skill exactly. If it has a checklist, add one plan-checklist item per item.

## Skill Priority

When multiple skills apply, process skills come first — they set the approach, then implementation skills carry it out. Brainstorming and systematic-debugging are Superpowers' most common process skills, but the rule holds for any of them.

- "Let's build X" → superpowers-brainstorming first, then implementation skills.
- "Fix this bug" → superpowers-systematic-debugging first, then domain skills.

## Red Flags

These thoughts mean STOP—you're rationalizing:

{red_flags}

## Available Skills (index — load the full SKILL.md when one applies)

{skills_index}

## Compaction Note

Context compaction forgets this block first. After any compaction, re-check
this index before your next response: an agent that loses the bootstrap
stops checking for skills entirely. The ledger and workspace files
(progress.md, specs, plans) are the durable record — trust them over
recollection.

## User Instructions

User instructions (project instruction files, direct requests) take precedence over skills, which in turn override default behavior. Only skip skill workflows or instructions when your human partner has explicitly told you to.

{credit}"""


def get_bootstrap_prompt(skills_index: list[dict[str, Any]] | None = None) -> str:
    """Render the always-on Superpowers bootstrap system-prompt block.

    ``skills_index`` is the list returned by :func:`build_skills_index`
    (or any [{name, description, location}] list). When None or empty the
    index section degrades to a directory hint instead of disappearing —
    an agent told skills exist but shown none will not check again.

    The caller is expected to inject this at session start AND re-inject
    after every context compaction (upstream's session-start hook fires on
    startup|clear|compact; the doomalay wiring lives in the Strands adapter
    layer, not here — this module only builds the string).
    """
    if skills_index:
        lines = []
        for entry in skills_index:
            name = entry.get("name", "")
            desc = (entry.get("description") or "").strip().replace("\n", " ")
            lines.append(f"- **{name}** — {desc}")
        skills_block = "\n".join(lines)
    else:
        skills_block = (
            "(skills index unavailable — ask the operator to list "
            "agent_skills/ before proceeding)"
        )
    return _BOOTSTRAP_TEMPLATE.format(
        red_flags=_RED_FLAGS_TABLE,
        skills_index=skills_block,
        credit=SUPERPOWERS_CREDIT,
    )


# ---------------------------------------------------------------------------
# Self-test (python3 brain/superpowers_bootstrap.py)
# ---------------------------------------------------------------------------

if __name__ == "__main__":  # pragma: no cover — manual smoke check
    import sys

    skills_dir = (
        Path(__file__).resolve().parent / "agent_skills"
    )
    idx = build_skills_index(skills_dir)
    print(f"indexed {len(idx)} skills:")
    for e in idx:
        print(f"  {e['name']:45s} {e['description'][:60]}...")
    prompt = get_bootstrap_prompt(idx)
    print(f"\nbootstrap prompt: {len(prompt)} chars, "
          f"{'EXTREMELY_IMPORTANT ok' if '<EXTREMELY_IMPORTANT>' in prompt else 'MISSING TAG'}")
    names = {e["name"] for e in idx}
    expected = {
        "superpowers-using-superpowers", "superpowers-writing-skills",
        "superpowers-brainstorming", "superpowers-writing-plans",
        "superpowers-subagent-driven-development", "superpowers-executing-plans",
        "superpowers-dispatching-parallel-agents",
        "superpowers-requesting-code-review",
        "superpowers-receiving-code-review",
        "superpowers-using-git-worktrees",
        "superpowers-finishing-a-development-branch",
        "superpowers-test-driven-development",
        "superpowers-systematic-debugging",
        "superpowers-verification-before-completion",
        "superpowers-diagnosing-superpowers",
    }
    missing = expected - names
    print("all 15 superpowers skills present" if not missing
          else f"MISSING: {sorted(missing)}")
    sys.exit(0 if not missing else 1)
