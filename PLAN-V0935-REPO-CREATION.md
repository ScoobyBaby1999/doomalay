# PLAN-V093.5 — THE REPO-CREATION WAVE (P5 of the red-team batch)

Owner: this session's agent (the parallel bot rode v0.93.1–.3; P4 web-polish
is theirs — no file overlap with this wave beyond workspace.js create-form
regions they don't touch).

## THE LIVE FINDINGS (research-verified, /home/z/my-project/scripts/research-p5/)

- GitHub `GET /licenses` returns **13 entries** `{key,name,spdx_id,url}` —
  one unauthenticated call, no pagination. We render bare keys ("mit") with
  no names — and worse, `wireCreateForm` only calls `loadLists()` when
  `accounts[kind].signed_in` is ALREADY true at wire time (async race →
  the user's "license stays none" forever).
- GitHub `GET /gitignore/templates` → **161 real names**; the create API
  (`POST /user/repos` `gitignore_template`) already accepts them — the
  options were real all along, the race just never loaded them.
- HF create-repo: `POST /api/repos/create` `{type: model|dataset|space,
  name, private, sdk(REQUIRED for space: gradio|docker|static), license,
  files[], secrets[], volumes[]}`. Wire names `sdk` + `sleepTimeSeconds`
  (NOT `space_sdk`). 409 = exists, 402 = paid sdk on free account.
- **HF Storage Buckets (2025+)**: a NEW repo type — S3-like, non-versioned,
  mutable object storage on Xet. `POST /api/buckets/{ns}/{name}`,
  `GET /api/buckets/{ns}?search=`. NOT via /api/repos/create.
- HF delete: `DELETE /api/repos/delete {name,organization?,type}`.
- HF commit NDJSON ops: `header{summary}`, `file{path,content,encoding}`,
  `deletedFile{path}` (client-proven — the OpenAPI `deletedEntry` is a spec
  bug), `lfsFile{path,oid,size}`, `deletedFolder{path}`.
- Storage truth: account-level quota (free private 100GB); Space git repos
  ~1GB hard cap; buckets are the "large mutable storage" answer.

## THE FIXES

### E1 · forge: HF delete + honest create (engine/internal/forge/hf.go)
1. `hfDeleteFile` — NDJSON `deletedFile` op on `/commit/{rev}`; Client.
   DeleteFile dispatch += `"hf"`.
2. `hfCreateRepo` upgrade: space→`sdk` param (default static — free on
   every account, the existing brain-side rule), dataset/model→no license
   noise; desc/short_description wiring; 402 (paid sdk) → plain-language
   error naming the free sdks.
3. `hfBucketCreate` + `hfBucketList` (the Xet buckets API) — engine-side
   truth for the type-first form + the workspace tool.

### E2 · server: kind=hf lives (engine/internal/server/workspaces.go)
`handleWorkspaceCreateRepo` host map += `"hf": "huggingface.co"`; the
HostInfo carries HFType from the request (`hf_type` field: model|dataset|
space) so hfCreateRepo creates the RIGHT kind; the workspace row keeps
`meta.hf_type` (connect parity with the URL path). `hostOfKind` (tool path)
+= hf. `handleWorkspaceLicenses`: HF answers an honest "licenses aren't an
HF concept" (HTTP 200 + `licenses:[]` + `note`) instead of ErrUnsupported
noise; same for gitignores.

### E3 · web: the type-first HF create form (web/workspace.js)
- `loadLists` fires on EVERY form open (no signed_in gate); 401 → inline
  "sign in to load the full list" hint (lists still render "none").
- License options render `key — Name` pairs (server returns objects for
  github now; bare strings stay supported).
- HF branch: the form asks FIRST "what do you want to create?" —
  🚀 Space (runs the chat sandbox · sdk gradio|docker|static),
  📊 Dataset (the data bucket), 🤖 Model repo (weights/cards),
  🪣 Storage bucket (S3-like, large mutable files), and device storage
  stays the 4th option in the picker. license/gitignore fields HIDE for
  HF (honest note: "not HF concepts — the Hub has no LICENSE file
  convention; spaces carry an SDK instead"). Space flow shows the SDK
  choice (static preselected: free everywhere); bucket flow is
  name+private only.
- Create success → `refreshPills()` already runs (the workspaces pill
  count +N — the user's "结果反映到 workspaces pill").

### E4 · the workspace tool (engine/internal/server/workspacetool.go)
`create` action: kind=hf rides the same type-first semantics
(`hf_type` arg: space|dataset|model|bucket + `sdk`); the tool description
teaches the bot it may create HF repos with the connected token
(authorized = the user connected the account) — and says what it made.

### E5 · brain hf tool (brain/tools/dt_hf.py)
`bucket_create` + `buckets` actions (the Xet bucket API via the same
token seam) so the HF chatbot can create EVERY kind on the user's behalf;
HARNESS.md gains one honest line (bucket = large mutable storage, repo =
versioned). The engine embed re-syncs from brain/ (the build copies it).

### E6 · LIVE RED-TEAM (the user's own bar: "必须用 token 实际创建每一种")
With the user's HF token, for EVERY kind (model/dataset/space-static/
bucket): create → verify on the hub (GET the card / bucket list) →
connect as workspace → workspaces pill count → file_delete on HF (the
forge fix) → clean up (delete-repo) EXCEPT one demo of each left for the
user to SEE. GitHub: create with mit + Go gitignore → verify LICENSE +
.gitignore exist → delete. All findings reflected in the commit message.

## GUARDRAILS
- Theme vars only (no brand colors) in the new form chrome; panel/overlay
  surfaces only. Push as v0.93.5 after rebase. Keys never committed.
