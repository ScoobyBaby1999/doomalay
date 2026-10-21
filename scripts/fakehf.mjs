#!/usr/bin/env node
// fakehf.mjs — v1.54 THE LIBRARY SHIP: the in-process Hugging Face twin
// for the live walk. Implements the EXACT protocol surface the engine's
// hf.go speaks (verified shapes, the internal/hub mocks' node twin):
//   GET  /api/whoami-v2                       (Bearer goodtoken → mockuser)
//   GET  /api/datasets?filter=|search=|author= (discovery)
//   GET  /api/datasets/{user}/{name}          (repo card; 404 unknown)
//   GET  /datasets/{repo}/resolve/main/{path} (file bytes; 307s the LFS ones)
//   GET  /api/datasets/{repo}/tree/main/{dir} (listing)
//   POST /api/repos/create                    (409 on exists)
//   POST /api/datasets/{repo}/preupload/main  (uploadMode: .png + the
//        repo's own .gitattributes lines → lfs — the v1.54 causality)
//   POST /datasets/{repo}.git/info/lfs/objects/batch (presigned hrefs)
//   PUT  /lfs/{repo}/{oid}                    (the "S3" bucket)
//   POST /api/datasets/{repo}/commit/main     (NDJSON: file + lfsFile)
//   POST|DELETE /api/datasets/{repo}/like
// State: in-memory + a /state debug dump (the walk's assertions).
'use strict';
import http from 'node:http';

const PORT = parseInt(process.argv[2] || '8440', 10);
const repos = new Map();   // repo → { files: Map<path, bytes>, tags: [] }
const lfs = new Map();     // oid → bytes
const commits = [];        // {repo, body} raw NDJSON
const likes = new Map();

function json(w, v) { w.setHeader('Content-Type', 'application/json'); w.end(JSON.stringify(v)); }
function fail(w, code, v) { w.writeHead(code, { 'Content-Type': 'application/json' }); w.end(JSON.stringify(v || { error: 'fail ' + code })); }
function tagsFromReadme(rp) {
  const rd = rp.files.get('README.md');
  if (!rd) return [];
  const text = Buffer.from(rd).toString('utf8');
  const out = []; let inFm = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '---') { if (inFm) break; inFm = true; continue; }
    if (inFm && line.startsWith('- ')) out.push(line.slice(2).trim());
  }
  return out;
}
function pathExt(p) { const i = p.lastIndexOf('.'); return i > p.lastIndexOf('/') ? p.slice(i) : ''; }

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const auth = req.headers.authorization || '';
  // ── whoami ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/whoami-v2') {
    if (auth !== 'Bearer goodtoken') { return fail(res, 401, { error: 'bad token' }); }
    return json(res, { type: 'user', name: 'mockuser' });
  }
  // ── discovery ──────────────────────────────────────────────────────
  if (req.method === 'GET' && p === '/api/datasets') {
    const filter = u.searchParams.get('filter') || '';
    const search = u.searchParams.get('search') || '';
    const author = u.searchParams.get('author') || '';
    const out = [];
    for (const [id, rp] of repos) {
      const tags = tagsFromReadme(rp);
      if (filter && !tags.includes(filter)) continue;
      if (search && !id.includes(search)) continue;
      if (author && !id.startsWith(author + '/')) continue;
      out.push({ id, author: id.split('/')[0], likes: 0, downloads: 0, private: false, lastModified: '2026-10-21T00:00:00.000Z', tags });
    }
    return json(res, out);
  }
  // ── repo card ──────────────────────────────────────────────────────
  let m = /^\/api\/datasets\/([^/]+)\/([^/]+)$/.exec(p);
  if (req.method === 'GET' && m && !p.includes('/tree/') && !p.includes('/preupload') && !p.includes('/commit') && !p.includes('/like')) {
    const id = m[1] + '/' + m[2];
    const rp = repos.get(id);
    if (!rp) { return fail(res, 404, { error: 'not found' }); }
    return json(res, { id, tags: tagsFromReadme(rp), private: false, author: m[1], lastModified: '2026-10-21T00:00:00.000Z' });
  }
  // ── resolve (LFS files 307 to the bucket — the real HF shape) ──────
  m = /^\/datasets\/(.+)\/resolve\/main\/(.+)$/.exec(p);
  if (req.method === 'GET' && m) {
    const repo = m[1]; const file = m[2];
    const rp = repos.get(repo);
    if (!rp) { return fail(res, 404, { error: 'no repo' }); }
    const b = rp.files.get(file);
    if (!b) { return fail(res, 404, { error: "no file" }); }
    res.writeHead(307, { Location: `/cdn/${encodeURIComponent(repo)}/${encodeURIComponent(file)}` });
    return res.end();
  }
  m = /^\/cdn\/(.+)\/(.+)$/.exec(p);
  if (req.method === 'GET' && m) {
    const repo = decodeURIComponent(m[1]); const file = decodeURIComponent(m[2]);
    const rp = repos.get(repo);
    const b = rp && rp.files.get(file);
    if (!b) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Length', String(b.length));
    return res.end(b);
  }
  // ── tree ───────────────────────────────────────────────────────────
  m = /^\/api\/datasets\/(.+)\/tree\/main\/(.*)$/.exec(p);
  if (req.method === 'GET' && m) {
    const repo = m[1]; const dir = m[2];
    const rp = repos.get(repo);
    if (!rp) { return fail(res, 404, { error: 'no repo' }); }
    const prefix = dir ? dir.replace(/\/$/, '') + '/' : '';
    const out = []; const seen = new Set();
    for (const [fp, b] of rp.files) {
      if (!fp.startsWith(prefix)) continue;
      const rest = fp.slice(prefix.length);
      if (!rest) continue;
      const i = rest.indexOf('/');
      if (i >= 0) { const d = prefix + rest.slice(0, i); if (!seen.has(d)) { seen.add(d); out.push({ type: 'directory', path: d, size: 0 }); } continue; }
      out.push({ type: 'file', path: fp, size: b.length });
    }
    return json(res, out);
  }
  // ── create repo ────────────────────────────────────────────────────
  if (req.method === 'POST' && p === '/api/repos/create') {
    let body = ''; req.on('data', (c) => body += c);
    return req.on('end', () => {
      const q = JSON.parse(body || '{}');
      if (q.type !== 'dataset' || !q.name) { return fail(res, 400, { error: 'bad create' }); }
      const id = (q.organization ? q.organization + '/' : '') + q.name;
      if (repos.has(id)) { return fail(res, 409, { error: 'You already created this repo name' }); }
      repos.set(id, { files: new Map(), tags: [] });
      return json(res, { url: '/api/datasets/' + id });
    });
  }
  // ── preupload (the .gitattributes causality — real HF's law) ───────
  m = /^\/api\/datasets\/(.+)\/preupload\/main$/.exec(p);
  if (req.method === 'POST' && m) {
    const repo = m[1];
    let body = ''; req.on('data', (c) => body += c);
    return req.on('end', () => {
      const q = JSON.parse(body || '{}');
      const rp = repos.get(repo);
      const attrs = rp && rp.files.get('.gitattributes') ? Buffer.from(rp.files.get('.gitattributes')).toString('utf8') : '';
      const files = (q.files || []).map((f) => {
        let mode = 'regular';
        if (f.path.endsWith('.png')) mode = 'lfs';
        const ext = pathExt(f.path);
        if (ext && attrs.includes('*' + ext + ' filter=lfs')) mode = 'lfs';
        return { path: f.path, uploadMode: mode };
      });
      return json(res, { files });
    });
  }
  // ── LFS batch ──────────────────────────────────────────────────────
  m = /^\/datasets\/(.+)\.git\/info\/lfs\/objects\/batch$/.exec(p);
  if (req.method === 'POST' && m) {
    const repo = m[1];
    let body = ''; req.on('data', (c) => body += c);
    return req.on('end', () => {
      const q = JSON.parse(body || '{}');
      const base = 'http://127.0.0.1:' + PORT;
      const objects = (q.objects || []).map((o) => ({
        oid: o.oid, size: o.size,
        actions: { upload: { href: base + '/lfs/' + encodeURIComponent(repo) + '/' + o.oid } },
      }));
      return json(res, { transfer: 'basic', objects });
    });
  }
  m = /^\/lfs\/(.+)\/([0-9a-f]{64})$/.exec(p);
  if (req.method === 'PUT' && m) {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    return req.on('end', () => {
      lfs.set(m[2], Buffer.concat(chunks));
      res.writeHead(200); return res.end();
    });
  }
  // ── commit (NDJSON) ────────────────────────────────────────────────
  m = /^\/api\/datasets\/(.+)\/commit\/main$/.exec(p);
  if (req.method === 'POST' && m) {
    const repo = m[1];
    let body = ''; req.on('data', (c) => body += c);
    return req.on('end', () => {
      let rp = repos.get(repo);
      if (!rp) { return fail(res, 404, { error: 'no repo' }); }
      commits.push({ repo, body });
      let err = null;
      for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        let op; try { op = JSON.parse(line); } catch (e) { err = e; break; }
        if (op.key === 'file') {
          let content = Buffer.from(op.value.content || '', 'utf8');
          if (op.value.encoding === 'base64') content = Buffer.from(op.value.content || '', 'base64');
          rp.files.set(op.value.path, content);
        } else if (op.key === 'lfsFile') {
          rp.files.set(op.value.path, lfs.get(op.value.oid) || Buffer.alloc(0));
        }
      }
      if (err) { return fail(res, 400, { error: 'bad ndjson' }); }
      return json(res, { commitUrl: '/' + repo + '/commit/mocksha' });
    });
  }
  // ── like ───────────────────────────────────────────────────────────
  m = /^\/api\/datasets\/(.+)\/like$/.exec(p);
  if (m && (req.method === 'POST' || req.method === 'DELETE')) {
    likes.set(m[1], req.method === 'POST');
    if (req.method === 'POST') return json(res, { liked: true });
    res.writeHead(200); return res.end();
  }
  // ── the walk's debug window ────────────────────────────────────────
  if (req.method === 'GET' && p === '/state') {
    const dump = {
      repos: Object.fromEntries([...repos.entries()].map(([id, rp]) => [id, {
        files: [...rp.files.entries()].map(([fp, b]) => ({ path: fp, size: b.length, head: Buffer.from(b.slice(0, 8)).toString('hex') })),
        tags: tagsFromReadme(rp),
      }])),
      commits: commits.map((c) => ({ repo: c.repo, body: c.body.slice(0, 2000) })),
      likes: [...likes.entries()],
    };
    return json(res, dump);
  }
  fail(res, 404, { error: 'no route', path: p });
});

srv.listen(PORT, '127.0.0.1', () => console.log('fakehf listening on ' + PORT));
