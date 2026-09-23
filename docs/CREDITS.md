# Credits & Attribution

## Superpowers port (doomalay v0.42)

The **Superpowers** agent-skills system shipped in doomalay v0.42 — the
fifteen `superpowers-*` skills under `brain/agent_skills/`, the six
`superpowers_*` orchestrator templates under `brain/orchestrator/templates/`,
the `brain/superpowers_bootstrap.py` session bootstrap, the sub-agent prompt
templates (`implementer-prompt.md`, `task-reviewer-prompt.md`,
`re-review-prompt.md`, `code-reviewer.md`), and the "Superpowers" entries in
the user template library — is **derived from [obra/superpowers][upstream]
by Jesse Vincent**, MIT © 2025 Jesse Vincent, and was adapted for doomalay
v0.42 by the Doomalay team.

[upstream]: https://github.com/obra/superpowers

The methodology prose — the Iron Laws, the Red Flags and Rationalization
tables, the HARD-GATE, the fix-loop cap and rulings ledger, the four-phase
debugging process, the SDO description rules — is Jesse's, hardened through
his eval process; we kept it essentially intact and only translated the
action vocabulary to doomalay's harness (per the porting approach the
upstream repo itself documents in `docs/porting-to-a-new-harness.md`:
skills name *actions*, never tools, so a port swaps the delivery layer, not
the content).

### What was adapted (harness translation)

- "invoke a skill" → "load a skill" (`agent_skills/*/SKILL.md`, indexed for
  progressive disclosure by `brain/superpowers_bootstrap.py`)
- "dispatch a subagent" → "delegate to a sub-agent turn" (doomalay's
  `delegate` tool)
- "create a todo" → "add to the plan checklist"
- specs/plans/ledgers (`docs/superpowers/specs/…`, `docs/superpowers/plans/…`,
  `.superpowers/sdd/<plan>/progress.md`) stay as relative paths inside the
  per-session workspace
- harness-specific plumbing (`.claude/`, hooks.json, session-start hook
  shapes, marketplace manifests, the SDD shell scripts) is replaced by
  doomalay equivalents: the bootstrap string, the orchestrator stage
  pipeline, and plain workspace files
- the session-start hook that upstream injects on startup|clear|compact is
  `get_bootstrap_prompt()` — re-inject it after every context compaction

### License

Upstream is MIT licensed; the full license text is preserved verbatim at
[`docs/licenses/superpowers-LICENSE`](licenses/superpowers-LICENSE). In
summary: the software is provided "as is", without warranty of any kind;
permission is granted free of charge to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies, provided the copyright notice
and this permission notice are included in all copies or substantial
portions. The Superpowers port satisfies that notice obligation via this
file and the preserved license text.

## Lucide icon library (doomalay v0.52)

The card icon set shipped in v0.52 — `engine/internal/server/web/icons.js`,
the inline SVG glyphs used by the hub cards' icon column, the collection
bunches, and the publish form's picker — is **derived from
[Lucide][lucide] v1.47.0**, ISC License © 2025 Lucide Contributors.

[lucide]: https://lucide.dev

The glyphs are embedded as inline SVG (stroke `currentColor`, 24×24
viewBox) so the whole set works offline from the single engine binary —
no CDN, no network requests — and every icon follows the app theme for
free. The corpus rows on the user's `doomalay-superpowers` HF dataset
reference the same names (`lightbulb`, `bug`, `map`, `layers`, `flask`,
`shield`, `zap`).

### License

Lucide is ISC licensed; the full license text is preserved verbatim at
[`docs/licenses/lucide-LICENSE`](licenses/lucide-LICENSE). In summary:
permission to use, copy, modify, and distribute the software is granted
free of charge, "as is", without warranty of any kind, provided the
copyright notice and this permission notice appear in all copies.
