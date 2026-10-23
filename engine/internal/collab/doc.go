// doc.go — v1.69.1 THE SHARED CANVAS: the authoritative fold. The DOC is
// the shared projection of a WorldState: icons[], dots[], currentFamily,
// worldSize. FoldOp applies ONE validated op to a state's doc plane in
// place — the exact law the PWA's collabcore.js twin implements, so the
// same op sequence folds to the same doc on both sides (the twin law,
// rig-pinned).
//
// THE REPLAY-SAFE LAWS (every fold op is idempotent under redelivery):
//   - icon.add for an EXISTING id   → no-op (never double-add; the
//     client's own dup-id heal stays a client-side boot guard, not a
//     sync law)
//   - icon.set / icon.remove for an ABSENT id → no-op (a set can never
//     resurrect; a remove can never error)
//   - dot.*                         → the same laws on dots
//   - doc.set                       → the scalar fields
//
// ORDER: icons append at the END of the array (addEntity order — the
// z/render order law); the server seq is the one total order, so every
// device converges on the same array order without a reorder op.
package collab

import (
	"encoding/json"
	"errors"
	"fmt"
)

// ErrFoldState is the fold's one error class: the state is not a JSON
// object (the canvas state contract — isObjectJSON's twin).
var ErrFoldState = errors.New("collab: canvas state is not a JSON object")

// StateObject decodes the row state into the fold's working shape. An
// empty/absent state folds into a fresh shell (a canvas born shared).
func StateObject(stateJSON string) (map[string]any, error) {
	if len(stateJSON) == 0 {
		return map[string]any{}, nil
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(stateJSON), &obj); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrFoldState, err)
	}
	if obj == nil {
		return map[string]any{}, nil
	}
	return obj, nil
}

// FoldOp applies one VALIDATED op to the state's doc plane, in place.
// The view plane (offset/scale/settings/savedAt/...) is never touched.
func FoldOp(state map[string]any, op Op) error {
	if state == nil {
		return ErrFoldState
	}
	switch op.Kind {
	case OpIconSet:
		return foldSet(state, "icons", op.ID, op.Props)
	case OpIconAdd:
		return foldAdd(state, "icons", op.Icon)
	case OpIconRemove:
		foldRemove(state, "icons", op.ID)
		return nil
	case OpDotSet:
		return foldSet(state, "dots", op.ID, op.Props)
	case OpDotAdd:
		return foldAdd(state, "dots", op.Dot)
	case OpDotRemove:
		foldRemove(state, "dots", op.ID)
		return nil
	case OpDocSet:
		return foldDocSet(state, op)
	default:
		// unreachable past ValidateOp; the fold is still honest.
		return fmt.Errorf("%w: %q", ErrOpUnknownKind, string(op.Kind))
	}
}

// iconList coerces the state's plane to a []any (absent → a fresh list;
// a non-list → replaced — a corrupt row heals rather than crashes).
func planeList(state map[string]any, key string) []any {
	raw, ok := state[key]
	if !ok || raw == nil {
		out := []any{}
		state[key] = out
		return out
	}
	list, ok := raw.([]any)
	if !ok {
		out := []any{}
		state[key] = out
		return out
	}
	return list
}

// foldSet — LWW per property: merge op.Props into the object with the
// matching id. Absent id → no-op (the replay-safe law).
func foldSet(state map[string]any, plane, id string, props json.RawMessage) error {
	list := planeList(state, plane)
	var target map[string]any
	for _, item := range list {
		if m, ok := item.(map[string]any); ok {
			if iid, _ := m["id"].(string); iid == id {
				target = m
				break
			}
		}
	}
	if target == nil {
		return nil
	}
	var patch map[string]any
	if err := json.Unmarshal(props, &patch); err != nil {
		return fmt.Errorf("collab: bad props: %v", err)
	}
	for k, v := range patch {
		target[k] = v
	}
	return nil
}

// foldAdd — append the payload object at the END; an existing id is a
// no-op (redelivery can never double-add).
func foldAdd(state map[string]any, plane string, payload json.RawMessage) error {
	var obj map[string]any
	if err := json.Unmarshal(payload, &obj); err != nil {
		return fmt.Errorf("collab: bad add payload: %v", err)
	}
	id, _ := obj["id"].(string)
	list := planeList(state, plane)
	for _, item := range list {
		if m, ok := item.(map[string]any); ok {
			if iid, _ := m["id"].(string); iid == id {
				return nil
			}
		}
	}
	state[plane] = append(list, obj)
	return nil
}

// foldRemove — splice the id out; absent → no-op.
func foldRemove(state map[string]any, plane, id string) {
	raw, ok := state[plane]
	if !ok {
		return
	}
	list, ok := raw.([]any)
	if !ok {
		return
	}
	out := make([]any, 0, len(list))
	for _, item := range list {
		if m, ok := item.(map[string]any); ok {
			if iid, _ := m["id"].(string); iid == id {
				continue
			}
		}
		out = append(out, item)
	}
	state[plane] = out
}

// foldDocSet — the scalar fields. worldSize rides the doc (structural);
// currentFamily rides the doc (the icon family for NEW chats is canvas
// content). Value shapes are the client's truth: family is a string,
// worldSize a JSON number — but the fold accepts whatever encodes and
// stores it raw (the PWA's own ladder snaps strays at apply time).
func foldDocSet(state map[string]any, op Op) error {
	var value any
	if err := json.Unmarshal(op.Value, &value); err != nil {
		return fmt.Errorf("collab: bad doc.set value: %v", err)
	}
	switch op.Path {
	case PathCurrentFamily:
		state[PathCurrentFamily] = value
	case PathWorldSize:
		state[PathWorldSize] = value
	default:
		return ErrOpBadPath
	}
	return nil
}

// FoldOps folds a whole seq-ordered batch, stopping at the first error
// (the caller's tx already rolled the journal back; a half-folded
// in-memory doc never reaches a checkpoint write).
func FoldOps(state map[string]any, ops []Op) error {
	for _, op := range ops {
		if err := FoldOp(state, op); err != nil {
			return err
		}
	}
	return nil
}
