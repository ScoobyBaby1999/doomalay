package llm

// ocpocket.go — v1.63.2 THE DYNAMIC WALL (PLAN-V163 §2).
//
// The ANDROID FreeTierError message ("OpenCode's free models are walled to
// their own client…") names the phone's OWN missing rungs — the user's
// ask, verbatim: "we have it display either the first or the second
// depending on what is installed and what is not, aswell as the download
// size, model, and the termux/opencode is installed dynamic messages
// included somewhere."
//
// The llm package cannot import the server package (server imports llm —
// the dependency arrow points one way), so the server INJECTS its pocket
// truth here at boot: Server wiring sets OcPocketProbe to a closure that
// reads the termux status + the ocserve manager + the zip size hint.
// The message builder calls it defensively — a nil probe (unit tests, an
// un-wired embed) falls back to the static copy that always told the
// whole path at once.

// OcPocketState is the pocket-bridge truth for the walled-tier message.
type OcPocketState struct {
	// TermuxInstalled: the Termux app is present on the device.
	TermuxInstalled bool
	// TermuxReady: installed AND the RUN_COMMAND permission granted (the
	// one-line bootstrap has run).
	TermuxReady bool
	// BridgeUp: a healthy pocket-bridge serve is answering — the free
	// models work; this wall came from the direct zen line.
	BridgeUp bool
	// Installing: the engine-led install is in flight right now.
	Installing bool
	// SizeHint: the live one-time download size ("72.5MB" — the pinned
	// zip's own hint, never a hardcoded number).
	SizeHint string
}

// OcPocketProbe is set by the server at boot (never called before then;
// read-only, race-free by the write-once-before-serve law).
var OcPocketProbe func() OcPocketState
