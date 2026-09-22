// Package hfzero carries the Doomalay HF-chat sandbox template: the files
// the engine commits into a user's brand-new Hugging Face Space.
//
// THE PAYWALL HACK (v0.46, verified live 2026-09-22): HF free accounts
// cannot create Docker or Gradio Spaces on cpu-basic (PRO wall) — but they
// CAN create Gradio Spaces on ZeroGPU hardware via
// POST /api/repos/create {type:"space", sdk:"gradio", hardware:"zero-a10g"}.
// The ZeroGPU runtime demands a "@spaces.GPU function detected during
// startup"; that check is satisfied by defining one @spaces.GPU noop and
// firing spaces.zero.client.startup_report() manually from a FastAPI
// lifespan hook (see template/app.py). The space then runs the brain's
// FastAPI on :7860 with the full toolchain of the container (probed live:
// uid 0, Debian 12, Python 3.10, Node 20 + npm, gcc/g++/make/cmake, git).
//
// The brain/ tree embedded here is a synced copy of the repo's brain/
// (make sync-hfzero — excludes tests/, __pycache__/, .venv/, .chat-ws/).
// Syncing (instead of reading the runtime brain dir) keeps the space
// template version-locked to the engine build — a v0.46 engine always
// deploys a v0.46-shaped brain, on desktop AND Android.
package hfzero

import (
        "embed"
        "io/fs"
        "path"
        "sort"
)

//go:embed template/app.py
//go:embed template/requirements.txt
//go:embed template/README.md
var templateFS embed.FS

//go:embed all:brain
var brainFS embed.FS

// File is one file of the space template: repo-relative path + content.
type File struct {
        Path    string
        Content []byte
}

// Files returns the complete manifest for a new Space, sorted by path:
// app.py + requirements.txt + README.md at the root, and the full brain/
// tree under brain/. Used by the engine's commit-API uploader
// (hfspace.go) — one NDJSON commit, batched.
func Files() ([]File, error) {
        var out []File

        // template files at the space root
        for _, name := range []string{"app.py", "requirements.txt", "README.md"} {
                b, err := templateFS.ReadFile("template/" + name)
                if err != nil {
                        return nil, err
                }
                out = append(out, File{Path: name, Content: b})
        }

        // the brain tree under brain/
        err := fs.WalkDir(brainFS, "brain", func(p string, d fs.DirEntry, err error) error {
                if err != nil {
                        return err
                }
                if d.IsDir() {
                        return nil
                }
                b, err := brainFS.ReadFile(p)
                if err != nil {
                        return err
                }
                out = append(out, File{Path: p, Content: b})
                return nil
        })
        if err != nil {
                return nil, err
        }

        sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
        return out, nil
}

// TotalBytes returns the aggregate size of Files() — used by the create
// endpoint to report what it uploaded.
func TotalBytes() (int, error) {
        files, err := Files()
        if err != nil {
                return 0, err
        }
        n := 0
        for _, f := range files {
                n += len(f.Content)
        }
        return n, nil
}

// SanitizeSpaceName coerces a user-supplied space name to a valid HF repo
// name segment: [a-zA-Z0-9-], no leading dash, max 48 chars.
func SanitizeSpaceName(in string) string {
        const max = 48
        out := make([]rune, 0, max)
        for _, r := range in {
                switch {
                case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-':
                        out = append(out, rune(r))
                case r == ' ', r == '_':
                        out = append(out, '-')
                }
                if len(out) == max {
                        break
                }
        }
        // trim leading/trailing dashes
        for len(out) > 0 && out[0] == '-' {
                out = out[1:]
        }
        for len(out) > 0 && out[len(out)-1] == '-' {
                out = out[:len(out)-1]
        }
        return string(out)
}

// SpaceURL converts "user/name" to the direct space URL the engine talks to.
func SpaceURL(repo string) string {
        // https://{owner-lower}-{name-lower}.hf.space — HF's subdomain scheme.
        // Keep the repo's case-insensitive shape; dashes are preserved.
        owner, name, ok := splitRepo(repo)
        if !ok {
                return ""
        }
        return "https://" + lower(owner) + "-" + lower(name) + ".hf.space"
}

// splitRepo splits "user/name" (returns ok=false for anything else).
func splitRepo(repo string) (owner, name string, ok bool) {
        for i := 0; i < len(repo); i++ {
                if repo[i] == '/' {
                        return repo[:i], repo[i+1:], i > 0 && i+1 < len(repo)
                }
        }
        return "", "", false
}

func lower(s string) string {
        b := []byte(s)
        for i := range b {
                if b[i] >= 'A' && b[i] <= 'Z' {
                        b[i] += 'a' - 'A'
                }
        }
        return string(b)
}

// IsDoomalaySpaceName reports whether a repo name looks like one of ours
// (used by the ensure/list endpoints to find the user's spaces).
func IsDoomalaySpaceName(name string) bool {
        return hasPrefixFold(name, "doomalay") || hasPrefixFold(name, "doom-")
}

func hasPrefixFold(s, prefix string) bool {
        return len(s) >= len(prefix) && lower(s[:len(prefix)]) == prefix
}

var _ = path.Join // keep path import if future edits need it
