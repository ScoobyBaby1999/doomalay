// templatetools.go — v0.44 TEMPLATE SELF-SERVE (the ACTION tools).
//
// USER SPEC (the template pill round): "The template pill should have a
// favorites, method to endorse, method to browse, method to download and
// publish templates" — and the model gets the same BROWSE hand, so it can
// pick a methodology on its own when the user asks for one by name or
// shape ("do this like your deep research", "audit this repo properly").
//
// Two ACTION tools, dispatched from executeAction (chat.go):
//
//	template_list {}                  → the compact library index
//	  (id, name, task_type, stage count) capped at ~2500 chars
//	template_show {"id": "redteam"}   → one full template (stages with
//	  instructions, or the markdown body) capped at ~5000 chars
//
// Both GET the brain's /templates endpoints (the SAME index the engine's
// GET /api/templates proxies for the web sheet — one source of truth).
// The brain URL rides ChatRequest.BrainURL (set by the server; "" on the
// APK or when the brain is down) and the tools degrade HONESTLY: a
// "(template library unavailable …)" observation, never a fabricated
// list. 10s timeout per fetch so a dead brain can't stall a turn.
package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/netx"
)

// templateHTTP is the brain /templates client. 10s (the task spec): the
// index is small and local — anything slower is a dead brain, and the
// turn should get its honest observation and move on.
var templateHTTP = &http.Client{
	Timeout:   10 * time.Second,
	Transport: netx.Transport(),
}

const (
	templateListCap = 2500 // compact index cap (chars)
	templateShowCap = 5000 // one template's full rendering cap (chars)
)

// templateBriefBlock wraps a resolved template brief as the system-prompt
// METHOD TEMPLATE block (the turn pipelines prepend it before the tool
// protocol). The frontend resolves the brief from the library entry, so
// this is pure formatting.
func templateBriefBlock(id, brief string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		id = "custom"
	}
	return "METHOD TEMPLATE — " + id + "\nFollow this template's methodology for this task:\n" + strings.TrimSpace(brief) + "\n"
}

// templateEntry is one library entry from the brain's GET /templates.
// Shapes (brain/server.py builds all three): orchestrator stage-JSONs,
// the superpowers markdown disciplines, and the DEFAULT_TEMPLATES stage
// flows — every one carries id/name/description/task_type/kind plus
// stages[] and/or markdown.
type templateEntry struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	TaskType    string   `json:"task_type"`
	Kind        string   `json:"kind"` // orchestrator | user | flow
	Markdown    string   `json:"markdown"`
	StageCount  int      `json:"stage_count"`
	Tags        []string `json:"tags"`
	Stages      []struct {
		Name         string `json:"name"`
		Role         string `json:"role"`
		Instructions string `json:"instructions"`
		Fanout       *struct {
			Over        string `json:"over"`
			MaxParallel int    `json:"max_parallel"`
		} `json:"fanout"`
	} `json:"stages"`
}

// brainTemplatesUnavailable is the honest observation when the brain URL
// is absent (APK) or the fetch fails (brain down).
func brainTemplatesUnavailable(reason string) string {
	if reason != "" {
		reason = " (" + reason + ")"
	}
	return "OBSERVATION:\n(template library unavailable — the brain service is not running" + reason + ". Tell the user method templates need the brain; answer with your own best methodology in the meantime.)"
}

// fetchBrainTemplates GETs {base}/templates and returns the entry list.
// Localhost brain — no API key. Errors return (nil, err); the caller
// turns them into honest observations.
func fetchBrainTemplates(base string) ([]templateEntry, error) {
	base = strings.TrimRight(strings.TrimSpace(base), "/")
	if base == "" {
		return nil, fmt.Errorf("no brain URL on this request")
	}
	req, err := http.NewRequest("GET", base+"/templates", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := templateHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Templates []templateEntry `json:"templates"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	return parsed.Templates, nil
}

// runTemplateList implements ACTION template_list {}: the compact index.
func runTemplateList(ctx context.Context, req ChatRequest) string {
	entries, err := fetchBrainTemplates(req.BrainURL)
	if err != nil {
		return brainTemplatesUnavailable(err.Error())
	}
	if len(entries) == 0 {
		return "OBSERVATION:\n(the template library is empty — no templates are installed)"
	}
	// Stable order (id), then one line per entry — the model only needs
	// id / name / shape to pick one for template_show.
	sort.SliceStable(entries, func(i, j int) bool {
		return entries[i].ID < entries[j].ID
	})
	var b strings.Builder
	fmt.Fprintf(&b, "OBSERVATION:\ntemplate library — %d templates (pick one, then ACTION: template_show {\"id\": \"...\"} for its methodology):\n", len(entries))
	for _, e := range entries {
		line := "- " + e.ID + " — " + e.Name
		if e.TaskType != "" && e.TaskType != e.ID {
			line += " [" + e.TaskType + "]"
		}
		n := e.StageCount
		if n == 0 {
			n = len(e.Stages)
		}
		if n > 0 {
			line += fmt.Sprintf(" · %d stages", n)
		} else if e.Markdown != "" {
			line += " · markdown discipline"
		}
		b.WriteString(line + "\n")
	}
	return clamp(b.String(), templateListCap)
}

// runTemplateShow implements ACTION template_show {"id"}: one template's
// full methodology (stages with instructions, or the markdown body).
func runTemplateShow(ctx context.Context, req ChatRequest, id string) string {
	id = strings.TrimSpace(id)
	entries, err := fetchBrainTemplates(req.BrainURL)
	if err != nil {
		return brainTemplatesUnavailable(err.Error())
	}
	// Loose id match (the model types hyphens/spaces for underscores —
	// same tolerance dt_template.py gives it).
	norm := func(s string) string {
		return strings.Map(func(r rune) rune {
			if r >= '0' && r <= '9' || r >= 'a' && r <= 'z' {
				return r
			}
			if r >= 'A' && r <= 'Z' {
				return r + 32
			}
			return -1
		}, s)
	}
	var found *templateEntry
	for i := range entries {
		if norm(entries[i].ID) == norm(id) {
			found = &entries[i]
			break
		}
	}
	if found == nil {
		return "OBSERVATION:\nerror: template \"" + id + "\" not found. Run template_list for the available ids."
	}
	e := found
	var b strings.Builder
	b.WriteString("OBSERVATION:\n# " + e.Name)
	if e.TaskType != "" {
		b.WriteString(" (" + e.TaskType)
		if e.Kind != "" {
			b.WriteString(", " + e.Kind)
		}
		b.WriteString(")")
	}
	b.WriteString("\n")
	if e.Description != "" {
		b.WriteString(e.Description + "\n\n")
	}
	if len(e.Stages) > 0 {
		for i, st := range e.Stages {
			fmt.Fprintf(&b, "## Stage %d — %s", i+1, st.Name)
			if st.Role != "" {
				b.WriteString(" [" + st.Role + "]")
			}
			b.WriteString("\n")
			if st.Fanout != nil {
				over := st.Fanout.Over
				if over == "" {
					over = "items"
				}
				fmt.Fprintf(&b, "(fan-out over %s, max %d parallel)\n", over, st.Fanout.MaxParallel)
			}
			if st.Instructions != "" {
				b.WriteString(st.Instructions + "\n\n")
			}
		}
	} else if e.Markdown != "" {
		b.WriteString(e.Markdown)
	} else {
		b.WriteString("(no stages and no markdown body — this template only carries metadata)\n")
	}
	return clamp(b.String(), templateShowCap)
}
