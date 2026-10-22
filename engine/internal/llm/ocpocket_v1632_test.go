package llm

// ocpocket_v1632_test.go — v1.63.2 THE DYNAMIC WALL pins (PLAN-V163 §2):
// the ANDROID walled-tier message names the phone's OWN missing rungs, the
// model, and the live download size — the user's ask #1, verbatim: "we
// have it display either the first or the second depending on what is
// installed and what is not, aswell as the download size, model, and the
// termux/opencode is installed dynamic messages included somewhere."

import (
	"strings"
	"testing"
)

func TestV1632_WalledMessageLadder(t *testing.T) {
	// THE NIL PROBE — the un-wired embed keeps the full static path (never
	// a blank, never a crash).
	saved := OcPocketProbe
	defer func() { OcPocketProbe = saved }()
	OcPocketProbe = nil
	got := ocWalledAndroidMessage("opencode/big-pickle")
	for _, want := range []string{"walled to their own client", "big-pickle", "'+ install opencode'", "POCKET BRIDGE"} {
		if !strings.Contains(got, want) {
			t.Errorf("nil-probe fallback: message %q missing %q", got, want)
		}
	}

	// THE SETUP PATH — nothing installed: the user's FIRST variant
	// (near-verbatim) + the model + the size.
	OcPocketProbe = func() OcPocketState {
		return OcPocketState{SizeHint: "72.5MB"}
	}
	got = ocWalledAndroidMessage("opencode/big-pickle")
	for _, want := range []string{
		"Opencode requires Termux setup and the Opencode install",
		"expanding the chat metadata → Capabilities → Termux",
		"cloud provider menu, press the '+ install opencode' pill (one-time ~72.5MB download)",
		"big-pickle",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("setup path: message %q missing %q", got, want)
		}
	}
	if strings.Contains(got, "Termux is set up ✓") {
		t.Errorf("setup path: message %q must NOT claim termux is set up", got)
	}

	// THE INSTALLED-TERMUX MIDPOINT — the app is there but not bootstrapped:
	// the copy acknowledges the install instead of demanding it.
	OcPocketProbe = func() OcPocketState {
		return OcPocketState{TermuxInstalled: true, SizeHint: "72.5MB"}
	}
	got = ocWalledAndroidMessage("opencode/big-pickle")
	if !strings.Contains(got, "Termux is installed — finish its setup") {
		t.Errorf("midpoint: message %q missing the finish-its-setup copy", got)
	}

	// THE INSTALL PATH — termux ready, opencode missing: the user's SECOND
	// variant + the installed-state truth ("Termux is set up ✓").
	OcPocketProbe = func() OcPocketState {
		return OcPocketState{TermuxInstalled: true, TermuxReady: true, SizeHint: "72.5MB"}
	}
	got = ocWalledAndroidMessage("opencode/big-pickle")
	for _, want := range []string{
		"Termux is set up ✓ — one step left",
		"'+ install opencode' pill (one-time ~72.5MB download)",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("install path: message %q missing %q", got, want)
		}
	}
	if strings.Contains(got, "Opencode requires Termux setup") {
		t.Errorf("install path: message %q must not re-demand termux setup", got)
	}

	// THE HONEST WAIT — the install is in flight.
	OcPocketProbe = func() OcPocketState {
		return OcPocketState{TermuxInstalled: true, TermuxReady: true, Installing: true, SizeHint: "72.5MB"}
	}
	got = ocWalledAndroidMessage("opencode/big-pickle")
	if !strings.Contains(got, "install is running right now") {
		t.Errorf("installing: message %q missing the honest wait", got)
	}

	// THE LIVE BRIDGE — a healthy serve answers; the copy says retry.
	OcPocketProbe = func() OcPocketState {
		return OcPocketState{TermuxInstalled: true, TermuxReady: true, BridgeUp: true, SizeHint: "72.5MB"}
	}
	got = ocWalledAndroidMessage("opencode/big-pickle")
	if !strings.Contains(got, "pocket bridge is live") {
		t.Errorf("bridge up: message %q missing the live-bridge truth", got)
	}

	// THE SIZE RIDES THE PROBE — never a hardcoded number when the route
	// answers one (the zip pin is live versioned).
	OcPocketProbe = func() OcPocketState {
		return OcPocketState{SizeHint: "81.2MB"}
	}
	got = ocWalledAndroidMessage("opencode/big-pickle")
	if !strings.Contains(got, "~81.2MB") {
		t.Errorf("size hint: message %q missing the live size", got)
	}
}
