#!/usr/bin/env python3
"""kronos-corpus.py — the shiyu-coder/Kronos corpus generator (v0.88.3).

Ports Kronos — "A Foundation Model for the Language of Financial Markets"
(shiyu-coder/Kronos, MIT, AAAI 2026 — Yu Shi et al.) — INTO the doomalay
public library as the bundle `kronos-shiyu`, exactly the way the
superpowers corpus was ported (tools/superpowers-corpus.py precedent):

  · the ENTIRE upstream tree mirrors into the HF dataset
    ScoobyBaby1999/doomalay-kronos (byte-exact — every .py, README,
    yaml, csv, html, the figures and sample data; the repo view shows
    the REAL upstream shape);
  · hub-native items/index.json is GENERATED (the scan path's
    authoritative layout — every item carries its own type):
      - 6 SKILL items — methodology wrappers (SKILL.md payloads) with
        the upstream code as COMPANION files (≤20 each, ≤64KB each;
        the one 65.4KB file — examples/prediction_new_GUI.py — stays a
        TREE file, pointed at by its skill, never a listed companion);
      - 4 DOC items — the upstream READMEs, payloads 1:1;
  · every item carries the upstream credit
    (upstream="shiyu-coder/Kronos — Yu Shi et al. (AAAI 2026), MIT"),
    the icon "file:assets/kronos.svg" (a candlestick motif that lives
    IN the dataset — never in the app) and collection "kronos-shiyu";
  · collections/kronos-shiyu.json — the bundle's editorial manifest
    (description + upstream + by);
  · MODEL WEIGHTS NEVER RIDE (the hub's caps forbid them anyway) —
    the skills TEACH fetching them from the NeoQuasar HF repos; the
    generic local-model method stays the app's only weights path
    (PLAN-KRONOS-BUNDLE.md's ONE LAW: zero Kronos strings in the app).

THE ONE LAW (PLAN-KRONOS-BUNDLE.md §0): the default app ships ZERO
Kronos-specific code, strings, files or art. Everything Kronos enters
ONLY through this dataset; deleting the bundle removes every trace.

Usage:
  python3 tools/kronos-corpus.py --token hf_... [--repo ScoobyBaby1999/doomalay-kronos]
                                [--upstream /tmp/kronos-upstream]
                                [--upstream-ref master] [--dry]

The token needs write access to the dataset. --dry prints the plan
without committing. The dataset is CREATED if missing (the one thing
the superpowers script never needed — that repo predates this tool).
Idempotent: re-running refreshes the tree + rewrites the metas.
"""
import argparse
import base64
import hashlib
import json
import os
import sys
import tarfile
import urllib.request
from pathlib import Path

API = "https://huggingface.co"
UPSTREAM_REPO = "shiyu-coder/Kronos"
UPSTREAM_CREDIT = "shiyu-coder/Kronos — Yu Shi et al. (AAAI 2026), MIT"
COLLECTION = "kronos-shiyu"
# the item meta bakes the full field set the hub's Item struct reads
# (description/author/repo/tags/createdAt — the live superpowers index
# shape); the v0.88.4 engine fix stamps Repo from the scan card too, but
# baked fields keep older engines honest.
import datetime as _dt
CREATED_AT = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
REPO = "ScoobyBaby1999/doomalay-kronos"
ICON = "file:assets/kronos.svg"
# the file the hub must never list as a companion (65.4KB > the 64KB cap) —
# it still mirrors into the TREE (repo-view browsable, full-read via the
# repo file route's 8MB cap)
TREE_ONLY = {"examples/prediction_new_GUI.py"}
# binary/heavy artifacts mirror into the tree but never ride companions
COMPANION_EXTS = {".py", ".yaml", ".yml", ".md", ".txt", ".sh", ".json",
                  ".csv", ".html", ".css", ".js", ".ts", ".toml", ".svg"}

COLLECTION_MANIFEST = {
    "description": (
        "Kronos — the first open-source foundation model for financial "
        "K-lines (candlesticks): a tokenizer + autoregressive transformer "
        "pre-trained on OHLCV sequences from 45+ global exchanges. "
        "Prediction, batch forecasting, backtesting, Qlib + CSV finetuning "
        "and a Flask web UI — the complete methodology plus the full "
        "upstream code tree. Ported 1:1 from shiyu-coder/Kronos (MIT, "
        "AAAI 2026, Yu Shi et al.); the port and this listing are "
        "maintained by ScoobyBaby1999. Weights fetch from the NeoQuasar "
        "HF repos (mini / small / base + tokenizers) — they never ride "
        "the hub."
    ),
    "upstream": "shiyu-coder/Kronos by Yu Shi et al. (AAAI 2026)",
    "by": "ScoobyBaby1999",
}

# ── the item id (the hub's slug rule: kebab + 6-hex of sha256(slug\0author)) ──
def item_id(slug, author="ScoobyBaby1999"):
    h = hashlib.sha256((slug + "\0" + author).encode()).hexdigest()
    return slug + "-" + h[:6]


# ── the SKILL.md payloads (the doomalay-native methodology wrappers) ────────
SKILL_INTRO = """# {title}

> {tagline}
>
> Part of the **Kronos** bundle — ported 1:1 from
> [shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos) (MIT,
> AAAI 2026, Yu Shi et al.). This skill is the methodology wrapper; the
> COMPLETE upstream code tree ships beside it (repo view) and the files
> listed below ride as this skill's companions.

{body}

## Weights (never in the bundle — fetched from Hugging Face)

| Model | Tokenizer | Context | Params | Weights |
|---|---|---|---|---|
| Kronos-mini | Kronos-Tokenizer-2k | 2048 | 4.1M | [NeoQuasar/Kronos-mini](https://huggingface.co/NeoQuasar/Kronos-mini) |
| Kronos-small | Kronos-Tokenizer-base | 512 | 24.7M | [NeoQuasar/Kronos-small](https://huggingface.co/NeoQuasar/Kronos-small) |
| Kronos-base | Kronos-Tokenizer-base | 512 | 102.3M | [NeoQuasar/Kronos-base](https://huggingface.co/NeoQuasar/Kronos-base) |

Tokenizer weights: [Kronos-Tokenizer-2k](https://huggingface.co/NeoQuasar/Kronos-Tokenizer-2k) ·
[Kronos-Tokenizer-base](https://huggingface.co/NeoQuasar/Kronos-Tokenizer-base).

## The environment (the local setup the app's local-model method owns)

```shell
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt     # numpy pandas torch einops huggingface_hub matplotlib tqdm safetensors
```

{setup}

## Citation

```bibtex
@misc{{shi2025kronos,
      title={{Kronos: A Foundation Model for the Language of Financial Markets}},
      author={{Yu Shi and Zongliang Fu and Shuo Chen and Bohan Zhao and Wei Xu and Changshui Zhang and Jian Li}},
      year={{2025}},
      eprint={{2508.02739}},
      archivePrefix={{arXiv}},
      primaryClass={{q-fin.ST}},
}}
```

MIT — see the LICENSE file in the repo view.
"""

SKILLS = [
    {
        "slug": "kronos",
        "name": "Kronos",
        "desc": "The K-line foundation model — install, weights, the KronosPredictor quickstart",
        "tagline": "The first open-source foundation model for financial candlesticks.",
        "companions": ["model/__init__.py", "model/kronos.py", "model/module.py",
                       "requirements.txt"],
        "setup": "Place the mirrored `model/` package beside your script (or add the repo root to `sys.path`), then `from model import Kronos, KronosTokenizer, KronosPredictor`.",
        "body": """## What Kronos is

Kronos is a family of decoder-only foundation models pre-trained on the
"language" of financial markets: K-line (OHLCV candlestick) sequences.
A specialized **tokenizer** first quantizes continuous multi-dimensional
K-line data into hierarchical discrete tokens; a large autoregressive
**transformer** is pre-trained on those tokens, serving as one unified
model for diverse quantitative tasks (forecasting, classification,
representation).

## The quickstart (from the upstream README, verified)

```python
from model import Kronos, KronosTokenizer, KronosPredictor

tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
model = Kronos.from_pretrained("NeoQuasar/Kronos-small")
predictor = KronosPredictor(model, tokenizer, max_context=512)
```

Data shape: a pandas DataFrame with columns `['open', 'high', 'low',
'close']` (required) + `volume` / `amount` (optional), a timestamp
Series, and a future-timestamp Series for the forecast horizon.
`lookback` must stay within the model's context (512 for small/base,
2048 for mini).

```python
pred_df = predictor.predict(df=x_df, x_timestamp=x_ts, y_timestamp=y_ts,
                            pred_len=pred_len, T=1.0, top_p=0.9, sample_count=1)
```

`predict` returns a DataFrame of forecasted `open/high/low/close/
volume/amount` rows indexed by the y timestamps. `predict_batch` runs
many series in parallel (all series must share lookback + pred_len).""",
    },
    {
        "slug": "kronos-predict",
        "name": "Kronos prediction",
        "desc": "Forecasting workflows — single, batch, no-volume, CN markets, the GUI",
        "tagline": "From raw OHLCV to forecasted candles in a few lines.",
        "companions": ["examples/prediction_example.py",
                       "examples/prediction_wo_vol_example.py",
                       "examples/prediction_batch_example.py",
                       "examples/prediction_cn_markets_day.py",
                       "examples/prediction_akshare_2024-2025.py",
                       "examples/prediction_new.py"],
        "setup": "The prediction scripts expect the `model/` package importable and pandas installed; data comes from the acquisition scripts (kronos-data) or any OHLCV CSV.",
        "body": """## The workflows

- **prediction_example.py** — the canonical single-series forecast with
  ground-truth comparison + matplotlib plot.
- **prediction_wo_vol_example.py** — volume/amount-less forecasting
  (the predictor zero-fills them).
- **prediction_batch_example.py** — parallel multi-series forecasting
  (`predict_batch`: equal lookbacks + equal pred_lens; GPU parallelism;
  per-series normalization).
- **prediction_cn_markets_day.py** — Chinese A-share daily bars via
  akshare.
- **prediction_akshare_2024-2025.py** — the 2024-2025 akshare fetch +
  predict pipeline.
- **prediction_new.py** — the extended pipeline (windows, metrics,
  richer output).
- **prediction_new_GUI.py** — the GUI variant (65KB — read it from the
  repo view's tree; it is deliberately NOT a listed companion).

All companions ride this skill — load them with
`ACTION: skills {"action":"files","skill":"kronos-predict"}` or browse
the repo view.""",
    },
    {
        "slug": "kronos-data",
        "name": "Kronos data acquisition",
        "desc": "OHLCV acquisition — akshare (CN markets) + the general fetchers",
        "tagline": "Get the K-lines: akshare pipelines and CSV shapes.",
        "companions": ["examples/get_akshare_date_2024-2025_x.py",
                       "examples/get_date_new.py"],
        "setup": "The akshare scripts need `pip install akshare`; any OHLCV CSV with open/high/low/close (+ optional volume, amount) + timestamps works.",
        "body": """## The data contract

Kronos eats OHLCV candles: a DataFrame with `['open', 'high', 'low',
'close']` required; `volume` and `amount` optional (zero-filled when
absent). Timestamps ride a separate Series. Context is capped at the
model's `max_context` (512 for small/base, 2048 for mini).

## The fetchers

- **get_akshare_date_2024-2025_x.py** — the Chinese A-share daily
  pipeline (akshare, 2024-2025 window).
- **get_date_new.py** — the general fetcher.

CSV shape (the finetune_csv sample rides the repo view:
`finetune_csv/data/HK_ali_09988_kline_5min_all.csv`).""",
    },
    {
        "slug": "kronos-backtest",
        "name": "Kronos backtesting",
        "desc": "Strategy evaluation — the run_backtest pipeline + the yuce historical backtest",
        "tagline": "Evaluate forecast signals against history.",
        "companions": ["examples/run_backtest_kronos.py",
                       "examples/yuce/historical_backtest.py"],
        "setup": "Backtests need the model + tokenizer weights downloaded and the example data (the yuce sample JSONs mirror in the repo view).",
        "body": """## The pipelines

- **run_backtest_kronos.py** — the upstream backtest harness over
  Kronos forecasts.
- **yuce/historical_backtest.py** — the historical prediction +
  evaluation pipeline (comprehensive analysis reports, optimized
  prediction plots — sample outputs ride the repo view under
  `examples/yuce/`).

Upstream's own disclaimer (verbatim intent): these pipelines are a
DEMONSTRATION — not a production trading system. Real strategies need
portfolio optimization, risk-factor neutralization, transaction-cost
modeling.""",
    },
    {
        "slug": "kronos-finetune",
        "name": "Kronos finetuning",
        "desc": "Adapt Kronos to your own data — the Qlib pipeline + the CSV pipeline",
        "tagline": "Tokenizer + predictor finetuning on your own K-lines.",
        "companions": ["finetune/config.py", "finetune/dataset.py",
                       "finetune/qlib_data_preprocess.py", "finetune/qlib_test.py",
                       "finetune/train_predictor.py", "finetune/train_tokenizer.py",
                       "finetune/utils/__init__.py", "finetune/utils/training_utils.py",
                       "finetune_csv/config_loader.py", "finetune_csv/finetune_base_model.py",
                       "finetune_csv/finetune_tokenizer.py", "finetune_csv/train_sequential.py",
                       "finetune_csv/configs/config_ali09988_candle-5min.yaml"],
        "setup": "The Qlib path needs `pip install pyqlib` + a local Qlib data dir; the CSV path reads plain OHLCV CSVs. Both ride torchrun for multi-GPU.",
        "body": """## The two pipelines

**Qlib** (the A-share demonstration): configure `finetune/config.py`
(paths, instrument, time ranges, epochs) → `finetune/qlib_data_preprocess.py`
(pickle splits) → `torchrun --standalone --nproc_per_node=N
finetune/train_tokenizer.py` → `torchrun ... finetune/train_predictor.py`
→ `finetune/qlib_test.py --device cuda:0` (top-K strategy backtest).

**CSV** (the general path): `finetune_csv/config_loader.py` + the yaml
config (one rides as a companion; the sample 5-min Alibaba HK dataset
mirrors under `finetune_csv/data/`) → `finetune_base_model.py` /
`finetune_tokenizer.py` / `train_sequential.py`.

Upstream notes many `finetune/` comments are AI-generated
explanations — treat the code as the source of truth (their README,
verbatim intent).""",
    },
    {
        "slug": "kronos-webui",
        "name": "Kronos web UI",
        "desc": "The Flask prediction UI — run, serve, browse results",
        "tagline": "A local web UI for Kronos forecasts.",
        "companions": ["webui/app.py", "webui/run.py", "webui/start.sh",
                       "webui/requirements.txt", "webui/templates/index.html"],
        "setup": "webui needs `pip install flask flask-cors plotly` (webui/requirements.txt); run with `python webui/run.py` or `bash webui/start.sh`.",
        "body": """## The UI

A Flask app (`webui/app.py`) serving a plotly-based forecasting UI
(`webui/templates/index.html`) over the Kronos predictor. Sample
prediction outputs mirror under `webui/prediction_results/` in the
repo view. The README (a doc item in this bundle) covers the launch
steps.""",
    },
]

DOCS = [
    {"slug": "kronos-readme", "name": "Kronos README", "file": "README.md",
     "desc": "The upstream README — model zoo, quickstart, finetuning guide (1:1)"},
    {"slug": "kronos-finetune-csv-readme", "name": "Kronos CSV finetune README",
     "file": "finetune_csv/README.md", "desc": "The CSV finetuning guide (1:1)"},
    {"slug": "kronos-finetune-csv-readme-cn", "name": "Kronos CSV finetune README (中文)",
     "file": "finetune_csv/README_CN.md", "desc": "The CSV finetuning guide, Chinese (1:1)"},
    {"slug": "kronos-webui-readme", "name": "Kronos web UI README",
     "file": "webui/README.md", "desc": "The Flask UI guide (1:1)"},
]

# the icon — a candlestick motif (currentColor-friendly strokes so it
# follows whatever surface renders it; it lives IN the dataset, never app-side)
KRONOS_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none"
  stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
  <title>Kronos — the K-line foundation model</title>
  <path d="M14 8v6"/><path d="M14 22v6"/>
  <rect x="10" y="14" width="8" height="8" rx="1.5" fill="currentColor" fill-opacity="0.25"/>
  <path d="M32 12v8"/><path d="M32 30v8"/>
  <rect x="28" y="20" width="8" height="10" rx="1.5" fill="currentColor" fill-opacity="0.25"/>
  <path d="M6 42h36" stroke-opacity="0.45"/>
</svg>
"""


def hf_get(token, url):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    return urllib.request.urlopen(req).read()


def ensure_dataset(token, repo):
    try:
        hf_api(token, f"{API}/api/datasets/{repo}")
        print(f"dataset exists: {repo}")
        return
    except Exception:
        pass
    owner, name = repo.split("/", 1)
    hf_api(token, f"{API}/api/repos/create",
           data=json.dumps({"type": "dataset", "name": name, "owner": owner,
                            "private": False}).encode())
    print(f"dataset CREATED: {repo}")


def fetch_upstream(dest: Path, ref: str):
    """Fetch the upstream tarball (public repo, no auth) + extract."""
    if (dest / "model" / "kronos.py").is_file():
        print(f"upstream checkout present: {dest}")
        return
    dest.mkdir(parents=True, exist_ok=True)
    url = f"https://codeload.github.com/{UPSTREAM_REPO}/tar.gz/refs/heads/{ref}"
    tgz = dest.parent / "kronos-upstream.tgz"
    print(f"fetching {url} …")
    urllib.request.urlretrieve(url, tgz)
    with tarfile.open(tgz) as tf:
        tf.extractall(dest.parent)
    # the archive extracts to Kronos-<ref>/ — flatten into dest
    extracted = dest.parent / f"Kronos-{ref}"
    if not extracted.is_dir():
        cands = [p for p in dest.parent.iterdir() if p.is_dir() and p.name.startswith("Kronos-")]
        if not cands:
            sys.exit("could not find the extracted upstream tree")
        extracted = cands[0]
    for p in extracted.iterdir():
        os.rename(p, dest / p.name)
    extracted.rmdir()
    print(f"upstream extracted: {dest}")


def mirror_tree(up: Path):
    """The full byte-exact tree (minus .git) with sizes."""
    out = {}
    for p in sorted(up.rglob("*")):
        if p.is_file() and ".git/" not in p.relative_to(up).as_posix():
            rel = p.relative_to(up).as_posix()
            out[rel] = p.read_bytes()
    return out


def build_items(tree):
    """The hub-native index: 6 skills + 4 docs, all collection kronos-shiyu."""
    items = []
    for sk in SKILLS:
        companions = []
        for rel in sk["companions"]:
            if rel not in tree:
                raise SystemExit(f"companion missing from upstream tree: {rel}")
            if len(tree[rel]) > 64 * 1024:
                raise SystemExit(f"companion over the 64KB cap: {rel} ({len(tree[rel])})")
            companions.append(rel)
        payload = SKILL_INTRO.format(title=sk["name"], tagline=sk["tagline"],
                                    body=sk["body"], setup=sk["setup"])
        skill_file = f"skills/{sk['slug']}/SKILL.md"
        items.append({
            "id": item_id(sk["slug"]), "type": "skill", "name": sk["name"],
            "description": sk["desc"], "file": skill_file,
            "author": "ScoobyBaby1999", "repo": REPO,
            "tags": ["kronos", sk["slug"]],
            "icon": ICON, "upstream": UPSTREAM_CREDIT,
            "collection": COLLECTION, "files": companions,
            "createdAt": CREATED_AT,
        })
        tree[skill_file] = payload.encode()
    for doc in DOCS:
        if doc["file"] not in tree:
            raise SystemExit(f"doc payload missing: {doc['file']}")
        items.append({
            "id": item_id(doc["slug"]), "type": "doc", "name": doc["name"],
            "description": doc["desc"], "file": doc["file"],
            "author": "ScoobyBaby1999", "repo": REPO,
            "tags": ["kronos", "readme"],
            "icon": ICON, "upstream": UPSTREAM_CREDIT,
            "collection": COLLECTION, "files": [],
            "createdAt": CREATED_AT,
        })
    return items


def hf_api(token, url, data=None, method=None, ctype="application/json"):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"}, method=method)
    if data is not None:
        req.add_header("Content-Type", ctype)
        req.data = data
    try:
        resp = urllib.request.urlopen(req)
        body = resp.read()
        return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        detail = b""
        try:
            detail = e.read()
        except Exception:
            pass
        raise SystemExit(f"HF API {method or 'GET'} {url.split('huggingface.co')[-1]} -> {e.code}: "
                         f"{detail.decode('utf-8', 'replace')[:400]}")


def preupload_modes(token, repo, files):
    """Per-file uploadMode ('lfs' | 'regular') via the hub preupload API —
    exactly the Go client's flow (hf.go): binary-detected files MUST ride
    the LFS protocol, text files ride the plain base64 commit."""
    modes = {}
    batch = []
    for rel, b in files:
        batch.append({"path": rel, "size": len(b),
                      "sample": base64.b64encode(b[:256]).decode()})
    for i in range(0, len(batch), 32):
        chunk = batch[i:i + 32]
        out = hf_api(token, f"{API}/api/datasets/{repo}/preupload/main",
                     data=json.dumps({"files": chunk}).encode())
        for f in out.get("files", []):
            modes[f["path"]] = f.get("uploadMode", "regular")
    return modes


def upload_lfs(token, repo, files):
    """The classic LFS flow (hf.go's uploadLFS twin): one batch POST with
    transfers=['basic'] -> presigned S3 PUT per object. The commit then
    references each file through a {key:'lfsFile'} op — the bytes NEVER
    ride the commit body."""
    if not files:
        return
    objs, content = [], {}
    for rel, b in files:
        oid = hashlib.sha256(b).hexdigest()
        objs.append({"oid": oid, "size": len(b)})
        content[oid] = (rel, b)
    payload = {"operation": "upload", "transfers": ["basic"],
               "objects": objs, "ref": {"name": "refs/heads/main"}}
    req = urllib.request.Request(
        f"{API}/datasets/{repo}.git/info/lfs/objects/batch",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/vnd.git-lfs+json",
                 "Accept": "application/vnd.git-lfs+json"}, method="POST")
    try:
        batch = json.loads(urllib.request.urlopen(req).read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"lfs batch -> {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")
    for o in batch.get("objects", []):
        act = (o.get("actions") or {}).get("upload")
        if not act or not act.get("href"):
            continue   # already uploaded (idempotent re-runs)
        rel, b = content[o["oid"]]
        rq = urllib.request.Request(act["href"], data=b, method="PUT")
        for k, v in (act.get("header") or {}).items():
            rq.add_header(k, v)
        rq.add_header("Content-Type", "application/octet-stream")
        urllib.request.urlopen(rq)
        print(f"  lfs put: {rel} ({len(b) // 1024} KB)")


def commit_ops(token, repo, tree, items, dry):
    """THE mixed commit: preupload classifies every file — text rides the
    NDJSON base64 ops (chunked ≤4MB), binaries ride LFS (S3 PUTs + lfsFile
    pointer ops, never the body), then the meta commit lands the items
    index + metas + the bundle manifest (+ cleans the API probes)."""
    files = sorted(tree.items())
    modes = {} if dry else preupload_modes(token, repo, files)
    lfs = [(rel, b) for rel, b in files if modes.get(rel) == "lfs"]
    text = [(rel, b) for rel, b in files if modes.get(rel) != "lfs"]
    print(f"classified: {len(text)} text ({sum(len(v) for _, v in text)//1024} KB) "
          f"+ {len(lfs)} lfs ({sum(len(v) for _, v in lfs)//1024} KB)")

    if dry:
        print(f"dry plan: {len(files)} tree files → text commit chunks + {len(lfs)} LFS puts "
              f"+ 1 meta commit ({len(items)} items: "
              f"{[i['type'] for i in items].count('skill')} skills, "
              f"{[i['type'] for i in items].count('doc')} docs)")
        for it in items[:3]:
            print(f"  {it['type']:6} {it['id']}  file={it['file']}  companions={len(it['files'])}")
        print("dry run — no commit")
        return

    if lfs:
        upload_lfs(token, repo, lfs)

    # the text chunks (≤4MB base64 each) + the lfsFile pointers ride one
    # commit per chunk (pointers repeat per chunk commit — idempotent,
    # cheap: ~100 bytes each)
    chunks, cur, cur_bytes = [], [], 0
    for rel, b in text:
        b64len = len(base64.b64encode(b))
        if cur and cur_bytes + b64len > 4 * 1024 * 1024:
            chunks.append(cur); cur, cur_bytes = [], 0
        cur.append((rel, b)); cur_bytes += b64len
    if cur:
        chunks.append(cur)
    for ci, chunk in enumerate(chunks):
        ops = [{"key": "header", "value": {
            "summary": f"kronos corpus: the upstream tree mirror (chunk {ci+1}/{len(chunks)})"}}]
        for rel, b in chunk:
            ops.append({"key": "file", "value": {
                "path": rel, "content": base64.b64encode(b).decode(),
                "encoding": "base64"}})
        for rel, b in lfs:
            ops.append({"key": "lfsFile", "value": {
                "path": rel, "algo": "sha256",
                "oid": hashlib.sha256(b).hexdigest(), "size": len(b)}})
        hf_api(token, f"{API}/api/datasets/{repo}/commit/main",
               data="\n".join(json.dumps(o) for o in ops).encode(),
               ctype="application/x-ndjson")
        print(f"chunk {ci+1}/{len(chunks)} committed ({len(chunk)} text + {len(lfs)} lfs pointers)")

    ops = [{"key": "header", "value": {
        "summary": "kronos corpus: the hub-native items index + metas + the bundle manifest",
        "description": "6 skills (methodology + upstream code companions) + 4 docs (READMEs 1:1), every item credit=shiyu-coder/Kronos (MIT, AAAI 2026), collection kronos-shiyu"}}]
    # the API-probe cleanup — tolerant (idempotent re-runs: already gone)
    for probe in ("probe.txt",):
        try:
            hf_get(token, f"{API}/datasets/{repo}/resolve/main/{probe}")
            ops.append({"key": "deletedFile", "value": {"path": probe}})
        except Exception:
            pass   # already cleaned
    for it in items:
        ops.append({"key": "file", "value": {
            "path": f"items/{it['id']}.json",
            "content": base64.b64encode(json.dumps(it, indent=2).encode()).decode(),
            "encoding": "base64"}})
    ops.append({"key": "file", "value": {
        "path": "items/index.json",
        "content": base64.b64encode(json.dumps(items, indent=2).encode()).decode(),
        "encoding": "base64"}})
    ops.append({"key": "file", "value": {
        "path": f"collections/{COLLECTION}.json",
        "content": base64.b64encode(json.dumps(COLLECTION_MANIFEST, indent=2).encode()).decode(),
        "encoding": "base64"}})
    hf_api(token, f"{API}/api/datasets/{repo}/commit/main",
           data="\n".join(json.dumps(o) for o in ops).encode(),
           ctype="application/x-ndjson")
    print(f"meta commit done: {len(items)} items + index + {COLLECTION} manifest (+ probe cleanup)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="ScoobyBaby1999/doomalay-kronos")
    ap.add_argument("--upstream", default="/tmp/kronos-upstream")
    ap.add_argument("--upstream-ref", default="master")
    ap.add_argument("--token", default=None)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    token = args.token or os.environ.get("DOOMALAY_HF_TOKEN") or os.environ.get("HF_TOKEN")
    if not token:
        sys.exit("no token: pass --token or set DOOMALAY_HF_TOKEN / HF_TOKEN")

    up = Path(args.upstream)
    fetch_upstream(up, args.upstream_ref)
    tree = mirror_tree(up)
    total = sum(len(v) for v in tree.values())
    print(f"tree: {len(tree)} files, {total // 1024} KB "
          f"(largest: {max((len(v), k) for k, v in tree.items())[1]})")

    global REPO
    REPO = args.repo
    items = build_items(tree)
    for it in items:
        comps = it["files"]
        over = [c for c in comps if c in TREE_ONLY]
        assert not over, f"TREE_ONLY file listed as companion: {over}"
    print(f"items: {len(items)} ({len(SKILLS)} skills + {len(DOCS)} docs)")

    if not args.dry:
        ensure_dataset(token, args.repo)
    tree["assets/kronos.svg"] = KRONOS_SVG.encode()
    commit_ops(token, args.repo, tree, items, args.dry)
    print("done.")


if __name__ == "__main__":
    main()
