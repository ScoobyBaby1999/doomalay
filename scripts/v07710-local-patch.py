#!/usr/bin/env python3
"""v07710-local-patch.py — the store layer of the bundle-counting wave."""
P = 'engine/internal/hub/local.go'
s = open(P, encoding='utf-8').read()

# 1. LocalItem gains ViaCollection
old = '''// LocalItem is one hub_items row (meta decoded + the overlay columns).
type LocalItem struct {
        Item         Item
        Payload      string
        Hearted      bool
        HeartedAt    string
        DownloadedAt string
}'''
new = '''// LocalItem is one hub_items row (meta decoded + the overlay columns).
type LocalItem struct {
        Item         Item
        Payload      string
        Hearted      bool
        HeartedAt    string
        DownloadedAt string
        // v0.77.10: ViaCollection — this row was downloaded as PART of a
        // bundle: the member's displayed +1 rides the COLLECTION's counter
        // (per-user, one per bundle), never the member's own. A row first
        // downloaded DIRECTLY keeps via=0 forever (its +1 stays its own).
        ViaCollection bool
}'''
assert old in s, 'LocalItem anchor'
s = s.replace(old, new)

# 2. SaveLocalItem carries the collection column
old = '''        _, err = db.Exec(`INSERT INTO hub_items (type, id, repo, name, meta, payload)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(type, id) DO UPDATE SET
                        repo = excluded.repo, name = excluded.name, meta = excluded.meta,
                        payload = CASE WHEN excluded.payload != '' THEN excluded.payload ELSE hub_items.payload END`,
                item.Type, item.ID, item.Repo, item.Name, string(meta), payload)
        return err'''
new = '''        _, err = db.Exec(`INSERT INTO hub_items (type, id, repo, name, meta, payload, collection)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(type, id) DO UPDATE SET
                        repo = excluded.repo, name = excluded.name, meta = excluded.meta,
                        collection = excluded.collection,
                        payload = CASE WHEN excluded.payload != '' THEN excluded.payload ELSE hub_items.payload END`,
                item.Type, item.ID, item.Repo, item.Name, string(meta), payload, SanitizeCollection(item.Collection))
        return err'''
assert old in s, 'SaveLocalItem anchor'
s = s.replace(old, new)

# 3. the SELECTs gain via_collection
s = s.replace('''        row := db.QueryRow(`SELECT meta, payload, hearted, hearted_at, downloaded_at
                FROM hub_items WHERE type = ? AND id = ?`, typ, id)''',
'''        row := db.QueryRow(`SELECT meta, payload, hearted, hearted_at, downloaded_at, via_collection
                FROM hub_items WHERE type = ? AND id = ?`, typ, id)''')
s = s.replace('''        rows, err := db.Query(`SELECT meta, payload, hearted, hearted_at, downloaded_at
                FROM hub_items WHERE type = ? AND (repo != '' OR payload != '')''',
'''        rows, err := db.Query(`SELECT meta, payload, hearted, hearted_at, downloaded_at, via_collection
                FROM hub_items WHERE type = ? AND (repo != '' OR payload != '')''')

# 4. scanLocalItem reads it
old = '''func scanLocalItem(row scanner) (*LocalItem, error) {
        var meta, payload sql.NullString
        var hearted int
        var heartedAt, downloadedAt sql.NullString
        if err := row.Scan(&meta, &payload, &hearted, &heartedAt, &downloadedAt); err != nil {'''
new = '''func scanLocalItem(row scanner) (*LocalItem, error) {
        var meta, payload sql.NullString
        var hearted int
        var heartedAt, downloadedAt sql.NullString
        var via int
        if err := row.Scan(&meta, &payload, &hearted, &heartedAt, &downloadedAt, &via); err != nil {'''
assert old in s, 'scanLocalItem anchor'
s = s.replace(old, new)
s = s.replace('        out := &LocalItem{Hearted: hearted != 0}',
              '        out := &LocalItem{Hearted: hearted != 0, ViaCollection: via != 0}')

# 5. MarkDownloaded → direct (via=0) + the new Via variant + collection state helpers
old = '''// MarkDownloaded stamps downloaded_at. The local +1 the UI displays comes
// from applyCounts' DownloadedAt overlay — a bumped counter in the stored
// meta here would DOUBLE-count it (countsFor bases itself on row.Item),
// so the meta keeps the remote base counters untouched.
func MarkDownloaded(db *store.DB, typ, id string) error {
        existing, err := GetLocalItem(db,store.DB, typ, id)
        if err != nil {
                return err
        }
        existing.DownloadedAt = NowString()
        meta, err := json.Marshal(existing.Item)
        if err != nil {
                return err
        }
        _, err = db.Exec(`UPDATE hub_items SET meta = ?, downloaded_at = ? WHERE type = ? AND id = ?`,
                string(meta), existing.DownloadedAt, typ, id)
        return err
}'''
# the file may not have the typo above — use the ORIGINAL text from the read
old = old.replace('GetLocalItem(db,store.DB, typ, id)', 'GetLocalItem(db, typ, id)')
if old not in s:
    # try the exact original from the earlier Read
    old = '''// MarkDownloaded stamps downloaded_at. The local +1 the UI displays comes
// from applyCounts' DownloadedAt overlay — a bumped counter in the stored
// meta here would DOUBLE-count it (countsFor bases itself on row.Item),
// so the meta keeps the remote base counters untouched.
func MarkDownloaded(db *store.DB, typ, id string) error {
        existing, err := GetLocalItem(db, typ, id)
        if err != nil {
                return err
        }
        existing.DownloadedAt = NowString()
        meta, err := json.Marshal(existing.Item)
        if err != nil {
                return err
        }
        _, err = db.Exec(`UPDATE hub_items SET meta = ?, downloaded_at = ? WHERE type = ? AND id = ?`,
                string(meta), existing.DownloadedAt, typ, id)
        return err
}'''
assert old in s, 'MarkDownloaded anchor'
new = '''// MarkDownloaded stamps downloaded_at (a DIRECT download — via stays 0;
// the local +1 the UI displays rides applyCounts' DownloadedAt overlay,
// exactly as before; the meta keeps the remote base counters untouched).
func MarkDownloaded(db *store.DB, typ, id string) error {
        _, err := db.Exec(`UPDATE hub_items SET downloaded_at = ?, via_collection = 0 WHERE type = ? AND id = ?`,
                NowString(), typ, id)
        return err
}

// MarkDownloadedVia stamps downloaded_at AS PART OF A BUNDLE (v0.77.10:
// one user downloading a 64-member bundle counts ONCE, on the collection
// — never +64). A row already downloaded DIRECTLY keeps via=0 (its own
// +1 stands; the bundle's +1 rides the collection either way).
func MarkDownloadedVia(db *store.DB, typ, id string) error {
        _, err := db.Exec(`UPDATE hub_items SET downloaded_at = ?,
                via_collection = CASE WHEN downloaded_at != '' AND via_collection = 0 THEN 0 ELSE 1 END
                WHERE type = ? AND id = ?`,
                NowString(), typ, id)
        return err
}

// LocalCollectionState reports one bunch's local state: downloaded = any
// member row carries a download stamp; hearted = any member hearted (the
// pre-v0.77.10 endorse fan-out's legacy state — a bundle endorse now rides
// its own metric event; this keeps the legacy hearts readable).
func LocalCollectionState(db *store.DB, collection string) (downloaded, hearted bool) {
        var d, h int
        _ = db.QueryRow(`SELECT COUNT(*), MAX(hearted) FROM hub_items
                WHERE collection = ? AND downloaded_at != ''`, collection).Scan(&d, &h)
        return d > 0, h > 0
}

// LocalViaCollections returns the set of collection ids with at least one
// locally bundle-downloaded member (the local +1 for the COLLECTION
// counters — one per user, riding the collection, not its members).
func LocalViaCollections(db *store.DB) map[string]bool {
        out := map[string]bool{}
        rows, err := db.Query(`SELECT DISTINCT collection FROM hub_items
                WHERE collection != '' AND via_collection = 1 AND downloaded_at != ''`)
        if err != nil {
                return out
        }
        defer rows.Close()
        for rows.Next() {
                var c string
                if err := rows.Scan(&c); err == nil && c != "" {
                        out[c] = true
                }
        }
        return out
}'''
s = s.replace(old, new)

open(P, 'w', encoding='utf-8').write(s)
print('local.go patched')
