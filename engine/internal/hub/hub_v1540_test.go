package hub

// hub_v1540_test.go — v1.54 THE LIBRARY SHIP engine tests (PLAN-V154 §3
// phase 1): the canvas/chat registry entries, the per-type payload caps,
// the multipart/binary publish path, the .gitattributes LFS seed, the
// payload-bypass download law, and the streaming payload gate.

import (
        "bytes"
        "encoding/json"
        "io"
        "strings"
        "testing"
)

// ── the registry ──────────────────────────────────────────────────────────

func TestV1540_RegistryCanvasChat(t *testing.T) {
        cv, err := Get("canvas")
        if err != nil {
                t.Fatalf("canvas not registered: %v", err)
        }
        if cv.Tag != "doomalay-canvas" || cv.PayloadExt != ".doomcanvas" {
                t.Fatalf("canvas spec = %+v", cv)
        }
        // the foot-gun fix: "doomalay-canvases", never "doomalay-canvass"
        if cv.RepoName() != "doomalay-canvases" {
                t.Fatalf("canvas RepoName = %q", cv.RepoName())
        }
        if cv.Hidden {
                t.Fatalf("canvas must NOT be hidden — the manager's browse row flips on it")
        }
        if !cv.BigPayload() {
                t.Fatalf("canvas must be BigPayload (multipart + stream + bypass)")
        }
        if cv.PayloadMaxBytes() != 96<<20 {
                t.Fatalf("canvas payload cap = %d", cv.PayloadMaxBytes())
        }

        ch, err := Get("chat")
        if err != nil {
                t.Fatalf("chat not registered: %v", err)
        }
        if ch.Tag != "doomalay-chat" || ch.PayloadExt != ".doomchat" {
                t.Fatalf("chat spec = %+v", ch)
        }
        if ch.RepoName() != "doomalay-chats" {
                t.Fatalf("chat RepoName = %q", ch.RepoName())
        }
        if ch.Hidden || !ch.BigPayload() {
                t.Fatalf("chat hidden/big = %v/%v", ch.Hidden, ch.BigPayload())
        }
        if ch.PayloadMaxBytes() != 40<<20 {
                t.Fatalf("chat payload cap = %d", ch.PayloadMaxBytes())
        }

        // the moved caps: theme 24MB (the old server special-case), persona 64KB
        th, err := Get("theme")
        if err != nil || th.PayloadMaxBytes() != 24<<20 {
                t.Fatalf("theme cap = %d (%v)", th.PayloadMaxBytes(), err)
        }
        pe, err := Get("persona")
        if err != nil || pe.PayloadMaxBytes() != 64<<10 {
                t.Fatalf("persona cap = %d (%v)", pe.PayloadMaxBytes(), err)
        }
        if pe.BigPayload() {
                t.Fatalf("persona must NOT be BigPayload")
        }
        // every default-suffix type still pluralizes the old way
        if pe.RepoName() != "doomalay-personas" {
                t.Fatalf("persona RepoName = %q", pe.RepoName())
        }
}

// ── the publish path: binary payload + LFS seed + Size ───────────────────

func TestV1540_PublishCanvasBinaryRidesLFS(t *testing.T) {
        m := newMockHF(t)
        seedHubFixtures(t, m)
        svc := newTestService(t, m)
        if _, err := svc.Connect("goodtoken"); err != nil {
                t.Fatalf("connect: %v", err)
        }

        // a fake .doomcanvas (the bytes' shape is the web rig's business —
        // here only the transport is under test)
        zipBytes := bytes.Repeat([]byte{0x50, 0x4B, 0x03, 0x04}, 4) // "PK.." ×4
        item, err := svc.Publish("canvas", PublishRequest{
                Name:         "Test World",
                Description:  "a world published from a test",
                PayloadBytes: zipBytes,
        })
        if err != nil {
                t.Fatalf("publish canvas: %v", err)
        }
        repo := "mockuser/doomalay-canvases"
        if item.Repo != repo {
                t.Fatalf("item repo = %q", item.Repo)
        }
        if item.File != "items/"+item.ID+".doomcanvas" {
                t.Fatalf("item file = %q", item.File)
        }
        if item.Size != int64(len(zipBytes)) {
                t.Fatalf("item.Size = %d, want %d", item.Size, len(zipBytes))
        }

        // the .gitattributes seed: all three LFS lines present on first publish
        attrs, ok := m.file(repo, ".gitattributes")
        if !ok {
                t.Fatalf("no .gitattributes seeded in %s", repo)
        }
        for _, ext := range []string{".doomcanvas", ".doomchat", ".doomtheme"} {
                if !strings.Contains(string(attrs), "*"+ext+" filter=lfs") {
                        t.Fatalf(".gitattributes missing the %s LFS line: %q", ext, attrs)
                }
        }

        // the payload rode the LFS path: the mock's presigned bucket holds the
        // EXACT bytes and the repo file resolves to them (byte-identical)
        if b, ok := m.file(repo, item.File); !ok || !bytes.Equal(b, zipBytes) {
                t.Fatalf("payload did not round-trip through LFS (%v bytes)", len(b))
        }
        // the meta row + index exist; the meta carries Size
        meta, _ := m.file(repo, "items/"+item.ID+".json")
        var stored Item
        if err := json.Unmarshal(meta, &stored); err != nil {
                t.Fatalf("stored meta: %v", err)
        }
        if stored.Size != int64(len(zipBytes)) || stored.Type != "canvas" {
                t.Fatalf("stored meta = %+v", stored)
        }
        if _, ok := m.file(repo, "items/index.json"); !ok {
                t.Fatalf("index.json not regenerated")
        }

        // payload-bypass: the PUBLISHER's local row stores meta only
        row, err := GetLocalItem(svc.db, "canvas", item.ID)
        if err != nil {
                t.Fatalf("local row: %v", err)
        }
        if row.Payload != "" {
                t.Fatalf("local canvas row must not store the payload (payload-bypass), got %d bytes", len(row.Payload))
        }
        if row.DownloadedAt == "" {
                t.Fatalf("the publisher's own row must be marked downloaded")
        }

        // the seed is idempotent: a second publish adds NO second .gitattributes
        // commit (the publish + its metrics event are the only new commits —
        // assert by the seed-commit count, which must stay exactly 1)
        if _, err := svc.Publish("canvas", PublishRequest{Name: "Test World", PayloadBytes: zipBytes}); err != nil {
                t.Fatalf("republish: %v", err)
        }
        seedCommits := 0
        for _, c := range m.commits {
                if strings.Contains(c, `"seed LFS attributes"`) {
                        seedCommits++
                }
        }
        if seedCommits != 1 {
                t.Fatalf("LFS seed committed %d times (want exactly 1)", seedCommits)
        }
        attrs2, _ := m.file(repo, ".gitattributes")
        if !bytes.Equal(attrs, attrs2) {
                t.Fatalf(".gitattributes changed on republish (not idempotent)")
        }
}

func TestV1540_PublishCapMatrix(t *testing.T) {
        m := newMockHF(t)
        seedHubFixtures(t, m)
        svc := newTestService(t, m)
        if _, err := svc.Connect("goodtoken"); err != nil {
                t.Fatalf("connect: %v", err)
        }

        cases := []struct {
                typ   string
                name  string
                bytes int
                ok    bool
        }{
                {"canvas", "Cap World", 96 << 20, true},
                {"canvas", "Cap World", 96<<20 + 1, false},
                {"chat", "Cap Chat", 40 << 20, true},
                {"chat", "Cap Chat", 40<<20 + 1, false},
                {"theme", "Cap Theme", 24 << 20, true},
                {"theme", "Cap Theme", 24<<20 + 1, false},
                {"persona", "Cap Persona", 64 << 10, true},
                {"persona", "Cap Persona", 64<<10 + 1, false},
        }
        for _, tc := range cases {
                payload := bytes.Repeat([]byte("x"), tc.bytes)
                _, err := svc.Publish(tc.typ, PublishRequest{Name: tc.name, PayloadBytes: payload})
                if tc.ok && err != nil {
                        t.Fatalf("%s at %d bytes rejected: %v", tc.typ, tc.bytes, err)
                }
                if !tc.ok && err == nil {
                        t.Fatalf("%s at %d bytes ACCEPTED (over the cap)", tc.typ, tc.bytes)
                }
        }
        // the string path carries the same caps (the theme legacy path)
        if _, err := svc.Publish("theme", PublishRequest{Name: "T", Payload: strings.Repeat("y", 24<<20)}); err != nil {
                t.Fatalf("theme string payload at the cap: %v", err)
        }
        if _, err := svc.Publish("persona", PublishRequest{Name: "P", Payload: strings.Repeat("y", 64<<10+1)}); err == nil {
                t.Fatalf("persona string payload over the cap accepted")
        }
}

// ── the download path: payload-bypass + the stream gate ───────────────────

func TestV1540_DownloadBypassAndPayloadStream(t *testing.T) {
        m := newMockHF(t)
        seedHubFixtures(t, m)
        publisher := newTestService(t, m)
        if _, err := publisher.Connect("goodtoken"); err != nil {
                t.Fatalf("connect: %v", err)
        }
        zipBytes := []byte("PK\x03\x04 the test doomcanvas body — 32 bytes!!")
        item, err := publisher.Publish("canvas", PublishRequest{Name: "Stream World", PayloadBytes: zipBytes})
        if err != nil {
                t.Fatalf("publish: %v", err)
        }
        repo := item.Repo

        // a SECOND service (a different device) discovers + downloads it.
        // Discovery rides the tag channel; the download is meta-only.
        reader := newTestService(t, m)
        items, err := reader.Items("canvas", "", "", "", false)
        if err != nil {
                t.Fatalf("items: %v", err)
        }
        var found *Item
        for i := range items {
                if items[i].ID == item.ID {
                        found = &items[i]
                }
        }
        if found == nil {
                t.Fatalf("published canvas not discoverable via the tag channel")
        }

        gotItem, payload, err := reader.Download("canvas", repo, item.ID)
        if err != nil {
                t.Fatalf("download: %v", err)
        }
        if payload != "" {
                t.Fatalf("canvas download must return an EMPTY payload (payload-bypass), got %d bytes", len(payload))
        }
        if gotItem.Size != int64(len(zipBytes)) {
                t.Fatalf("downloaded item Size = %d", gotItem.Size)
        }

        // ItemDetail never drags the zip either
        _, detailPayload, err := reader.ItemDetail("canvas", repo, item.ID)
        if err != nil {
                t.Fatalf("detail: %v", err)
        }
        if detailPayload != "" {
                t.Fatalf("canvas detail must return an EMPTY payload, got %d bytes", len(detailPayload))
        }

        // the stream gate: a NOT-downloaded item refuses (the endorsement
        // gate's twin)
        fresh := newTestService(t, m)
        if _, _, err := fresh.PayloadStream("canvas", repo, item.ID); err != ErrNotDownloaded {
                t.Fatalf("stream before download = %v, want ErrNotDownloaded", err)
        }

        // the stream: the exact bytes, through the mock's LFS resolve path
        body, n, err := reader.PayloadStream("canvas", repo, item.ID)
        if err != nil {
                t.Fatalf("stream: %v", err)
        }
        defer body.Close()
        if n != int64(len(zipBytes)) {
                t.Fatalf("stream length = %d, want %d", n, len(zipBytes))
        }
        streamed, err := io.ReadAll(body)
        if err != nil {
                t.Fatalf("read stream: %v", err)
        }
        if !bytes.Equal(streamed, zipBytes) {
                t.Fatalf("streamed bytes differ from the published payload (%d vs %d)", len(streamed), len(zipBytes))
        }

        // the repo-match gate: a mismatched repo refuses
        if _, _, err := reader.PayloadStream("canvas", "otheruser/doomalay-canvases", item.ID); err == nil {
                t.Fatalf("stream with a mismatched repo accepted")
        }

        // endorsement is unlocked by the download (the gate rides)
        if _, err := reader.Endorse("canvas", repo, item.ID, true); err != nil {
                t.Fatalf("endorse after download: %v", err)
        }
}

// ── the chat type rides the same rails ────────────────────────────────────

func TestV1540_ChatTypeEndToEnd(t *testing.T) {
        m := newMockHF(t)
        seedHubFixtures(t, m)
        svc := newTestService(t, m)
        if _, err := svc.Connect("goodtoken"); err != nil {
                t.Fatalf("connect: %v", err)
        }
        chatBytes := []byte("PK\x03\x04 the test doomchat body")
        item, err := svc.Publish("chat", PublishRequest{Name: "Great Conversation", PayloadBytes: chatBytes})
        if err != nil {
                t.Fatalf("publish chat: %v", err)
        }
        if item.Repo != "mockuser/doomalay-chats" {
                t.Fatalf("chat repo = %q", item.Repo)
        }
        if item.File != "items/"+item.ID+".doomchat" {
                t.Fatalf("chat file = %q", item.File)
        }
        // the .doomchat LFS line was seeded (rides the same .gitattributes)
        attrs, _ := m.file(item.Repo, ".gitattributes")
        if !strings.Contains(string(attrs), "*.doomchat filter=lfs") {
                t.Fatalf("chat LFS line missing: %q", attrs)
        }
        // the payload round-tripped through LFS
        if b, ok := m.file(item.Repo, item.File); !ok || !bytes.Equal(b, chatBytes) {
                t.Fatalf("chat payload did not round-trip")
        }
        // download → bypass → stream
        _, payload, err := svc.Download("chat", item.Repo, item.ID)
        if err != nil || payload != "" {
                t.Fatalf("chat download = %v / %d bytes", err, len(payload))
        }
        body, n, err := svc.PayloadStream("chat", item.Repo, item.ID)
        if err != nil {
                t.Fatalf("chat stream: %v", err)
        }
        defer body.Close()
        got, _ := io.ReadAll(body)
        if !bytes.Equal(got, chatBytes) || n != int64(len(chatBytes)) {
                t.Fatalf("chat stream bytes differ")
        }
}
