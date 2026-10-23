// collabstore.go — v1.69.3 THE HANDSHAKE (PLAN-V169 §v1.69.3): the
// device/member/invite accessors. The token law: the server stores only
// the sha256 of the opaque 256-bit token (revocation is one UPDATE;
// nothing is forgeable offline — the researched production pattern).
package store

import (
	"database/sql"
	"errors"
	"time"
)

// ErrInviteNotFound / ErrDeviceNotFound — the honest misses.
var (
	ErrInviteNotFound = errors.New("collab: invite not found")
	ErrDeviceNotFound = errors.New("collab: device not found")
)

// CollabDevice is one enrolled device.
type CollabDevice struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	TokenHash string   `json:"-"`
	CreatedAt float64  `json:"created_at"`
	LastSeen  float64  `json:"last_seen"`
	RevokedAt *float64 `json:"revoked_at,omitempty"`
}

// CollabMember is one device's grant on one canvas (role: editor — the
// owner is the engine's operator, not a device row).
type CollabMember struct {
	CanvasID string  `json:"canvas_id"`
	DeviceID string  `json:"device_id"`
	Role     string  `json:"role"`
	JoinedAt float64 `json:"joined_at"`
}

// CollabInvite is the pairing state (one live invite per canvas).
type CollabInvite struct {
	CanvasID    string   `json:"canvas_id"`
	Code        string   `json:"code"`
	DeviceCode  string   `json:"-"`
	ExpiresAt   float64  `json:"expires_at"`
	ClaimedName string   `json:"claimed_name,omitempty"`
	ClaimedAt   *float64 `json:"claimed_at,omitempty"`
	ApprovedAt  *float64 `json:"approved_at,omitempty"`
	DeniedAt    *float64 `json:"denied_at,omitempty"`
}

// CreateCollabDevice registers a device (id + name + the sha256 hex of
// its opaque token).
func (db *DB) CreateCollabDevice(id, name, tokenHash string) error {
	now := float64(time.Now().UnixMilli()) / 1000.0
	_, err := db.Exec(`INSERT OR REPLACE INTO collab_devices (id, name, token_hash, created_at, last_seen) VALUES (?,?,?,?,?)`,
		id, name, tokenHash, now, now)
	return err
}

// CollabDeviceByToken resolves a raw token to its device (sha256
// computed by the caller). A REVOKED device answers ErrDeviceNotFound —
// a revoked token is dead, not merely invisible.
func (db *DB) CollabDeviceByToken(tokenHash string) (*CollabDevice, error) {
	d := &CollabDevice{}
	var revoked sql.NullFloat64
	err := db.QueryRow(`SELECT id, name, token_hash, created_at, COALESCE(last_seen,0), revoked_at
		FROM collab_devices WHERE token_hash=?`, tokenHash).
		Scan(&d.ID, &d.Name, &d.TokenHash, &d.CreatedAt, &d.LastSeen, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrDeviceNotFound
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid {
		return nil, ErrDeviceNotFound // revoked = dead (the honest miss)
	}
	return d, nil
}

// GetCollabDevice reads one device row (the share sheet's member list).
func (db *DB) GetCollabDevice(id string) (*CollabDevice, error) {
	d := &CollabDevice{}
	var revoked sql.NullFloat64
	err := db.QueryRow(`SELECT id, name, token_hash, created_at, COALESCE(last_seen,0), revoked_at
		FROM collab_devices WHERE id=?`, id).
		Scan(&d.ID, &d.Name, &d.TokenHash, &d.CreatedAt, &d.LastSeen, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrDeviceNotFound
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid {
		rv := revoked.Float64
		d.RevokedAt = &rv
	}
	return d, nil
}

// TouchCollabDevice stamps last_seen (the presence-adjacent liveness).
func (db *DB) TouchCollabDevice(id string) {
	_, _ = db.Exec(`UPDATE collab_devices SET last_seen=? WHERE id=?`, float64(time.Now().UnixMilli())/1000.0, id)
}

// RevokeCollabDevice kills a token (one UPDATE — the researched law).
func (db *DB) RevokeCollabDevice(id string) error {
	_, err := db.Exec(`UPDATE collab_devices SET revoked_at=? WHERE id=?`, float64(time.Now().UnixMilli())/1000.0, id)
	return err
}

// AddCollabMember grants a device on a canvas (idempotent).
func (db *DB) AddCollabMember(canvasID, deviceID, role string) error {
	_, err := db.Exec(`INSERT OR IGNORE INTO collab_members (canvas_id, device_id, role, joined_at) VALUES (?,?,?,?)`,
		canvasID, deviceID, role, float64(time.Now().UnixMilli())/1000.0)
	return err
}

// RemoveCollabMember revokes one device's grant on one canvas.
func (db *DB) RemoveCollabMember(canvasID, deviceID string) error {
	_, err := db.Exec(`DELETE FROM collab_members WHERE canvas_id=? AND device_id=?`, canvasID, deviceID)
	return err
}

// IsCollabMember is the ACL check.
func (db *DB) IsCollabMember(canvasID, deviceID string) (bool, error) {
	var one int
	err := db.QueryRow(`SELECT 1 FROM collab_members WHERE canvas_id=? AND device_id=?`, canvasID, deviceID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ListCollabMembers is the share sheet's roster (device rows joined).
func (db *DB) ListCollabMembers(canvasID string) ([]map[string]any, error) {
	rows, err := db.Query(`
SELECT m.device_id, COALESCE(d.name, m.device_id), m.role, m.joined_at, COALESCE(d.last_seen, 0)
FROM collab_members m LEFT JOIN collab_devices d ON d.id = m.device_id
WHERE m.canvas_id=? ORDER BY m.joined_at ASC`, canvasID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		var id, name, role string
		var joined, seen float64
		if err := rows.Scan(&id, &name, &role, &joined, &seen); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "name": name, "role": role, "joined_at": joined, "last_seen": seen})
	}
	return out, rows.Err()
}

// CollabCanvasesForDevice is the device's shared-with-me registry (the
// guest's canvas list — the per-canvas sandbox made visible).
func (db *DB) CollabCanvasesForDevice(deviceID string) ([]map[string]any, error) {
	rows, err := db.Query(`
SELECT c.id, c.name, m.role, c.updated_at
FROM collab_members m JOIN canvases c ON c.id = m.canvas_id
WHERE m.device_id=? ORDER BY c.updated_at DESC`, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		var id, name, role string
		var updated float64
		if err := rows.Scan(&id, &name, &role, &updated); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"id": id, "name": name, "role": role, "updated_at": updated})
	}
	return out, rows.Err()
}

// UpsertCollabInvite writes THE canvas's live invite (one at a time —
// a fresh mint replaces the old: the owner shows one code, ever).
func (db *DB) UpsertCollabInvite(canvasID, code, deviceCode string, expiresAt float64) error {
	_, err := db.Exec(`INSERT OR REPLACE INTO collab_invites (canvas_id, code, device_code, expires_at) VALUES (?,?,?,?)`,
		canvasID, code, deviceCode, expiresAt)
	return err
}

// GetCollabInvite reads the canvas's live invite.
func (db *DB) GetCollabInvite(canvasID string) (*CollabInvite, error) {
	inv := &CollabInvite{}
	var claimed sql.NullString
	var claimedAt, approvedAt, deniedAt sql.NullFloat64
	err := db.QueryRow(`SELECT canvas_id, code, device_code, expires_at, claimed_name, claimed_at, approved_at, denied_at
		FROM collab_invites WHERE canvas_id=?`, canvasID).
		Scan(&inv.CanvasID, &inv.Code, &inv.DeviceCode, &inv.ExpiresAt, &claimed, &claimedAt, &approvedAt, &deniedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrInviteNotFound
	}
	if err != nil {
		return nil, err
	}
	if claimed.Valid {
		inv.ClaimedName = claimed.String
	}
	if claimedAt.Valid {
		v := claimedAt.Float64
		inv.ClaimedAt = &v
	}
	if approvedAt.Valid {
		v := approvedAt.Float64
		inv.ApprovedAt = &v
	}
	if deniedAt.Valid {
		v := deniedAt.Float64
		inv.DeniedAt = &v
	}
	return inv, nil
}

// GetCollabInviteByDeviceCode resolves the joiner's poll cursor.
func (db *DB) GetCollabInviteByDeviceCode(deviceCode string) (*CollabInvite, error) {
	inv := &CollabInvite{}
	var claimed sql.NullString
	var claimedAt, approvedAt, deniedAt sql.NullFloat64
	err := db.QueryRow(`SELECT canvas_id, code, device_code, expires_at, claimed_name, claimed_at, approved_at, denied_at
		FROM collab_invites WHERE device_code=?`, deviceCode).
		Scan(&inv.CanvasID, &inv.Code, &inv.DeviceCode, &inv.ExpiresAt, &claimed, &claimedAt, &approvedAt, &deniedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrInviteNotFound
	}
	if err != nil {
		return nil, err
	}
	if claimed.Valid {
		inv.ClaimedName = claimed.String
	}
	if claimedAt.Valid {
		v := claimedAt.Float64
		inv.ClaimedAt = &v
	}
	if approvedAt.Valid {
		v := approvedAt.Float64
		inv.ApprovedAt = &v
	}
	if deniedAt.Valid {
		v := deniedAt.Float64
		inv.DeniedAt = &v
	}
	return inv, nil
}

// ClaimCollabInvite binds a device name to the invite (single-use: the
// second claimant is refused unless unapproved+expired heuristics say
// otherwise — one name per code, ever).
func (db *DB) ClaimCollabInvite(canvasID, deviceName string) error {
	now := float64(time.Now().UnixMilli()) / 1000.0
	res, err := db.Exec(`UPDATE collab_invites SET claimed_name=?, claimed_at=?
		WHERE canvas_id=? AND claimed_name IS NULL`, deviceName, now, canvasID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrInviteNotFound
	}
	return nil
}

// ApproveCollabInvite stamps the owner's Allow (idempotent).
func (db *DB) ApproveCollabInvite(canvasID string) error {
	now := float64(time.Now().UnixMilli()) / 1000.0
	_, err := db.Exec(`UPDATE collab_invites SET approved_at=? WHERE canvas_id=?`, now, canvasID)
	return err
}

// DenyCollabInvite stamps the owner's Deny (the invite dies for the
// claimant; the owner can mint fresh).
func (db *DB) DenyCollabInvite(canvasID string) error {
	now := float64(time.Now().UnixMilli()) / 1000.0
	_, err := db.Exec(`UPDATE collab_invites SET denied_at=? WHERE canvas_id=?`, now, canvasID)
	return err
}
