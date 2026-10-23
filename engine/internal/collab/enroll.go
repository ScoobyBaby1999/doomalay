// enroll.go — v1.69.3 THE HANDSHAKE (PLAN-V169 §v1.69.3): the RFC
// 8628-shaped pairing state machine + the token law.
//
// THE FLOW (the owner's physical Allow tap is the handshake — "ideally
// impossible for a random user to gain access… without a one time
// manual human authenticated handshake"):
//
//      OWNER (the host engine's own UI — behind the global gate):
//        MintInvite(canvas)  → a 6-digit code, ≤5min TTL, ONE live invite
//                              per canvas (a fresh mint replaces the old).
//      JOINER (any device that can reach the engine — NO global credential):
//        Pair(canvas, code, name) → {device_code}   — the single-use claim:
//                              a wrong code answers the honest miss (a
//                              1-in-10⁶ ONLINE guess, rate-limited); a
//                              claimed code binds ONE name; the joiner polls
//                              PairStatus(device_code) every ~5s.
//      OWNER: sees "Pixel 9 · 482913" → Allow (or Deny).
//      Allow → the server mints the DEVICE (a 256-bit opaque credential,
//              stored sha256-hashed) + the MEMBER row on THAT canvas
//              (per-canvas, never per-account) → the poll returns
//              {device_id, token}.
//      The token authenticates ONLY the collab surfaces and ONLY the member
//              canvases (the server's auth wrapper). Revocation: one UPDATE
//              + the live room evicts the device's sockets mid-stream.
//
// NO PAKE (researched: ADB's SPAKE2 / BT numeric comparison / Matrix SAS
// defend active MITM on unauthenticated channels or unattended
// verification; here TLS-via-tunnel + the owner's physical comparison +
// the online-one-guess code cover the actual threat).
package collab

import (
        "crypto/rand"
        "crypto/sha256"
        "encoding/hex"
        "fmt"
        "math/big"
        "strings"
        "time"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// The pairing laws (the researched constants: RFC 8628's short-lived
// user_code + ~5s poll cadence, ADB's pairing-code hygiene).
const (
        InviteTTL     = 5 * time.Minute
        DeviceCodeTTL = 10 * time.Minute
        CodeDigits    = 6
)

// PairStore is the enrollment's durable surface (the store.DB satisfies
// it exactly).
type PairStore interface {
        UpsertCollabInvite(canvasID, code, deviceCode string, expiresAt float64) error
        GetCollabInvite(canvasID string) (*store.CollabInvite, error)
        GetCollabInviteByDeviceCode(deviceCode string) (*store.CollabInvite, error)
        ClaimCollabInvite(canvasID, deviceName string) error
        ApproveCollabInvite(canvasID string) error
        DenyCollabInvite(canvasID string) error
        CreateCollabDevice(id, name, tokenHash string) error
        AddCollabMember(canvasID, deviceID, role string) error
}

// Enroller is the pairing state machine.
type Enroller struct {
        store PairStore
}

func NewEnroller(ps PairStore) *Enroller {
        return &Enroller{store: ps}
}

func randToken(nbytes int) string {
        b := make([]byte, nbytes)
        if _, err := rand.Read(b); err != nil {
                // never a deterministic credential — an entropy failure is loud.
                panic("collab: entropy unavailable: " + err.Error())
        }
        return hex.EncodeToString(b)
}

func randDigits(n int) string {
        max := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil)
        v, err := rand.Int(rand.Reader, max)
        if err != nil {
                panic("collab: entropy unavailable: " + err.Error())
        }
        s := v.String()
        for len(s) < n {
                s = "0" + s
        }
        return s
}

// HashToken is THE one hashing point (sha256 hex — the store keys on it;
// the raw token never touches the disk).
func HashToken(token string) string {
        h := sha256.Sum256([]byte(token))
        return hex.EncodeToString(h[:])
}

// The pairing errors (mapped to statuses by the server layer).
var (
        ErrPairNoInvite   = fmt.Errorf("collab: no live invite for this canvas")
        ErrPairExpired    = fmt.Errorf("collab: the invite code expired")
        ErrPairBadCode    = fmt.Errorf("collab: wrong code")
        ErrPairTaken      = fmt.Errorf("collab: this invite was already claimed by another device")
        ErrPairDenied     = fmt.Errorf("collab: the owner denied this request")
        ErrPairNotClaimed = fmt.Errorf("collab: nothing to approve")
)

// MintInvite creates/replaces THE canvas's live invite. Returns the
// 6-digit code the owner shows (the joiner never sees the 256-bit
// device_code — the code IS the shared proof; the device_code is the
// joiner's private poll cursor).
func (e *Enroller) MintInvite(canvasID string) (*store.CollabInvite, error) {
        code := randDigits(CodeDigits)
        deviceCode := randToken(32)
        expires := float64(time.Now().Add(InviteTTL).UnixMilli()) / 1000.0
        if err := e.store.UpsertCollabInvite(canvasID, code, deviceCode, expires); err != nil {
                return nil, err
        }
        return e.store.GetCollabInvite(canvasID)
}

// Pair is the joiner's single-use claim: canvas + the 6-digit code + the
// device name → the poll cursor (device_code). One claim per invite —
// the owner approves ONE device per code.
func (e *Enroller) Pair(canvasID, code, deviceName string) (string, error) {
        code = strings.TrimSpace(code)
        if len(code) != CodeDigits || strings.Trim(code, "0123456789") != "" {
                return "", ErrPairBadCode
        }
        if strings.TrimSpace(deviceName) == "" {
                deviceName = "Device"
        }
        inv, err := e.store.GetCollabInvite(canvasID)
        if err != nil {
                return "", ErrPairNoInvite
        }
        if float64(time.Now().UnixMilli())/1000.0 > inv.ExpiresAt {
                return "", ErrPairExpired
        }
        if inv.Code != code {
                return "", ErrPairBadCode
        }
        if inv.DeniedAt != nil {
                return "", ErrPairDenied
        }
        if inv.ClaimedName != "" {
                return "", ErrPairTaken
        }
        if err := e.store.ClaimCollabInvite(canvasID, deviceName); err != nil {
                return "", ErrPairTaken
        }
        return inv.DeviceCode, nil
}

// PairResult is the poll's answer.
type PairResult struct {
        Status string // pending | approved | denied | expired | unknown
        Token  string // set on approved (minted once; polls converge)
        Device string // the device id
        Err    error
}

// PairStatus is the joiner's poll: pending until the owner taps. On
// approval the credential is minted DETERMINISTICALLY from the pairing
// session's own 256-bit device_code — repeated polls converge on ONE
// token (the idempotency law) while a fresh invite (a fresh device_code)
// can never resurrect an old credential.
func (e *Enroller) PairStatus(deviceCode string) PairResult {
        inv, err := e.store.GetCollabInviteByDeviceCode(deviceCode)
        if err != nil || inv == nil {
                return PairResult{Status: "unknown", Err: ErrPairNoInvite}
        }
        if float64(time.Now().UnixMilli())/1000.0 > inv.ExpiresAt+DeviceCodeTTL.Seconds() {
                return PairResult{Status: "expired"}
        }
        if inv.DeniedAt != nil {
                return PairResult{Status: "denied"}
        }
        if inv.ApprovedAt == nil {
                return PairResult{Status: "pending"}
        }
        deviceID, token, err := e.mintApproved(inv)
        if err != nil {
                return PairResult{Status: "error", Err: err}
        }
        return PairResult{Status: "approved", Token: token, Device: deviceID}
}

// mintApproved derives the device credential from the session's device
// code (two distinct derivations: the public id + the secret token).
func (e *Enroller) mintApproved(inv *store.CollabInvite) (string, string, error) {
        idh := sha256.Sum256([]byte("doomalay-device:" + inv.DeviceCode))
        deviceID := "dev_" + hex.EncodeToString(idh[:8])
        tkh := sha256.Sum256([]byte("doomalay-token:" + inv.DeviceCode))
        token := hex.EncodeToString(tkh[:])
        name := inv.ClaimedName
        if name == "" {
                name = "Device"
        }
        if err := e.store.CreateCollabDevice(deviceID, name, HashToken(token)); err != nil {
                return "", "", err
        }
        if err := e.store.AddCollabMember(inv.CanvasID, deviceID, "editor"); err != nil {
                return "", "", err
        }
        return deviceID, token, nil
}

// Approve is the owner's Allow tap (the human handshake — the one gate
// no automation can pass).
func (e *Enroller) Approve(canvasID string) error {
        inv, err := e.store.GetCollabInvite(canvasID)
        if err != nil {
                return ErrPairNoInvite
        }
        if inv.ClaimedName == "" {
                return ErrPairNotClaimed
        }
        if inv.DeniedAt != nil {
                return ErrPairDenied
        }
        return e.store.ApproveCollabInvite(canvasID)
}

// Deny is the owner's Deny tap (the invite dies for the claimant; a
// fresh mint serves the next joiner).
func (e *Enroller) Deny(canvasID string) error {
        return e.store.DenyCollabInvite(canvasID)
}
