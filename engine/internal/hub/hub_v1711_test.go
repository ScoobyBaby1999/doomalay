package hub

// hub_v1711_test.go — v1.71.1 THE DASHBOARD (PLAN-V169 §v1.169.4): the
// bundle-management laws, engine-side.
//
//   (1)  THE UNPUBLISH SWEEP: one commit deletes the meta + the payload +
//        the companions + the card art, and rewrites items/index.json
//        WITHOUT the row (the deletedFile NDJSON op — the client-proven
//        shape, mock-parsed); the LOCAL published row dies with it;
//   (2)  THE AUTHORSHIP GATE: a foreign repo (someone else's owner
//        prefix) → ErrNotOwner; a stored meta whose author is not the
//        connected user → ErrNotOwner; unknown → the honest 404 family;
//        disconnected → ErrNotConnected;
//   (3)  THE MINE FILTER: ItemsMine keeps ONLY the connected user's own
//        rows (a foreign-author local row drops out); disconnected →
//        ErrNotConnected (never a lying empty list);
//   (4)  THE LINEAGE STAMP: ParentUuid/ParentAuthor/ParentName ride the
//        publish → the item meta (sanitized), the fork badge's truth.

import (
        "bytes"
        "encoding/json"
        "errors"
        "strings"
        "testing"
)

func v1711Publish(t *testing.T, svc *Service, name string) Item {
        t.Helper()
        zipBytes := bytes.Repeat([]byte{0x50, 0x4B, 0x03, 0x04}, 8)
        item, err := svc.Publish("canvas", PublishRequest{
                Name:         name,
                Description:  "a world published from a test",
                PayloadBytes: zipBytes,
                Files:        []PublishFile{{Path: "notes.md", Content: "the companion"}},
                ParentUuid:   "cvb_parent0001",
                ParentAuthor: "alice",
                ParentName:   "Origin World",
        })
        if err != nil {
                t.Fatalf("publish %s: %v", name, err)
        }
        return item
}

func TestV1711_UnpublishSweep(t *testing.T) {
        m := newMockHF(t)
        seedHubFixtures(t, m)
        svc := newTestService(t, m)
        if _, err := svc.Connect("goodtoken"); err != nil {
                t.Fatalf("connect: %v", err)
        }
        item := v1711Publish(t, svc, "Fork World")
        repo := "mockuser/doomalay-canvases"

        // the publish landed everything the sweep must kill
        for _, p := range []string{
                "items/" + item.ID + ".json",
                "items/" + item.ID + ".doomcanvas",
                "items/" + item.ID + "/notes.md",
                "items/index.json",
        } {
                if _, ok := m.file(repo, p); !ok {
                        t.Fatalf("publish must write %s", p)
                }
        }

        // the lineage stamp rode the meta (the fork badge's truth)
        meta, ok := m.file(repo, "items/"+item.ID+".json")
        if !ok {
                t.Fatalf("no meta")
        }
        var stored Item
        if err := json.Unmarshal(meta, &stored); err != nil {
                t.Fatalf("meta unmarshal: %v", err)
        }
        if stored.ParentUuid != "cvb_parent0001" || stored.ParentAuthor != "alice" || stored.ParentName != "Origin World" {
                t.Fatalf("lineage stamp = %q/%q/%q", stored.ParentUuid, stored.ParentAuthor, stored.ParentName)
        }
        if stored.Author != "mockuser" {
                t.Fatalf("author must be the server-side whoami truth, got %q", stored.Author)
        }

        // THE SWEEP
        if err := svc.Unpublish("canvas", repo, item.ID); err != nil {
                t.Fatalf("unpublish: %v", err)
        }
        for _, p := range []string{
                "items/" + item.ID + ".json",
                "items/" + item.ID + ".doomcanvas",
                "items/" + item.ID + "/notes.md",
        } {
                if _, ok := m.file(repo, p); ok {
                        t.Fatalf("unpublish must delete %s", p)
                }
        }
        // the index regenerated WITHOUT the row
        idx, ok := m.file(repo, "items/index.json")
        if !ok {
                t.Fatalf("index must be rewritten, not deleted")
        }
        if strings.Contains(string(idx), item.ID) {
                t.Fatalf("index still carries the unpublished id")
        }
        // the sweep rode the client-proven deletedFile op (the metrics sidecar
        // commit may trail the sweep — search the captured bodies)
        m.mu.Lock()
        commitBodies := append([]string(nil), m.commits...)
        m.mu.Unlock()
        foundDelete, foundMsg := false, false
        for _, c := range commitBodies {
                if strings.Contains(c, `"deletedFile"`) {
                        foundDelete = true
                }
                if strings.Contains(c, "unpublish Fork World") {
                        foundMsg = true
                }
        }
        if !foundDelete {
                t.Fatalf("the unpublish commits must carry deletedFile ops")
        }
        if !foundMsg {
                t.Fatalf("the sweep's commit message must name the unpublish")
        }
        // the LOCAL published row died with the remote
        if _, err := GetLocalItem(svc.db, "canvas", item.ID); !errors.Is(err, ErrNotFound) && err != ErrNotFound {
                t.Fatalf("the local row must be gone, got %v", err)
        }
}

func TestV1711_UnpublishAuthorshipGate(t *testing.T) {
        m := newMockHF(t)
        seedHubFixtures(t, m)
        svc := newTestService(t, m)
        if _, err := svc.Connect("goodtoken"); err != nil {
                t.Fatalf("connect: %v", err)
        }
        item := v1711Publish(t, svc, "Gated World")
        repo := "mockuser/doomalay-canvases"

        // a foreign repo — not ours to delete (the owner prefix check)
        if err := svc.Unpublish("canvas", "someoneelse/doomalay-canvases", item.ID); !errors.Is(err, ErrNotOwner) {
                t.Fatalf("foreign repo must ErrNotOwner, got %v", err)
        }
        // a stored meta whose author is not the connected user (the second
        // witness) — hand-write a foreign-authored meta under OUR repo id
        foreign := Item{ID: item.ID, Type: "canvas", Name: "Stolen", Author: "someoneelse", Repo: repo, File: "items/" + item.ID + ".doomcanvas"}
        if err := SaveLocalItem(svc.db, foreign, ""); err != nil {
                t.Fatalf("seed foreign meta: %v", err)
        }
        foreignMeta, _ := json.MarshalIndent(foreign, "", "  ")
        m.mu.Lock()
        if rp, ok := m.repos[repo]; ok {
                rp.files["items/"+item.ID+".json"] = foreignMeta
        }
        m.mu.Unlock()
        if err := svc.Unpublish("canvas", repo, item.ID); !errors.Is(err, ErrNotOwner) {
                t.Fatalf("foreign-authored meta must ErrNotOwner, got %v", err)
        }
        // unknown id — the honest 404 family (FetchFile's miss)
        if err := svc.Unpublish("canvas", repo, "ghost-item-x"); err == nil || IsNotFound(err) == false {
                t.Fatalf("unknown id must surface a not-found error, got %v", err)
        }
        // disconnected — the honest gate
        if err := svc.Disconnect(); err != nil {
                t.Fatalf("disconnect: %v", err)
        }
        if err := svc.Unpublish("canvas", repo, item.ID); !errors.Is(err, ErrNotConnected) {
                t.Fatalf("disconnected unpublish must ErrNotConnected, got %v", err)
        }
}

func TestV1711_MineFilter(t *testing.T) {
        m := newMockHF(t)
        seedHubFixtures(t, m)
        svc := newTestService(t, m)
        if _, err := svc.Connect("goodtoken"); err != nil {
                t.Fatalf("connect: %v", err)
        }
        one := v1711Publish(t, svc, "Mine One")
        two := v1711Publish(t, svc, "Mine Two")

        // a FOREIGN-author local row (downloaded from someone else) must NOT
        // survive the mine filter
        foreign := Item{ID: "foreign-item-z", Type: "canvas", Name: "Their World",
                Author: "someoneelse", Repo: "someoneelse/doomalay-canvases",
                File: "items/foreign-item-z.doomcanvas"}
        if err := SaveLocalItem(svc.db, foreign, "{}"); err != nil {
                t.Fatalf("seed foreign: %v", err)
        }

        got, err := svc.ItemsMine("canvas", "", "", "", true)
        if err != nil {
                t.Fatalf("ItemsMine: %v", err)
        }
        ids := map[string]bool{}
        for _, it := range got {
                if it.Author != "mockuser" {
                        t.Fatalf("mine view leaked a foreign row: %+v", it)
                }
                ids[it.ID] = true
        }
        if !ids[one.ID] || !ids[two.ID] {
                t.Fatalf("mine view must carry both own items, got %v", ids)
        }
        if len(got) < 2 {
                t.Fatalf("mine view must have at least the two own items, got %d", len(got))
        }

        // the plain view keeps the foreign row (the filter is mine-only)
        all, err := svc.Items("canvas", "", "", "", true)
        if err != nil {
                t.Fatalf("Items: %v", err)
        }
        hasForeign := false
        for _, it := range all {
                if it.ID == foreign.ID {
                        hasForeign = true
                }
        }
        if !hasForeign {
                t.Fatalf("the plain view must still list the downloaded foreign item")
        }

        // disconnected → the honest error, never a lying empty list
        if err := svc.Disconnect(); err != nil {
                t.Fatalf("disconnect: %v", err)
        }
        if _, err := svc.ItemsMine("canvas", "", "", "", false); !errors.Is(err, ErrNotConnected) {
                t.Fatalf("disconnected mine must ErrNotConnected, got %v", err)
        }
}

func TestV1711_LineageSanitizers(t *testing.T) {
        if got := SanitizeUUID("  cvb_x " + strings.Repeat("y", 80)); len(got) != 64 || strings.Contains(got, " ") {
                t.Fatalf("SanitizeUUID = %q", got)
        }
        if got := SanitizeParentField("  alice   wonderland  ", 64); got != "alice wonderland" {
                t.Fatalf("SanitizeParentField = %q", got)
        }
        if got := SanitizeParentField("", 64); got != "" {
                t.Fatalf("empty stays empty, got %q", got)
        }
}
