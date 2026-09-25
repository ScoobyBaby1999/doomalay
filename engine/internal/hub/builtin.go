// Package hub — builtin.go (v0.58).
//
// ENGINE-SEEDED LIBRARY ITEMS: cards that ship with the app itself rather
// than any HF dataset. They ride the same Item model and the same
// Items()/ItemDetail()/Download()/Endorse() paths via the BuiltinRepo
// sentinel repo id — never a real HF round-trip (Go's ServeMux can't match
// an empty {repo} path segment, so builtins carry a repo-shaped id the
// service special-cases before any HF call).
//
// The first builtin is the DEEP RESEARCH template (user spec v0.58 pt 8):
// the engine's flagship pipeline presented as a card in the Template
// Library — red→grey mesh design (my choosing), the full 8-stage
// methodology ported verbatim from brain's "Default Deep Research" as the
// payload, so the detail page's formatted stage view + "use" work exactly
// like any other template.
package hub

import "strings"

// BuiltinRepo is the sentinel repo id every engine builtin carries. It is
// never fetched from, liked, or metric-written — service methods intercept
// it first.
const BuiltinRepo = "doomalay/builtin"

// builtinUpdatedAt anchors the builtins' UpdatedAt (fresh as of the wave).
const builtinUpdatedAt = "2026-09-24T00:00:00Z"

// builtinItems returns the engine-seeded items (all types).
func builtinItems() []Item {
        return []Item{
                {
                        ID:          "deep-research",
                        Type:        "template",
                        Name:        "Deep research",
                        Description: "The app's built-in engine pipeline: multi-round live web search, fetch and read the sources, plan the gaps, synthesize a fully-cited report.",
                        Author:      "doomalay",
                        Repo:        BuiltinRepo,
                        Tags:        []string{"research", "citations", "web"},
                        UpdatedAt:   builtinUpdatedAt,
                        Design: Design{
                                Kind:   "gradient",
                                Colors: []string{"#ef4444", "#a1a1aa", "#52525b"}, // red → grey shading, mesh
                                Dir:    "mesh",
                        },
                        Icon:       "compass",
                        StageCount: 8,
                        File:       "builtin://deep-research",
                },
        }
}

// builtinsFor filters the builtins to one library type.
func builtinsFor(typ string) []Item {
        out := make([]Item, 0, 2)
        for _, it := range builtinItems() {
                if it.Type == typ {
                        out = append(out, it)
                }
        }
        return out
}

// itemIsBuiltin reports whether an item IS an engine builtin (the sentinel
// repo). v0.60 pt A.4.
func itemIsBuiltin(item Item) bool { return item.Repo == BuiltinRepo }

// builtinNameKeys returns the normalized name keys of this type's builtins
// — the Items merge skips any scanned/downloaded twin whose name normalizes
// the same (v0.60 pt A.4: the deep-research dupe; builtins win by name).
func builtinNameKeys(typ string) map[string]bool {
        keys := map[string]bool{}
        for _, it := range builtinsFor(typ) {
                keys[normName(it.Name)] = true
        }
        return keys
}

// normName normalizes an item name for dedup: lowercase, letters+digits
// only ("Deep Research" and "deep-research" → "deepresearch").
func normName(s string) string {
        var b strings.Builder
        for _, r := range strings.ToLower(s) {
                if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
                        b.WriteRune(r)
                }
        }
        return b.String()
}

// builtinPayloads is the builtins' in-memory payload store (resolvePayload
// consults it for BuiltinRepo refs).
var builtinPayloads = map[string]string{
        "deep-research": deepResearchPayload,
}

// deepResearchPayload — the 8-stage methodology ported 1:1 from the brain's
// "Default Deep Research" flow template (templates.py), in the same JSON
// shape the hub's other template payloads use.
const deepResearchPayload = `{
  "name": "Deep research",
  "description": "The classic deep-research pipeline: decompose the question, search the live web per sub-question, verify and read the sources, synthesize a fully-cited briefing, then critique the gaps and refine. Best for questions needing fresh, sourced answers.",
  "task_type": "deep_research",
  "task": "deep research briefing",
  "tags": ["research", "web", "citations", "multi-stage"],
  "stages": [
    {"name": "decompose", "role": "planner", "instructions": "Break the prompt into 3-6 specific, researchable sub-questions. Output JSON array: [{\"question\": str, \"why\": str}]. Every sub-question must be answerable from public sources.", "inputs": ["prompt"], "max_tokens": 800},
    {"name": "search_terms", "role": "planner", "instructions": "For each sub-question, propose 2-4 precise web search queries (different phrasings, English + other relevant languages). Output JSON: {\"queries\": [str]}. No duplicates.", "inputs": ["decompose"], "max_tokens": 600},
    {"name": "source_scan", "role": "generator", "instructions": "Using the web search results, list the most authoritative sources per sub-question with a one-line relevance note. Output JSON array: [{\"url\": str, \"title\": str, \"note\": str}]. Prefer primary sources (.gov, .edu, official docs, peer-reviewed). DO NOT invent URLs — if uncertain, OMIT.", "fanout": {"over": "decompose", "max_parallel": 6}, "inputs": ["decompose.{i}", "search_terms"], "max_tokens": 1200},
    {"name": "verification", "role": "verifier", "instructions": "Check the proposed sources against fetched_sources. Drop paywalled, empty, or unreachable ones. Output JSON: {\"verified\": [...], \"dropped\": [...], \"reasons\": {str: str}}.", "inputs": ["source_scan.*", "fetched_sources"], "max_tokens": 1000},
    {"name": "synthesis", "role": "generator", "instructions": "Write the research briefing: answer each sub-question in 150-300 words, grounded in the verified sources, citing them as [N]. Begin with '# <answer headline>' followed by '## <sub-question>' sections. NEVER invent citations.", "fanout": {"over": "decompose", "max_parallel": 6}, "inputs": ["prompt", "decompose.{i}", "verification.verified", "fetched_sources"], "max_tokens": 2000},
    {"name": "gap_check", "role": "critiquer", "instructions": "Identify unanswered or weakly-sourced parts of the synthesis. Output a bullet list of concrete gaps (which sub-question, what is missing, what source would fix it) or 'No gaps found'. No praise.", "inputs": ["synthesis.*", "verification.verified"], "max_tokens": 600},
    {"name": "refine", "role": "transformer", "instructions": "Patch the gaps flagged by gap_check using fetched_sources. Add a '## Confidence' section rating each sub-question's answer (high/medium/low) with a one-line justification. Return the FULL briefing.", "inputs": ["synthesis.*", "gap_check", "fetched_sources"], "max_tokens": 2500},
    {"name": "assemble", "role": "assembler", "instructions": "Assemble the final answer: the refined briefing followed by '## References' listing exactly the verified sources as [N] Author. \"Title\". Year. URL. Do NOT add new sources.", "inputs": ["refine", "verification.verified"], "max_tokens": 1200}
  ],
  "output_rules": {"format": "markdown", "min_words": 800, "max_words": 4000, "required_sections": ["References", "Confidence"], "banned_phrases": ["clearly", "obviously", "everyone knows", "state-of-the-art"], "tone": "measured, citation-heavy, hedged where sources disagree"}
}
`
