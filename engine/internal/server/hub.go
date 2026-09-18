package server

// hub.go — v0.31 THE HUB (modular library system) routes.
//
// /api/hub/... serves the library panels: per-type item listings (merged
// local + federated), item details + PNGs, downloads, endorsements,
// publishing, the local persona hearts (the persona picker), and the HF
// token connect flow (the token NEVER reaches the PWA — engine-side only).
//
// {type} is validated against the hub registry → 404 unknown library.
// Body caps: publish = 12MB raw (a 6MB PNG base64-inflates to ~8MB; payload
// text is separately capped at 64KB, the PNG at 6MB after decode).

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/hub"
)

const (
	hubPublishMaxBytes = 12 << 20 // raw JSON body (pngBase64 + payload + overhead)
	hubPayloadMaxBytes = 64 << 10 // payload text (a persona .md / template .json)
	hubPNGMaxBytes     = 6 << 20  // card background PNG
)

// hubType validates {type} against the registry and writes the 404 on
// failure. Returns "" + false when the request is already answered.
func (s *Server) hubType(w http.ResponseWriter, r *http.Request) (string, bool) {
	typ := r.PathValue("type")
	if _, err := hub.Get(typ); err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return "", false
	}
	return typ, true
}

// hubSpecErr maps a registry error to 404, everything else to 500.
func hubWriteItemErr(w http.ResponseWriter, err error) {
	switch {
	case err == hub.ErrNotConnected:
		writeError(w, http.StatusUnauthorized, err.Error())
	case err == hub.ErrNotDownloaded:
		writeError(w, http.StatusBadRequest, err.Error())
	case err == hub.ErrNotFoundLocal || hub.IsNotFound(err):
		writeError(w, http.StatusNotFound, "item not found")
	case hub.IsUnauthorized(err):
		writeError(w, http.StatusUnauthorized, "Hugging Face rejected the token (reconnect)")
	default:
		writeError(w, http.StatusBadGateway, err.Error())
	}
}

// handleHubLibraries is GET /api/hub/libraries — the registry + local
// counts (the panel builds its tabs from this).
func (s *Server) handleHubLibraries(w http.ResponseWriter, r *http.Request) {
	type library struct {
		hub.LibrarySpec
		LocalCount int `json:"localCount"`
	}
	out := make([]library, 0, 8)
	for _, spec := range hub.All() {
		out = append(out, library{LibrarySpec: spec, LocalCount: hub.CountLocal(s.db, spec.Type)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"libraries": out})
}

// handleHubItems is GET /api/hub/{type}/items?q=&sort=&tag= (refresh=1
// bypasses the 10-min remote cache). Default sort: relevant when q is
// non-empty, else recent.
func (s *Server) handleHubItems(w http.ResponseWriter, r *http.Request) {
	typ, ok := s.hubType(w, r)
	if !ok {
		return
	}
	refresh := r.URL.Query().Get("refresh") == "1"
	items, err := s.hub.Items(typ,
		r.URL.Query().Get("q"),
		r.URL.Query().Get("sort"),
		r.URL.Query().Get("tag"),
		refresh)
	if err != nil {
		hubWriteItemErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"type": typ, "items": items, "total": len(items)})
}

// handleHubItem is GET /api/hub/{type}/item/{repo}/{id} — {item, payload}
// (the remote proxy with the local fast-path).
func (s *Server) handleHubItem(w http.ResponseWriter, r *http.Request) {
	typ, ok := s.hubType(w, r)
	if !ok {
		return
	}
	item, payload, err := s.hub.ItemDetail(typ, r.PathValue("repo"), r.PathValue("id"))
	if err != nil {
		hubWriteItemErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": item, "payload": payload})
}

// handleHubPNG is GET /api/hub/{type}/png/{repo}/{id} — the card image
// bytes with a long cache header (item content is id-addressed).
func (s *Server) handleHubPNG(w http.ResponseWriter, r *http.Request) {
	typ, ok := s.hubType(w, r)
	if !ok {
		return
	}
	png, err := s.hub.PNG(typ, r.PathValue("repo"), r.PathValue("id"))
	if err != nil || len(png) == 0 {
		writeError(w, http.StatusNotFound, "no image for this item")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=604800")
	w.Header().Set("Content-Length", strconv.Itoa(len(png)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(png)
}

// handleHubDownload is POST /api/hub/{type}/download {repo,id} — saves the
// item locally (downloaded state) + records the metrics event.
func (s *Server) handleHubDownload(w http.ResponseWriter, r *http.Request) {
	typ, ok := s.hubType(w, r)
	if !ok {
		return
	}
	var req struct {
		Repo string `json:"repo"`
		ID   string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.Repo == "" || req.ID == "" {
		writeError(w, http.StatusBadRequest, "repo and id are required")
		return
	}
	item, payload, err := s.hub.Download(typ, req.Repo, req.ID)
	if err != nil {
		hubWriteItemErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": item, "payload": payload})
}

// handleHubEndorse is POST /api/hub/{type}/endorse|unendorse {repo,id} —
// hearting requires the item be downloaded (the enforceable endorsement
// rule); unendorse mirrors.
func (s *Server) handleHubEndorse(endorse bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		typ, ok := s.hubType(w, r)
		if !ok {
			return
		}
		var req struct {
			Repo string `json:"repo"`
			ID   string `json:"id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		if req.Repo == "" || req.ID == "" {
			writeError(w, http.StatusBadRequest, "repo and id are required")
			return
		}
		item, err := s.hub.Endorse(typ, req.Repo, req.ID, endorse)
		if err != nil {
			hubWriteItemErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "item": item})
	}
}

// handleHubPublish is POST /api/hub/{type}/publish
// {name,description,tags,design:{kind,colors},payload,pngBase64} — writes
// to the connected user's per-type HF dataset repo.
func (s *Server) handleHubPublish(w http.ResponseWriter, r *http.Request) {
	typ, ok := s.hubType(w, r)
	if !ok {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, hubPublishMaxBytes))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "publish body too large (12MB cap)")
		return
	}
	var req hub.PublishRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if len(req.Payload) > hubPayloadMaxBytes {
		writeError(w, http.StatusBadRequest, "payload too large (64KB cap)")
		return
	}
	if b, err := base64.StdEncoding.DecodeString(req.PNGBase64); err == nil && len(b) > hubPNGMaxBytes {
		writeError(w, http.StatusBadRequest, "png too large (6MB cap)")
		return
	}
	item, err := s.hub.Publish(typ, req)
	if err != nil {
		hubWriteItemErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": item, "repo": item.Repo})
}

// handleHubPersonaHeart is POST /api/hub/persona/heart {id,name} — the
// persona picker's local-only heart (+ hub rows when the id matches).
func (s *Server) handleHubPersonaHeart(heart bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		if req.ID == "" {
			writeError(w, http.StatusBadRequest, "id is required")
			return
		}
		var err error
		if heart {
			err = s.hub.HeartPersonaLocal(req.ID, req.Name)
		} else {
			err = s.hub.UnheartPersonaLocal(req.ID, req.Name)
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "hearted": heart, "id": req.ID})
	}
}

// handleHubPersonasHearted is GET /api/hub/personas/hearted — the picker's
// hearted-first sort + badges.
func (s *Server) handleHubPersonasHearted(w http.ResponseWriter, r *http.Request) {
	rows, err := s.hub.HeartedPersonas()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	type hearted struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	out := make([]hearted, 0, len(rows))
	for _, row := range rows {
		out = append(out, hearted{ID: row.Item.ID, Name: row.Item.Name})
	}
	writeJSON(w, http.StatusOK, map[string]any{"personas": out})
}

// handleHubAuthStatus is GET /api/hub/auth/status — {connected,username}
// (username comes from the vault extra stamped at connect time; the token
// itself never leaves the engine).
func (s *Server) handleHubAuthStatus(w http.ResponseWriter, r *http.Request) {
	connected := s.hub.Token() != ""
	writeJSON(w, http.StatusOK, map[string]any{
		"connected": connected,
		"username":  s.hub.Username(),
	})
}

// handleHubAuthConnect is POST /api/hub/auth/connect {token} — verifies
// via whoami (401 on a bad token) then stores it in the vault.
func (s *Server) handleHubAuthConnect(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	name, err := s.hub.Connect(req.Token)
	if err != nil {
		if hub.IsUnauthorized(err) {
			writeError(w, http.StatusUnauthorized, "Hugging Face rejected the token")
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "username": name})
}

// handleHubAuthDisconnect is POST /api/hub/auth/disconnect.
func (s *Server) handleHubAuthDisconnect(w http.ResponseWriter, r *http.Request) {
	if err := s.hub.Disconnect(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
