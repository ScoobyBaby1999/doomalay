// codec.go — v1.69.1 THE SHARED CANVAS: the journal→wire codec. A
// journal row's op text is the VALIDATED client frame; the wire frame
// the room/APIs deliver is that same object stamped with the server's
// truth (seq / device / at). One builder, one shape, everywhere.
package collab

import (
	"encoding/json"
	"fmt"
)

// StampedFrame parses a journal row's op JSON and returns the wire
// frame: the client op's own fields + the server stamps. The stamps
// overwrite any same-named fields in the stored text (defense in depth
// — the admission path already strips client-sent stamps).
func StampedFrame(opJSON string, seq int, device string, at float64) (map[string]any, error) {
	var frame map[string]any
	if err := json.Unmarshal([]byte(opJSON), &frame); err != nil {
		return nil, fmt.Errorf("collab: corrupt op frame: %v", err)
	}
	if frame == nil {
		return nil, fmt.Errorf("collab: op frame is not an object")
	}
	frame["seq"] = seq
	frame["device"] = device
	frame["at"] = at
	return frame, nil
}
