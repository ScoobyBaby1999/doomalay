package hub

// hub_v0842_test.go — THE PERSONA BADGE transport (user spec: "Update all
// the persona library stuff to accept this new addition, as downloaded
// personas should include the custom badge, even if it was an uploaded
// image not our default basic color system").
//
// Pinned here:
//   1. SanitizeBadge — the kind + theme-token whitelists, the angle clamp,
//      the image path shape (unusable specs drop to nil, never stored).
//   2. a gradient badge rides the item meta verbatim (sanitized).
//   3. an IMAGE badge: the PNG commits at items/<id>/badge.png, the meta
//      points at it through Badge.File, and the item's Files list it —
//      the download side can fetch the bytes and re-upload engine-side.
//   4. a badge on a NON-persona type is ignored (personas are the only
//      badge carriers).

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestV842_SanitizeBadge(t *testing.T) {
	cases := []struct {
		name string
		in   *BadgeSpec
		want *BadgeSpec
	}{
		{"nil stays nil", nil, nil},
		{"solid ok", &BadgeSpec{Kind: "solid", Token: "accent"}, &BadgeSpec{Kind: "solid", Token: "accent"}},
		{"solid bad token", &BadgeSpec{Kind: "solid", Token: "background:url(x)"}, nil},
		{"gradient ok + angle clamp", &BadgeSpec{Kind: "gradient", From: "accent", To: "accent-2", Angle: 400},
			&BadgeSpec{Kind: "gradient", From: "accent", To: "accent-2", Angle: 40}},
		{"gradient negative angle", &BadgeSpec{Kind: "gradient", From: "ok", To: "warn", Angle: -90},
			&BadgeSpec{Kind: "gradient", From: "ok", To: "warn", Angle: 270}},
		{"gradient bad to-token", &BadgeSpec{Kind: "gradient", From: "accent", To: "nope"}, nil},
		{"image ok", &BadgeSpec{Kind: "image", File: "items/x-y/badge.png"},
			&BadgeSpec{Kind: "image", File: "items/x-y/badge.png"}},
		{"image traversal", &BadgeSpec{Kind: "image", File: "../etc/passwd"}, nil},
		{"image no ext", &BadgeSpec{Kind: "image", File: "items/x/badge"}, nil},
		{"unknown kind", &BadgeSpec{Kind: "neon", Token: "accent"}, nil},
		{"case-folded kind", &BadgeSpec{Kind: "SOLID", Token: "err"}, &BadgeSpec{Kind: "solid", Token: "err"}},
	}
	for _, c := range cases {
		got := SanitizeBadge(c.in)
		if c.want == nil {
			if got != nil {
				t.Fatalf("%s: want nil, got %+v", c.name, got)
			}
			continue
		}
		if got == nil {
			t.Fatalf("%s: want %+v, got nil", c.name, c.want)
		}
		if *got != *c.want {
			t.Fatalf("%s: want %+v, got %+v", c.name, *c.want, *got)
		}
	}
}

func TestV842_PersonaBadgePublish(t *testing.T) {
	m := newMockHF(t)
	seedHubFixtures(t, m)
	svc := newTestService(t, m)
	if _, err := svc.Connect("goodtoken"); err != nil {
		t.Fatalf("connect: %v", err)
	}

	// (2) the gradient badge rides the meta verbatim (sanitized)
	item, err := svc.Publish("persona", PublishRequest{
		Name:    "Ring Maker",
		Payload: "# Ring Maker\nbe circular",
		Badge:   &BadgeSpec{Kind: "gradient", From: "accent", To: "accent-2", Angle: 400},
	})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	if item.Badge == nil || item.Badge.Kind != "gradient" || item.Badge.From != "accent" ||
		item.Badge.To != "accent-2" || item.Badge.Angle != 40 {
		t.Fatalf("gradient badge = %+v", item.Badge)
	}
	meta, ok := m.file(item.Repo, "items/"+item.ID+".json")
	if !ok {
		t.Fatalf("meta missing")
	}
	var stored Item
	if err := json.Unmarshal(meta, &stored); err != nil {
		t.Fatalf("meta decode: %v", err)
	}
	if stored.Badge == nil || stored.Badge.Angle != 40 {
		t.Fatalf("stored badge = %+v", stored.Badge)
	}

	// (3) the IMAGE badge: PNG commits at items/<id>/badge.png, meta points
	// at it, Files lists it — the exact "uploaded image" transport.
	png := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 9, 9, 9, 9}
	item2, err := svc.Publish("persona", PublishRequest{
		Name:            "Art Ring",
		Payload:         "# Art Ring\nwear the art",
		Badge:           &BadgeSpec{Kind: "image"}, // the bytes decide the file
		BadgePNGBase64:  b64enc(png),
	})
	if err != nil {
		t.Fatalf("publish image badge: %v", err)
	}
	badgePath := "items/" + item2.ID + "/badge.png"
	if item2.Badge == nil || item2.Badge.Kind != "image" || item2.Badge.File != badgePath {
		t.Fatalf("image badge = %+v", item2.Badge)
	}
	listed := false
	for _, f := range item2.Files {
		if f == badgePath {
			listed = true
		}
	}
	if !listed {
		t.Fatalf("badge path %s not in Files %v", badgePath, item2.Files)
	}
	if b, ok := m.file(item2.Repo, badgePath); !ok || !strings.HasPrefix(string(b), "\x89PNG") {
		t.Fatalf("badge.png bytes missing/wrong in the repo (ok=%v)", ok)
	}
	meta2, _ := m.file(item2.Repo, "items/"+item2.ID+".json")
	var stored2 Item
	if err := json.Unmarshal(meta2, &stored2); err != nil {
		t.Fatalf("meta2 decode: %v", err)
	}
	if stored2.Badge == nil || stored2.Badge.File != badgePath {
		t.Fatalf("stored image badge = %+v", stored2.Badge)
	}

	// (4) a badge on a NON-persona type is ignored
	item3, err := svc.Publish("skill", PublishRequest{
		Name:    "No Badge Skill",
		Payload: "# No Badge Skill\nwork",
		Badge:   &BadgeSpec{Kind: "solid", Token: "accent"},
	})
	if err != nil {
		t.Fatalf("publish skill: %v", err)
	}
	if item3.Badge != nil {
		t.Fatalf("skill badge should be ignored, got %+v", item3.Badge)
	}
}
