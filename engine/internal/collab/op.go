// Package collab — v1.69.1 THE SHARED CANVAS (PLAN-V169): the
// server-authoritative document sync core. The design is Figma's
// published multiplayer architecture, adapted to doomalay's WorldState:
//
//   - the DOC is the shared plane of a canvas: icons[], dots[],
//     currentFamily, worldSize — addressed BY ID (client-minted, stable),
//     property-level (LWW per (id, property) with SERVER ARRIVAL ORDER as
//     the one clock — no client timestamps, ever);
//   - the VIEW (camera, the settings slice) is personal and never syncs;
//   - ops are explicit domain frames (icon.set / icon.add / icon.remove /
//     dot.* / doc.set) — NOT JSON Patch (RFC 6902's positional pointers
//     break under concurrent array mutation and carry no conflict
//     semantics; production editors are ID-addressed);
//   - durability = checkpoint (canvases.state) + per-canvas seq journal
//     (canvas_ops) — the chat_events law promoted to the document;
//   - replay-safe by construction: every fold op on an absent id is a
//     no-op, every .add for an existing id is a no-op (an at-least-once
//     redelivery can never double-apply).
//
// This file owns the wire types + the strict validation matrix.
package collab

import (
	"encoding/json"
	"errors"
	"fmt"
)

// OpKind — the domain op vocabulary. Icons and dots are ID-addressed;
// doc.set carries path+value for the scalar document fields.
type OpKind string

const (
	OpIconSet    OpKind = "icon.set"    // props: the CHANGED fields only
	OpIconAdd    OpKind = "icon.add"    // icon: the full serialize()
	OpIconRemove OpKind = "icon.remove" // id
	OpDotSet     OpKind = "dot.set"     // props
	OpDotAdd     OpKind = "dot.add"     // dot: the full serialize()
	OpDotRemove  OpKind = "dot.remove"  // id
	OpDocSet     OpKind = "doc.set"     // path: currentFamily|worldSize, value
)

// DocSetPath — the scalar document fields (worldSize is STRUCTURAL: two
// devices on different plate sizes would diverge the same canvas; it
// therefore rides the doc, not the personal settings).
const (
	PathCurrentFamily = "currentFamily"
	PathWorldSize     = "worldSize"
)

// MaxOpBytes — one op frame's size ceiling (an icon.add with a large
// custom icon is the honest ceiling carrier; a full serialize() is
// well under this).
const MaxOpBytes = 256 << 10

// MaxOpsPerBatch — one submit's batch ceiling (a 200ms-debounced diff of
// a pathological world; the room folds batches, not oceans).
const MaxOpsPerBatch = 256

// Op is the wire frame. Client→server carries opId/kind/id + the
// kind-specific payload; server→clients is the same frame stamped with
// seq/device/at (the ack, the ordering, and the fan-out are ONE
// mechanism — the server broadcasts every accepted op to everyone
// including its author).
type Op struct {
	OpID  string          `json:"opId"` // "<deviceId>:<counter>" — retry-stable (the dedupe key)
	Kind  OpKind          `json:"kind"`
	ID    string          `json:"id"` // icon/dot id; "_" for doc.set
	Props json.RawMessage `json:"props,omitempty"`
	Value json.RawMessage `json:"value,omitempty"` // doc.set
	Path  string          `json:"path,omitempty"`  // doc.set
	Icon  json.RawMessage `json:"icon,omitempty"`  // icon.add
	Dot   json.RawMessage `json:"dot,omitempty"`   // dot.add

	// Server stamps (never trusted from a client frame).
	Seq    int     `json:"seq,omitempty"`
	Device string  `json:"device,omitempty"`
	At     float64 `json:"at,omitempty"`
}

// The validation matrix errors.
var (
	ErrOpUnknownKind = errors.New("collab: unknown op kind")
	ErrOpNoID        = errors.New("collab: op id required")
	ErrOpNoProps     = errors.New("collab: op props must be a non-empty JSON object")
	ErrOpNoPayload   = errors.New("collab: op payload required")
	ErrOpBadPath     = errors.New("collab: doc.set path must be currentFamily or worldSize")
	ErrOpNoOpID      = errors.New("collab: opId required")
	ErrOpNoIconID    = errors.New("collab: added icon must carry a string id")
	ErrOpNoDotID     = errors.New("collab: added dot must carry a string id")
)

// ValidateOp is the strict admission matrix (the server never folds an
// unvalidated frame). ID presence is checked per kind; props must be a
// non-empty JSON object; .add payloads must be JSON objects with a
// string id; doc.set paths are the closed set.
func ValidateOp(op Op) error {
	if op.OpID == "" {
		return ErrOpNoOpID
	}
	switch op.Kind {
	case OpIconSet, OpDotSet:
		if op.ID == "" {
			return ErrOpNoID
		}
		return validateProps(op.Props)
	case OpIconRemove, OpDotRemove:
		if op.ID == "" {
			return ErrOpNoID
		}
		return nil
	case OpIconAdd:
		return validateAdd(op.Icon, "icon")
	case OpDotAdd:
		return validateAdd(op.Dot, "dot")
	case OpDocSet:
		if op.Path != PathCurrentFamily && op.Path != PathWorldSize {
			return ErrOpBadPath
		}
		if len(op.Value) == 0 {
			return ErrOpNoPayload
		}
		return nil
	default:
		return fmt.Errorf("%w: %q", ErrOpUnknownKind, string(op.Kind))
	}
}

// validateProps: a non-empty JSON object whose top-level values are
// JSON primitives, arrays, or objects (any encodeable value — the fold
// merges at the property level).
func validateProps(raw json.RawMessage) error {
	if len(raw) == 0 {
		return ErrOpNoProps
	}
	var props map[string]json.RawMessage
	if err := json.Unmarshal(raw, &props); err != nil {
		return ErrOpNoProps
	}
	if len(props) == 0 {
		return ErrOpNoProps
	}
	return nil
}

// validateAdd: the .add payload is a JSON object carrying a non-empty
// string id (the identity the fold keys on).
func validateAdd(raw json.RawMessage, what string) error {
	if len(raw) == 0 {
		return ErrOpNoPayload
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return ErrOpNoPayload
	}
	idv, ok := obj["id"]
	if !ok || len(idv) == 0 {
		if what == "icon" {
			return ErrOpNoIconID
		}
		return ErrOpNoDotID
	}
	var id string
	if err := json.Unmarshal(idv, &id); err != nil || id == "" {
		if what == "icon" {
			return ErrOpNoIconID
		}
		return ErrOpNoDotID
	}
	return nil
}
