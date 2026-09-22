// filetypes.js — v0.17 the FILE-TYPE REGISTRY.
//
// Built from research into the most-used file types (web-format surveys +
// GitHub language stats): documents (txt/md/csv/json/xml/html), config
// (yaml/toml/ini/env), web (css/js/ts), and the top-20 programming
// languages (Python, JS, Java, C/C++, C#, Go, Rust, Ruby, PHP, Shell,
// SQL, TypeScript, R, Perl, Lua, Swift, Kotlin, Dart, PowerShell).
//
// Every entry: { label, mime, category, icon, color, cm (CodeMirror 5
// mode), prism (Prism language), binary }
// — the icon+color drive the drawer/file cards; cm drives the EDITOR
// (proper highlighting + editing per type); prism drives message code
// blocks. Unknown extensions get a sane generic entry (never a dead end
// — the user asked for "almost any text based file type").
//
// Exposes: window.FileTypes
(function () {
  'use strict';

  // category → { icon, color } (the 2–3-hue family look)
  var CAT = {
    doc:     { icon: '📄', color: 'var(--fmt-a2)' },
    data:    { icon: '🧮', color: 'var(--fmt-a1)' },
    code:    { icon: '⌨', color: 'var(--fmt-a3)' },
    web:     { icon: '🌐', color: 'var(--fmt-a1)' },
    config:  { icon: '⚙', color: 'var(--fmt-a2)' },
    sheet:   { icon: '📊', color: 'var(--fmt-a1)' },
    binary:  { icon: 'BIN', color: 'var(--text-3)' },
    archive: { icon: '🗜', color: 'var(--text-3)' },
    image:   { icon: '🖼', color: 'var(--text-3)' },
    other:   { icon: '📄', color: 'var(--fmt-a2)' }
  };

  function E(ext, label, cat, cm, prism, mime, extra) {
    var e = {
      ext: ext, label: label, category: cat || 'doc',
      cm: cm || null, prism: prism || null, mime: mime || 'text/plain; charset=utf-8'
    };
    var c = CAT[cat] || CAT.other;
    e.icon = c.icon; e.color = c.color;
    if (extra) for (var k in extra) e[k] = extra[k];
    return e;
  }

  var TYPES = {
    // ── documents / text ────────────────────────────────────────
    txt:   E('txt', 'Plain Text', 'doc', null, null),
    text:  E('text', 'Plain Text', 'doc', null, null),
    log:   E('log', 'Log File', 'doc', null, null),
    md:    E('md', 'Markdown', 'doc', 'markdown', 'markdown', 'text/markdown; charset=utf-8'),
    markdown: E('markdown', 'Markdown', 'doc', 'markdown', 'markdown', 'text/markdown; charset=utf-8'),
    mdown: E('mdown', 'Markdown', 'doc', 'markdown', 'markdown', 'text/markdown; charset=utf-8'),
    rst:   E('rst', 'reStructuredText', 'doc', null, null, 'text/x-rst'),
    adoc:  E('adoc', 'AsciiDoc', 'doc', null, null),
    org:   E('org', 'Org Mode', 'doc', null, null),
    tex:   E('tex', 'LaTeX', 'doc', null, null, 'application/x-tex'),
    rtf:   E('rtf', 'Rich Text', 'doc', null, null, 'application/rtf'),
    eml:   E('eml', 'Email', 'doc', null, null, 'message/rfc822'),

    // ── data / structured ───────────────────────────────────────
    json:  E('json', 'JSON', 'data', 'javascript', 'json', 'application/json'),
    jsonl: E('jsonl', 'JSON Lines', 'data', 'javascript', 'json', 'application/x-ndjson'),
    ndjson: E('ndjson', 'JSON Lines', 'data', 'javascript', 'json', 'application/x-ndjson'),
    jsonc: E('jsonc', 'JSON (comments)', 'data', 'javascript', 'json'),
    geojson: E('geojson', 'GeoJSON', 'data', 'javascript', 'json', 'application/geo+json'),
    csv:   E('csv', 'CSV Data', 'sheet', null, null, 'text/csv'),
    tsv:   E('tsv', 'TSV Data', 'sheet', null, null, 'text/tab-separated-values'),
    xml:   E('xml', 'XML', 'data', 'xml', 'markup', 'application/xml'),
    yaml:  E('yaml', 'YAML', 'config', 'yaml', 'yaml', 'application/yaml'),
    yml:   E('yml', 'YAML', 'config', 'yaml', 'yaml', 'application/yaml'),
    toml:  E('toml', 'TOML', 'config', 'toml', 'toml', 'application/toml'),
    ini:   E('ini', 'INI Config', 'config', 'properties', 'ini'),
    cfg:   E('cfg', 'Config', 'config', 'properties', 'ini'),
    conf:  E('conf', 'Config', 'config', 'properties', 'ini'),
    properties: E('properties', 'Properties', 'config', 'properties', 'ini'),
    env:   E('env', 'Env Vars', 'config', 'properties', 'ini'),
    proto: E('proto', 'Protobuf', 'data', null, null),
    sql:   E('sql', 'SQL', 'data', 'sql', 'sql', 'application/sql'),
    graphql: E('graphql', 'GraphQL', 'data', null, null),
    ndx:   E('ndx', 'Index', 'other'),

    // ── web ─────────────────────────────────────────────────────
    html:  E('html', 'HTML', 'web', 'htmlmixed', 'markup', 'text/html'),
    htm:   E('htm', 'HTML', 'web', 'htmlmixed', 'markup', 'text/html'),
    css:   E('css', 'CSS', 'web', 'css', 'css', 'text/css'),
    scss:  E('scss', 'SCSS', 'web', 'css', 'css'),
    sass:  E('sass', 'Sass', 'web', 'css', 'css'),
    less:  E('less', 'Less', 'web', 'css', 'css'),
    svg:   E('svg', 'SVG Image', 'web', 'xml', 'markup', 'image/svg+xml'),
    vue:   E('vue', 'Vue Component', 'web', 'htmlmixed', 'markup'),

    // ── code: top languages (GitHub stats) ──────────────────────
    js:    E('js', 'JavaScript', 'code', 'javascript', 'javascript', 'text/javascript'),
    mjs:   E('mjs', 'JavaScript', 'code', 'javascript', 'javascript', 'text/javascript'),
    cjs:   E('cjs', 'JavaScript', 'code', 'javascript', 'javascript', 'text/javascript'),
    jsx:   E('jsx', 'React JSX', 'code', 'jsx', 'jsx'),
    ts:    E('ts', 'TypeScript', 'code', 'javascript', 'typescript', 'text/typescript'),
    tsx:   E('tsx', 'React TSX', 'code', 'jsx', 'tsx'),
    py:    E('py', 'Python', 'code', 'python', 'python', 'text/x-python'),
    pyw:   E('pyw', 'Python', 'code', 'python', 'python', 'text/x-python'),
    ipynb: E('ipynb', 'Jupyter Notebook', 'data', 'javascript', 'json', 'application/x-ipynb+json'),
    java:  E('java', 'Java', 'code', 'clike', 'java', 'text/x-java'),
    c:     E('c', 'C', 'code', 'clike', 'c', 'text/x-c'),
    h:     E('h', 'C Header', 'code', 'clike', 'c', 'text/x-c'),
    cpp:   E('cpp', 'C++', 'code', 'clike', 'cpp', 'text/x-c++'),
    cc:    E('cc', 'C++', 'code', 'clike', 'cpp', 'text/x-c++'),
    cxx:   E('cxx', 'C++', 'code', 'clike', 'cpp', 'text/x-c++'),
    hpp:   E('hpp', 'C++ Header', 'code', 'clike', 'cpp', 'text/x-c++'),
    cs:    E('cs', 'C#', 'code', 'clike', 'csharp', 'text/x-csharp'),
    go:    E('go', 'Go', 'code', 'go', 'go', 'text/x-go'),
    rs:    E('rs', 'Rust', 'code', 'rust', 'rust', 'text/x-rust'),
    rb:    E('rb', 'Ruby', 'code', 'ruby', 'ruby', 'text/x-ruby'),
    php:   E('php', 'PHP', 'code', 'php', 'php', 'application/x-httpd-php'),
    pl:    E('pl', 'Perl', 'code', 'perl', 'perl', 'text/x-perl'),
    pm:    E('pm', 'Perl Module', 'code', 'perl', 'perl', 'text/x-perl'),
    lua:   E('lua', 'Lua', 'code', 'lua', 'lua', 'text/x-lua'),
    swift: E('swift', 'Swift', 'code', 'clike', 'swift', 'text/x-swift'),
    kt:    E('kt', 'Kotlin', 'code', 'clike', null, 'text/x-kotlin'),
    kts:   E('kts', 'Kotlin Script', 'code', 'clike', null, 'text/x-kotlin'),
    dart:  E('dart', 'Dart', 'code', 'clike', null, 'text/x-dart'),
    scala: E('scala', 'Scala', 'code', 'clike', null, 'text/x-scala'),
    r:     E('r', 'R', 'code', 'r', 'r', 'text/x-r'),
    m:     E('m', 'MATLAB / Objective-C', 'code', null, null),
    sh:    E('sh', 'Shell Script', 'code', 'shell', 'bash', 'text/x-shellscript'),
    bash:  E('bash', 'Bash Script', 'code', 'shell', 'bash', 'text/x-shellscript'),
    zsh:   E('zsh', 'Zsh Script', 'code', 'shell', 'bash', 'text/x-shellscript'),
    fish:  E('fish', 'Fish Script', 'code', 'shell', 'bash'),
    bat:   E('bat', 'Batch File', 'code', 'shell', 'powershell'),
    cmd:   E('cmd', 'Batch File', 'code', 'shell', 'powershell'),
    ps1:   E('ps1', 'PowerShell', 'code', 'powershell', 'powershell'),
    ps:    E('ps', 'PostScript', 'other', null, null),
    dockerfile: E('dockerfile', 'Dockerfile', 'config', 'dockerfile', 'docker'),
    makefile: E('makefile', 'Makefile', 'config', null, null),
    mk:    E('mk', 'Makefile', 'config', null, null),
    cmake: E('cmake', 'CMake', 'config', null, null),
    gradle: E('gradle', 'Gradle', 'config', null, null),
    diff:  E('diff', 'Diff / Patch', 'doc', 'diff', 'diff'),
    patch: E('patch', 'Diff / Patch', 'doc', 'diff', 'diff'),

    // ── common binaries — docx/xlsx/archives get VIEWERS (v0.23); the
    // rest stay download-only (editor falls back to hex/plain warn) ──
    pdf:   E('pdf', 'PDF Document', 'binary', null, null, 'application/pdf', { binary: true }),
    doc:   E('doc', 'Word Document (legacy)', 'binary', null, null, 'application/msword', { binary: true }),
    docx:  E('docx', 'Word Document', 'binary', null, null, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', { binary: true, viewer: 'docx' }),
    xls:   E('xls', 'Excel Sheet (legacy)', 'sheet', null, null, 'application/vnd.ms-excel', { binary: true }),
    xlsx:  E('xlsx', 'Excel Sheet', 'sheet', null, null, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { binary: true, viewer: 'xlsx' }),
    ods:   E('ods', 'OpenDocument Sheet', 'sheet', null, null, 'application/vnd.oasis.opendocument.spreadsheet', { binary: true, viewer: 'xlsx' }),
    ppt:   E('ppt', 'PowerPoint', 'binary', null, null, 'application/vnd.ms-powerpoint', { binary: true }),
    pptx:  E('pptx', 'PowerPoint', 'binary', null, null, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', { binary: true }),
    odt:   E('odt', 'OpenDocument Text', 'binary', null, null, 'application/vnd.oasis.opendocument.text', { binary: true }),
    epub:  E('epub', 'EPUB eBook', 'binary', null, null, 'application/epub+zip', { binary: true, viewer: 'archive' }),
    png:   E('png', 'PNG Image', 'image', null, null, 'image/png', { binary: true }),
    jpg:   E('jpg', 'JPEG Image', 'image', null, null, 'image/jpeg', { binary: true }),
    jpeg:  E('jpeg', 'JPEG Image', 'image', null, null, 'image/jpeg', { binary: true }),
    gif:   E('gif', 'GIF Image', 'image', null, null, 'image/gif', { binary: true }),
    webp:  E('webp', 'WebP Image', 'image', null, null, 'image/webp', { binary: true }),
    ico:   E('ico', 'Icon', 'image', null, null, 'image/x-icon', { binary: true }),
    zip:   E('zip', 'ZIP Archive', 'archive', null, null, 'application/zip', { binary: true, viewer: 'archive' }),
    gz:    E('gz', 'Gzip Archive', 'archive', null, null, 'application/gzip', { binary: true, viewer: 'archive' }),
    tgz:   E('tgz', 'Tar+Gzip Archive', 'archive', null, null, 'application/gzip', { binary: true, viewer: 'archive' }),
    tbz2:  E('tbz2', 'Tar+Bzip2 Archive', 'archive', null, null, 'application/x-bzip2', { binary: true, viewer: 'archive' }),
    txz:   E('txz', 'Tar+XZ Archive', 'archive', null, null, 'application/x-xz', { binary: true, viewer: 'archive' }),
    tzst:  E('tzst', 'Tar+Zstd Archive', 'archive', null, null, 'application/zstd', { binary: true, viewer: 'archive' }),
    tar:   E('tar', 'Tar Archive', 'archive', null, null, 'application/x-tar', { binary: true, viewer: 'archive' }),
    '7z':  E('7z', '7-Zip Archive', 'archive', null, null, 'application/x-7z-compressed', { binary: true, viewer: 'archive' }),
    rar:   E('rar', 'RAR Archive', 'archive', null, null, 'application/vnd.rar', { binary: true, viewer: 'archive' }),
    bz2:   E('bz2', 'Bzip2 Archive', 'archive', null, null, 'application/x-bzip2', { binary: true, viewer: 'archive' }),
    xz:    E('xz', 'XZ Archive', 'archive', null, null, 'application/x-xz', { binary: true, viewer: 'archive' }),
    zst:   E('zst', 'Zstd Archive', 'archive', null, null, 'application/zstd', { binary: true, viewer: 'archive' }),
    jar:   E('jar', 'Java Archive', 'archive', null, null, 'application/java-archive', { binary: true, viewer: 'archive' }),
    wav:   E('wav', 'WAV Audio', 'binary', null, null, 'audio/wav', { binary: true }),
    mp3:   E('mp3', 'MP3 Audio', 'binary', null, null, 'audio/mpeg', { binary: true }),
    mp4:   E('mp4', 'MP4 Video', 'binary', null, null, 'video/mp4', { binary: true }),
    apk:   E('apk', 'Android APK', 'binary', null, null, 'application/vnd.android.package-archive', { binary: true, viewer: 'archive' })
  };

  // language-label aliases → prism languages (for ```lang code fences)
  var ALIAS = {
    js: 'javascript', javascript: 'javascript', node: 'javascript',
    ts: 'typescript', typescript: 'typescript',
    py: 'python', python: 'python', python3: 'python',
    rb: 'ruby', ruby: 'ruby',
    sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
    yml: 'yaml', yaml: 'yaml',
    json: 'json', jsonc: 'json',
    html: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
    css: 'css', scss: 'css', less: 'css',
    c: 'c', cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', hpp: 'cpp',
    java: 'java', cs: 'csharp', 'c#': 'csharp', csharp: 'csharp',
    go: 'go', golang: 'go', rust: 'rust', rs: 'rust',
    sql: 'sql', lua: 'lua', perl: 'perl', pl: 'perl',
    r: 'r', dockerfile: 'docker', docker: 'docker',
    powershell: 'powershell', ps1: 'powershell',
    diff: 'diff', patch: 'diff',
    md: 'markdown', markdown: 'markdown',
    ini: 'ini', toml: 'toml', conf: 'ini', properties: 'ini',
    jsx: 'jsx', tsx: 'tsx', php: 'php', swift: 'swift'
  };

  function extOf(name) {
    var n = String(name || '').toLowerCase();
    // v0.23: multi-dot archive extensions FIRST ("a.tar.gz" is a tarball,
    // not a gzipped something-else) — mapped onto the synthetic keys that
    // carry the viewer metadata.
    if (/\.tar\.gz$|\.tgz$/.test(n)) return 'tgz';
    if (/\.tar\.bz2$|\.tbz2?$/.test(n)) return 'tbz2';
    if (/\.tar\.xz$|\.txz$/.test(n)) return 'txz';
    if (/\.tar\.zst$|\.tzst$/.test(n)) return 'tzst';
    var dot = n.lastIndexOf('.');
    if (dot < 0 || dot === n.length - 1) {
      // extensionless well-known names
      if (n === 'dockerfile' || n === 'makefile' || n === 'cmakelists.txt') return n === 'cmakelists.txt' ? 'cmake' : n;
      return n; // treat the whole name as the "ext" (dockerfile, makefile…)
    }
    return n.slice(dot + 1);
  }

  // info(name) → full meta (unknown ext → generic text entry, never null)
  function info(name) {
    var ext = extOf(name);
    var t = TYPES[ext];
    if (!t) {
      t = E(ext, (ext || 'file').toUpperCase() + ' File', 'other', null, null);
      // Unknown but likely text (no known binary list hit) → editable
      t.editable = true;
    }
    return t;
  }

  function isBinary(name) { return !!info(name).binary; }
  function cmMode(name) { return info(name).cm || null; }
  function prismLang(name) { return info(name).prism || null; }
  function prismLangFromAlias(label) {
    if (!label) return null;
    return ALIAS[String(label).toLowerCase()] || null;
  }
  function humanBytes(n) {
    if (n == null || isNaN(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  window.FileTypes = {
    info: info,
    isBinary: isBinary,
    cmMode: cmMode,
    prismLang: prismLang,
    prismLangFromAlias: prismLangFromAlias,
    humanBytes: humanBytes,
    extOf: extOf,
    TYPES: TYPES,
    CAT: CAT
  };
})();
