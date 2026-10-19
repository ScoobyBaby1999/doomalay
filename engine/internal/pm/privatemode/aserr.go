package privatemode

import "errors"

// toResponseError is the Go-1.25-compatible shim for the upstream
// errors.AsType[*ResponseError] (a Go 1.26 stdlib generic); see
// PROVENANCE.md — the only other semantic delta in this package.
func toResponseError(err error) (*ResponseError, bool) {
	var re *ResponseError
	if errors.As(err, &re) {
		return re, true
	}
	return nil, false
}
