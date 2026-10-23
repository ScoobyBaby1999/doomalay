package collab

// doc_v1691_test.go — v1.69.1 THE SHARED CANVAS (PLAN-V169 §v1.69.1): the
// fold laws, rig-proven at the pure layer:
//
//   (1)  the validation matrix: every legal kind admits, every illegal
//        shape rejects with its own error;
//   (2)  THE TWIN LAW: a client-shaped state A, mutated to B, expressed
//        as ops, folds A into B exactly (the PWA's collabcore.js derives
//        the same ops — the rig pins the twin byte-for-byte);
//   (3)  THE REPLAY-SAFE LAWS: add-for-existing-id is a no-op;
//        set/remove-for-absent-id is a no-op (at-least-once redelivery
//        can never double-apply);
//   (4)  THE VIEW-PLANE LAW: the fold never touches offset/scale/
//        settings/savedAt (the personal plane stays the host's own);
//   (5)  doc.set carries currentFamily + worldSize (the structural
//        fields ride the doc);
//   (6)  icon order: adds append at the END (the addEntity z-order law);
//        the server seq is the one total order.

import (
	"encoding/json"
	"testing"
)

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return json.RawMessage(b)
}

func TestV1691_ValidationMatrix(t *testing.T) {
	// every legal kind admits
	legal := []Op{
		{OpID: "d:1", Kind: OpIconSet, ID: "i1", Props: mustJSON(t, map[string]any{"x": 1})},
		{OpID: "d:2", Kind: OpIconAdd, Icon: mustJSON(t, map[string]any{"id": "i2", "type": "chat"})},
		{OpID: "d:3", Kind: OpIconRemove, ID: "i1"},
		{OpID: "d:4", Kind: OpDotSet, ID: "g1", Props: mustJSON(t, map[string]any{"R": 420})},
		{OpID: "d:5", Kind: OpDotAdd, Dot: mustJSON(t, map[string]any{"id": "g2", "members": []any{}})},
		{OpID: "d:6", Kind: OpDotRemove, ID: "g1"},
		{OpID: "d:7", Kind: OpDocSet, Path: PathCurrentFamily, Value: mustJSON(t, "aurora")},
		{OpID: "d:8", Kind: OpDocSet, Path: PathWorldSize, Value: mustJSON(t, 32768)},
	}
	for i, op := range legal {
		if err := ValidateOp(op); err != nil {
			t.Fatalf("legal op %d (%s) rejected: %v", i, op.Kind, err)
		}
	}
	// every illegal shape rejects
	illegal := map[string]Op{
		"no opId":         {Kind: OpIconSet, ID: "i1", Props: mustJSON(t, map[string]any{"x": 1})},
		"unknown kind":    {OpID: "d:1", Kind: "icon.explode", ID: "i1"},
		"set no id":       {OpID: "d:1", Kind: OpIconSet, Props: mustJSON(t, map[string]any{"x": 1})},
		"set no props":    {OpID: "d:1", Kind: OpIconSet, ID: "i1"},
		"set bad props":   {OpID: "d:1", Kind: OpIconSet, ID: "i1", Props: json.RawMessage(`[1,2]`)},
		"set empty obj":   {OpID: "d:1", Kind: OpIconSet, ID: "i1", Props: json.RawMessage(`{}`)},
		"add no payload":  {OpID: "d:1", Kind: OpIconAdd},
		"add no id":       {OpID: "d:1", Kind: OpIconAdd, Icon: mustJSON(t, map[string]any{"type": "chat"})},
		"add id not str":  {OpID: "d:1", Kind: OpIconAdd, Icon: mustJSON(t, map[string]any{"id": 42})},
		"remove no id":    {OpID: "d:1", Kind: OpIconRemove},
		"docset bad path": {OpID: "d:1", Kind: OpDocSet, Path: "theme", Value: mustJSON(t, "dark")},
		"docset no value": {OpID: "d:1", Kind: OpDocSet, Path: PathWorldSize},
	}
	for name, op := range illegal {
		if err := ValidateOp(op); err == nil {
			t.Fatalf("illegal op (%s) admitted: %+v", name, op)
		}
	}
}

func TestV1691_TwinLawFoldRoundTrip(t *testing.T) {
	// state A: two icons, one dot, default family, 16k plate
	stateA := map[string]any{
		"offset":        map[string]any{"x": -10.5, "y": 22},
		"scale":         0.9,
		"currentFamily": "default",
		"icons": []any{
			map[string]any{"id": "chat_a", "type": "chat", "x": 10, "y": 20, "name": "Scooby", "sessionId": "s1"},
			map[string]any{"id": "web_b", "type": "web", "x": 30, "y": 40, "url": "https://x.test"},
		},
		"dots":     []any{map[string]any{"id": "dot_1", "members": []any{"web_b"}, "R": 300, "seed": 0.5}},
		"settings": map[string]any{"theme": "aurora"},
		"savedAt":  111.0,
	}
	// the client's mutation set (what a saveNow diff would derive):
	ops := []Op{
		{OpID: "d:1", Kind: OpIconSet, ID: "chat_a", Props: mustJSON(t, map[string]any{"x": 15, "y": 25, "name": "Renamed"})},
		{OpID: "d:2", Kind: OpIconAdd, Icon: mustJSON(t, map[string]any{"id": "chat_new", "type": "chat", "x": 50, "y": 60, "sessionId": "s2"})},
		{OpID: "d:3", Kind: OpIconRemove, ID: "web_b"},
		{OpID: "d:4", Kind: OpDotAdd, Dot: mustJSON(t, map[string]any{"id": "dot_2", "members": []any{}, "R": 420, "seed": 0.7})},
		{OpID: "d:5", Kind: OpDotSet, ID: "dot_1", Props: mustJSON(t, map[string]any{"R": 500})},
		{OpID: "d:6", Kind: OpDocSet, Path: PathCurrentFamily, Value: mustJSON(t, "aurora")},
		{OpID: "d:7", Kind: OpDocSet, Path: PathWorldSize, Value: mustJSON(t, 32768)},
	}
	for _, op := range ops {
		if err := ValidateOp(op); err != nil {
			t.Fatalf("op %s failed validation: %v", op.Kind, err)
		}
		if err := FoldOp(stateA, op); err != nil {
			t.Fatalf("fold %s: %v", op.Kind, err)
		}
	}
	// THE TWIN LAW: the folded doc == the client's own next state
	icons, _ := stateA["icons"].([]any)
	if len(icons) != 2 {
		t.Fatalf("icons: want 2, got %d", len(icons))
	}
	a := icons[0].(map[string]any)
	if a["id"] != "chat_a" || a["x"] != float64(15) || a["y"] != float64(25) || a["name"] != "Renamed" {
		t.Fatalf("chat_a not folded: %v", a)
	}
	if a["sessionId"] != "s1" {
		t.Fatalf("set must merge, not replace: %v", a)
	}
	n := icons[1].(map[string]any)
	if n["id"] != "chat_new" {
		t.Fatalf("the add must append at the end: %v", icons)
	}
	dots, _ := stateA["dots"].([]any)
	if len(dots) != 2 {
		t.Fatalf("dots: want 2, got %d", len(dots))
	}
	d1 := dots[0].(map[string]any)
	if d1["R"] != float64(500) {
		t.Fatalf("dot_1 R not folded: %v", d1)
	}
	if stateA["currentFamily"] != "aurora" {
		t.Fatalf("family not folded: %v", stateA["currentFamily"])
	}
	if stateA["worldSize"] != float64(32768) {
		t.Fatalf("worldSize not folded: %v", stateA["worldSize"])
	}
	// THE VIEW-PLANE LAW: untouched
	if stateA["scale"] != 0.9 {
		t.Fatalf("view plane clobbered: scale=%v", stateA["scale"])
	}
	if stateA["savedAt"] != 111.0 {
		t.Fatalf("view plane clobbered: savedAt=%v", stateA["savedAt"])
	}
	st, _ := stateA["settings"].(map[string]any)
	if st == nil || st["theme"] != "aurora" {
		t.Fatalf("view plane clobbered: settings=%v", stateA["settings"])
	}
}

func TestV1691_ReplaySafeLaws(t *testing.T) {
	num := func(v any) float64 {
		switch n := v.(type) {
		case int:
			return float64(n)
		case int64:
			return float64(n)
		case float64:
			return n
		}
		return -1
	}
	state := map[string]any{
		"icons": []any{map[string]any{"id": "i1", "x": 1}},
	}
	// add for an existing id → no-op (never double-add)
	add := Op{OpID: "d:1", Kind: OpIconAdd, Icon: mustJSON(t, map[string]any{"id": "i1", "x": 99})}
	if err := FoldOp(state, add); err != nil {
		t.Fatalf("replayed add: %v", err)
	}
	icons, _ := state["icons"].([]any)
	if len(icons) != 1 || num(icons[0].(map[string]any)["x"]) != 1 {
		t.Fatalf("replayed add double-applied: %v", state["icons"])
	}
	// set for an absent id → no-op (a set can never resurrect)
	setGone := Op{OpID: "d:2", Kind: OpIconSet, ID: "ghost", Props: mustJSON(t, map[string]any{"x": 5})}
	if err := FoldOp(state, setGone); err != nil {
		t.Fatalf("absent set: %v", err)
	}
	// remove for an absent id → no-op
	rmGone := Op{OpID: "d:3", Kind: OpIconRemove, ID: "ghost"}
	if err := FoldOp(state, rmGone); err != nil {
		t.Fatalf("absent remove: %v", err)
	}
	// remove the real one → gone
	rm := Op{OpID: "d:4", Kind: OpIconRemove, ID: "i1"}
	if err := FoldOp(state, rm); err != nil {
		t.Fatalf("remove: %v", err)
	}
	icons, _ = state["icons"].([]any)
	if len(icons) != 0 {
		t.Fatalf("remove not applied: %v", state["icons"])
	}
	// the same ops replayed AGAIN (at-least-once redelivery) → no change
	for _, op := range []Op{add, setGone, rmGone, rm} {
		if err := FoldOp(state, op); err != nil {
			t.Fatalf("replay: %v", err)
		}
	}
	icons, _ = state["icons"].([]any)
	if len(icons) != 0 {
		t.Fatalf("replay changed the doc: %v", state["icons"])
	}
}

func TestV1691_StateObjectShell(t *testing.T) {
	// empty state → a fresh shell (a canvas born shared)
	obj, err := StateObject("")
	if err != nil {
		t.Fatalf("empty state: %v", err)
	}
	if len(obj) != 0 {
		t.Fatalf("shell not fresh: %v", obj)
	}
	// a non-object state → the honest error
	if _, err := StateObject(`[1,2,3]`); err == nil {
		t.Fatalf("non-object state admitted")
	}
	// "null" → the fresh shell (a NULL row state)
	obj, err = StateObject("null")
	if err != nil || len(obj) != 0 {
		t.Fatalf("null state: %v %v", obj, err)
	}
}

func TestV1691_StampedFrameCodec(t *testing.T) {
	num := func(v any) float64 {
		switch n := v.(type) {
		case int:
			return float64(n)
		case int64:
			return float64(n)
		case float64:
			return n
		}
		return -1
	}
	frame, err := StampedFrame(`{"opId":"d:9","kind":"icon.set","id":"i1","props":{"x":3}}`, 42, "pixel9", 1234.5)
	if err != nil {
		t.Fatalf("stamped: %v", err)
	}
	if num(frame["seq"]) != 42 || frame["device"] != "pixel9" || num(frame["at"]) != 1234.5 {
		t.Fatalf("stamps wrong: %v", frame)
	}
	if frame["opId"] != "d:9" || frame["kind"] != "icon.set" {
		t.Fatalf("client fields lost: %v", frame)
	}
	if _, err := StampedFrame(`not json`, 1, "d", 0); err == nil {
		t.Fatalf("corrupt frame admitted")
	}
}
