# PLAN-KRONOS-BUNDLE — porting shiyu-coder/Kronos into the public library as a bundle

> Status: the plan, researched and verified against the live repo + the hub's
> actual machinery (v0.87.2 code). The port lands in phases v0.88.1+; this
> document is the contract they follow. Research wave: v0.88 (user spec:
> "please port Kronos in it's entirety to the public lib like how we
> mentioned, u don't have to worry about integrating the model but later we
> can have it so that the bot can setup the model for the user using a docs
> or script or whatever where the user can select which Kronos to use.

## 0. THE ONE LAW (and its one exception)

**The default app ships ZERO Kronos-specific code, strings, files or
art.** Everything Kronos enters the app ONLY when the user downloads the
bundle from the public library, and deleting the bundle removes every
trace of it (the hub's delete-your-copy semantics — SQLite rows, the
localStorage copies, the download registry). No `builtinBunchDesigns`
entry, no workflow block gated on the id, no vendored weights. The bundle
gets the DEFAULT bunch card art (which rides the theme system anyway —
the zero-hardcoded-colors law).

**The one exception — the model weights.** Weights can never ride the hub
(payload caps: 64KB primary, 64KB×20 companions, 8MB read; NeoQuasar
weights are 4.1M–102.3M params). Weight acquisition is the job of the
GENERIC local-model method (`localmodels.js` + `/api/local-models` +
the Ollama resolution path in `catalog.go`), which exists as a stub/UI
today, survives bundle deletion, and contains zero Kronos strings. The
Kronos skills TEACH the bot/user to fetch weights from the NeoQuasar HF
repos (mini/small/base + tokenizers) — that's docs, not integration.
Later (the user's "later"): the bot can offer to run that setup for the
user via its docs/scripts — no app changes required for that story,
which is exactly why it's safe to defer.

## 1. WHAT KRONOS IS (verified against the live repo, 2026-10)

- **shiyu-coder/Kronos** — "A Foundation Model for the Language of
  Financial Markets", MIT license, 92 files, ~9.5MB tree, master branch.
- The first open-source K-line foundation model: a two-stage framework —
  a tokenizer quantizing OHLCV K-lines into hierarchical discrete tokens,
  an autoregressive Transformer pre-trained on those tokens. AAAI 2026;
  paper arXiv:2508.02739; authors Yu Shi, Zongliang Fu, Shuo Chen, Bohan
  Zhao, Wei Xu, Changshui Zhang, Jian Li.
- **Model zoo** (all on HF, none of them ours): Kronos-mini (4.1M,
  ctx 2048, Tokenizer-2k), Kronos-small (24.7M, ctx 512, Tokenizer-base),
  Kronos-base (102.3M, ctx 512, Tokenizer-base). Kronos-large unreleased.
- **Repo inventory** (the port's raw material):
  - `model/` — `kronos.py` (30KB: KronosTokenizer, Kronos, KronosPredictor),
    `module.py` (23KB), `__init__.py` (412B — upstream has a typo in
    `get_model_class`; ports mirror VERBATIM, we never "fix" upstream).
  - `examples/` — 11 runnable scripts (prediction, batch, akshare fetch,
    CN-markets day, GUI, backtest, yuce/historical_backtest) + 4 sample
    JSON reports + 4 output PNGs (800–960KB each).
  - `finetune/` — the Qlib pipeline (config, dataset, qlib preprocess,
    qlib_test, train_tokenizer, train_predictor, utils/).
  - `finetune_csv/` — the CSV pipeline (config_loader + yaml config +
    finetune_base_model/finetune_tokenizer/train_sequential + 5.8MB
    sample CSV + README/README_CN).
  - `tests/` — the regression suite (generate_regression_output.py +
    regression_input.csv 148KB + two output CSVs + the pytest).
  - `webui/` — a Flask app (app.py 30KB, run.py, start.sh,
    templates/index.html 46KB, requirements, 30 sample result JSONs).
  - `figures/` — logo/overview/backtest/prediction PNGs.
  - Root: README.md (16.6KB), LICENSE (MIT), requirements.txt (129B),
    .gitignore.
- **Dependencies** (requirements.txt): numpy, pandas, torch>=2.0,
  einops==0.8.1, huggingface_hub==0.33.1, matplotlib, tqdm, safetensors
  (+ flask/plotly for the webui). Python 3.10+.
- **Data shape**: OHLCV CSVs with timestamps (`open, high, low, close`
  required; `volume, amount` optional), ≤512 context (lookback ≤512 for
  small/base, 2048 for mini), sources per the examples: akshare (CN
  markets), yfinance/ccxt (the get_data scripts), or any CSV.

## 2. THE PORT SHAPE (the superpowers precedent, adapted)

The hub already has everything this port needs — **zero engine changes**:

- **Types** (hub.go registry): `skill` (.md payloads, browsable + bot
  loadable), `doc` (.md, hidden — bundled + bot-served), `script` (.sh
  payloads, browsable). Companion-file whitelist already includes
  `.py`, `.yaml`, `.csv`, `.html`, `.json`, `.txt` (≤64KB × ≤20/item).
- **Discovery** (3 channels): the dataset name `doomalay-kronos` matches
  the `doomalay-` name search (the same channel that found the
  superpowers corpus — v0.48).
- **Scan**: hub-native `items/index.json` is authoritative; items carry
  their own type; `file` points at the mirrored TREE path (the repo view
  shows the real upstream tree, file rows open hub cards).
- **Bundles**: every item carries `collection: "kronos-shiyu"` → the
  Collections aggregator builds the bunch; `collections/kronos-shiyu.json`
  in the dataset is the editorial manifest (description + upstream + by).
- **The bot**: the `hublib` ACTION tool already covers
  search/get/download/bundles/bundle/download_bundle for skill+doc+script
  types — the bot can pull the whole bundle itself, read the skills,
  read companion code via `skills files/read`, and (per the standing
  plan) later RUN the setup through its brain workspace.

**The bundle's members** (10 items, all collection `kronos-shiyu`):

| id | type | payload (tree path) | companions |
|---|---|---|---|
| kronos | skill | skills/kronos/SKILL.md (umbrella: what it is, install, model zoo, quickstart) | model/kronos.py, model/module.py, model/__init__.py, requirements.txt |
| kronos-predict | skill | skills/kronos-predict/SKILL.md (the KronosPredictor flow, batch, sampling) | examples/prediction_example.py, prediction_wo_vol_example.py, prediction_batch_example.py, prediction_cn_markets_day.py, prediction_akshare_2024-2025.py, prediction_new.py, prediction_new_GUI.py |
| kronos-data | skill | skills/kronos-data/SKILL.md (akshare/yfinance/ccxt acquisition, CSV shape) | examples/get_akshare_date_2024-2025_x.py, get_date_new.py |
| kronos-backtest | skill | skills/kronos-backtest/SKILL.md (backtests + the yuce pipeline) | examples/run_backtest_kronos.py, examples/yuce/historical_backtest.py |
| kronos-finetune | skill | skills/kronos-finetune/SKILL.md (Qlib + CSV pipelines, 4 steps) | finetune/*.py (8), finetune_csv/*.py (4), finetune_csv/configs/*.yaml |
| kronos-webui | skill | skills/kronos-webui/SKILL.md (the Flask UI) | webui/app.py, run.py, start.sh, requirements.txt, templates/index.html |
| kronos-readme | doc | README.md (1:1 upstream) | — |
| kronos-finetune-csv-readme | doc | finetune_csv/README.md (1:1) | — |
| kronos-finetune-csv-readme-cn | doc | finetune_csv/README_CN.md (1:1) | — |
| kronos-webui-readme | doc | webui/README.md (1:1) | — |

The companion counts stay ≤20 per item (finetune carries 13); the largest
companion is 65.4KB... just OVER the 64KB cap — `prediction_new_GUI.py`
rides as a TREE file (repo-view browsable, full-read via the repo file
route, 8MB cap) but NOT as a listed companion; the predict skill points
at its tree path. Every non-PNG/JR-artifact file mirrors into the tree;
the heavy sample outputs (yuce PNGs, webui result JSONs, figures) mirror
too — the dataset can carry them (all <10MB, plain git commits — HF's
LFS threshold), the repo view shows the true upstream shape, and the
5.8MB sample CSV stays readable (<8MB read cap).

**Credit everywhere**: `upstream: "shiyu-coder/Kronos — Yu Shi et al.
(AAAI 2026), MIT"` on every item (the bylines read "by ScoobyBaby1999 —
ported from shiyu-coder/Kronos"); `docs/licenses/kronos-LICENSE`
vendored (the superpowers-LICENSE precedent); the icon
`file:assets/kronos.svg` (a candlestick motif SVG that ships IN the
dataset — never in the app).

## 3. THE PHASES

- **K1 — tools/kronos-corpus.py** (v0.88.1): the generator, modeled on
  tools/superpowers-corpus.py: fetches the upstream tarball (GitHub, no
  auth needed for the public repo), mirrors the tree byte-exact, builds
  the SKILL.md payloads (the methodology wrappers, quoting upstream docs
  verbatim wherever possible), writes items/index.json + per-item metas +
  the collection manifest + the icon, creates the dataset repo if missing
  (`POST /api/repos/create` type=dataset — the one thing the superpowers
  script never needed), commits in CHUNKS (tree files split across
  commits so no single NDJSON body balloons; then the index/metas/
  manifest). Idempotent re-runs; `--dry` prints the plan.
- **K2 — populate + live verify** (v0.88.2): run the generator with the
  HF token → `ScoobyBaby1999/doomalay-kronos` exists for real. Then the
  LIVE rig (scripts/v088-kronos-live-test.sh): boot the real engine, hit
  the real hub — discovery lists the kronos items in the Skill/Doc/Script
  libraries, the Collections view shows the kronos-shiyu bunch with the
  manifest description + the ported-from byline, the bundle download
  lands all 10 items locally (SSE phases run), the bot-side hublib
  search/get returns the real payloads, delete removes every row + the
  "downloaded" state resets. Zero Kronos strings in the app itself
  (grep-proof).
- **K3 — the bot story** (v0.88.3): a chat with the bundle applied (the
  Use handshake) + `ACTION: hublib` — search kronos, load the kronos
  skill, files/read the model code; the SKILL.md payloads teach the full
  local path (venv, pip install -r requirements.txt, weights via
  NeoQuasar/Kronos-*, prediction via KronosPredictor) so the LATER
  "bot sets it up for the user" wave needs no app changes. Redteam the
  wording (never auto-run, never silent-download weights, credit shown).
- **K4 — final** (v0.89.0): the full rig sweep + the visual pass on the
  bundle card (default art, theme-true) + push.

## 4. WHY THIS IS SAFE (the redteam up front)

- **Licensing**: MIT (upstream) — mirroring + re-serving with credit is
  exactly the superpowers precedent (obra, MIT). LICENSE vendored;
  CREDITS.md gains the Kronos line (repo-side, not app-side).
- **No code execution**: hub bundle content is DATA — scripts are
  reference-read, never executed by the app. The only Python execution
  in the whole system is the brain's own sandboxed subprocess (its
  workspace, its tooling) — a LATER story, opt-in, user-visible.
- **No payload-cap violations**: listed companions ≤64KB; the one
  65.4KB file stays tree-only; weights never ride.
- **No app bloat**: 10 items, ~200KB of .md payloads total; the heavy
  tree stays remote (repo-view fetches on demand, 10-min scan cache).
- **Delete restores everything**: hub DeleteCollection removes every
  member row + hearts; "Yours" copies cleared — verified by the rig.
