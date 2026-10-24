package server

// honestdoor_v1746_test.go — v1.74.6 THE HONEST DOOR pins: the rebase
// trap dies at the source (the API-only truth is STATED, never
// discovered by failing — the user's bullet 3: the model that wanted to
// rebase reached for termux because nothing said the workspace tool
// cannot), the device-row split, the complete teaches, and the
// scratch-dir truth.

import (
	"strings"
	"testing"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/forge"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// TestV1746_APLOnlyTruth — the CONNECTED block states the limits: no
// clone, no rebase/merge/cherry-pick, sync is the rebase eye, real git
// runs on the termux device.
func TestV1746_APLOnlyTruth(t *testing.T) {
	s, sid, _, _ := newV1742Server(t)
	manifest := s.workspaceManifestFor(sid)
	for _, want := range []string{
		"HONEST LIMITS",
		"NO local clone",
		"rebase, merge and cherry-pick DO NOT EXIST",
		"sync",
		"termux tool's exec",
	} {
		if !strings.Contains(manifest, want) {
			t.Fatalf("the manifest must state %q:\n%s", want, manifest)
		}
	}
	// the public block carries the truth too
	pub := s.workspaceManifestFor("no-such-session")
	if !strings.Contains(pub, "REST-API-only") {
		t.Fatalf("the public block must state the API-only truth:\n%s", pub)
	}
}

// TestV1746_DeviceRowSplit — a termux-kind row never leaks into the
// CONNECTED CLOUD WORKSPACES block (the manufactured "lookup device:
// no such host" dead-end dies).
func TestV1746_DeviceRowSplit(t *testing.T) {
	s, sid, _, _ := newV1742Server(t)
	// bind a termux-kind row to the same session
	tx := &store.Workspace{ID: "v1746tx", Name: "my-phone", Kind: "termux", Access: forge.AccessFull}
	if err := s.db.CreateWorkspace(tx); err != nil {
		t.Fatalf("termux row: %v", err)
	}
	if err := s.db.BindWorkspace(sid, tx.ID); err != nil {
		t.Fatalf("bind: %v", err)
	}
	manifest := s.workspaceManifestFor(sid)
	if strings.Contains(manifest, "my-phone") {
		t.Fatalf("a termux row must not ride the cloud-workspaces block:\n%s", manifest)
	}
	cloud := s.sessionCloudWorkspaces(sid)
	for _, ws := range cloud {
		if ws.Kind == "termux" || ws.Kind == "device" {
			t.Fatalf("sessionCloudWorkspaces must not return %s rows: %+v", ws.Kind, ws)
		}
	}
}

// TestV1746_CompleteTeaches — the unknown-tool teach lines carry the
// FULL verb lists (the old shapes re-taught pre-V161 maps exactly on
// the fumble path).
func TestV1746_CompleteTeaches(t *testing.T) {
	src := srcOf(t, "../llm/chat.go")
	for _, want := range []string{
		"help|list|info|tree|ls|read|readme|grep|view|put|patch|commit|sync|pr|",
		// v1.74.10 THE GIT HAND extends the complete teach: the four
		// git verbs ride between git_setup and the file verbs.
		"exec|cmds|git_setup|git_status|git_pull|git_push|git_commit|ls|read|write|append|patch|rm|mkdir|grep|find|pkg|",
		"SURGICAL PATCH",
	} {
		if !strings.Contains(src, want) {
			t.Fatalf("the complete teach lost %q", want)
		}
	}
	// the stale 20-verb shape is dead
	if strings.Contains(src, "help|list|ls|read|grep|view|put|pr|pr_diff|pr_review") {
		t.Fatal("the stale 20-of-30 workspace teach still rides")
	}
}

// TestV1746_ScratchDirTruth — the serve pick line names the shell's
// scratch cwd and points real git at the termux exec.
func TestV1746_ScratchDirTruth(t *testing.T) {
	src := srcOf(t, "ocservetools.go")
	for _, want := range []string{
		"SCRATCH sandbox",
		"real git (clone/rebase/push) runs through doomalay_termux",
	} {
		if !strings.Contains(src, want) {
			t.Fatalf("the serve pick line lost %q", want)
		}
	}
}
