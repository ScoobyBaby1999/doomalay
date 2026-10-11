// v1241 fake bridge — the termux bridge double for the E2E walk.
// installed + permission true; the probe reports props_ok/storage_ok
// FALSE so the setup ladder renders in its not-ready state (the bar's
// old home is gone — the walk pins the removal on the live page).
import http from 'node:http';

const TOKEN = 'tok1241';
const PORT = 8655;

http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (!req.url.startsWith('/' + TOKEN + '/')) { send(403, { ok: false, error: 'bad token' }); return; }
  if (req.method === 'GET' && req.url.endsWith('/status')) {
    send(200, { installed: true, version_code: 1022, version_name: '0.119.0-beta.3', permission: true });
    return;
  }
  if (req.method === 'POST' && req.url.endsWith('/probe')) {
    send(200, { ok: true, storage_ok: false, props_ok: false, stdout: '__doomalay_probe__\nno-props\n', stderr: '', exit_code: 1, err: 0, errmsg: null, timeout: false });
    return;
  }
  if (req.method === 'POST' && req.url.endsWith('/act')) { send(200, { ok: true }); return; }
  send(404, { ok: false });
}).listen(PORT, '127.0.0.1', () => console.log('fake bridge on ' + PORT));
