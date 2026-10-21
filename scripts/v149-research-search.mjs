// v149 research driver — THE POCKET BRIDGE (opencode on Android via Termux).
// Batched web_search calls; results saved to /tmp/v149-search-*.json for triage.
import ZAI from 'z-ai-web-dev-sdk';
import { writeFileSync } from 'fs';

const QUERIES = [
  ['01-opencode-termux', 'opencode CLI termux android', 8],
  ['02-opencode-github-issues', 'site:github.com opencode termux issue android', 8],
  ['03-bun-proot', 'bun javascript runtime proot termux crash io_uring', 8],
  ['04-opencode-api-key', 'opencode OPENCODE_API_KEY environment variable api key', 8],
  ['05-opencode-serve-flags', 'opencode serve --port --hostname flags documentation', 8],
  ['06-android-loopback-apps', 'android app connect localhost server another app 127.0.0.1 shared loopback', 8],
  ['07-termux-glibc-runner', 'termux glibc runner grun run glibc binaries 2025', 8],
  ['08-proot-distro-ubuntu-arm64', 'proot-distro install ubuntu arm64 size rootfs', 8],
  ['09-termux-background-process', 'termux RUN_COMMAND background process survive session nohup', 8],
  ['10-opencode-install-script', 'opencode.ai install script linux arm64 download', 8],
];

const zai = await ZAI.create();
for (const [name, query, num] of QUERIES) {
  try {
    const results = await zai.functions.invoke('web_search', { query, num, recency_days: 365 });
    writeFileSync(`/tmp/v149-search-${name}.json`, JSON.stringify(results, null, 2));
    const items = Array.isArray(results) ? results : (results?.results || results?.data || []);
    console.log(`\n=== ${name}: ${query}`);
    for (const r of (Array.isArray(items) ? items : []).slice(0, 8)) {
      console.log(`  - ${r.title}\n    ${r.url}\n    ${(r.snippet || r.description || '').slice(0, 180)}`);
    }
    if (!Array.isArray(items)) console.log('  RAW SHAPE:', JSON.stringify(results).slice(0, 400));
  } catch (e) {
    console.log(`=== ${name} FAILED: ${e.message}`);
  }
}
console.log('\nDONE');
