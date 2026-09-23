package server

// tweaks.go — v0.30→v0.44 PER-CHAT UI TWEAKS (the ✦ tweaks pill).
//
// USER SPEC: "Let's add a tweaks pill next to the usage and export chat
// pills in the chat metadata header. The tweaks pill should open a panel
// that acts as a per chat settings panel… The per chat settings should
// override the global settings. Add another section that allows the user
// to change the background of the panel to an image of their choosing
// from their library, or a background color of their choice."
//
// v0.44: the background is a full gradient SPEC (the shared uikit
// contract) — {type:"gradient", colors, dir, angle, texRev} — plus an
// optional TEXTURE, uploaded through these same routes and blended in
// client-side (background-blend-mode: color). Legacy blobs
// ({type:"color",color} and {type:"gradient",colors}) keep loading; the
// client folds them via GradientUI.norm.
//
// Storage (all in the app_settings kv table, next to the global
// placeholders):
//
//   chat.tweaks.<sid>  one JSON blob — {chatScheme, fmtOverrides,
//                      chatTextSize, uiTextSize, smallTextSize,
//                      bg:{type,colors,dir,angle,texRev,rev}} — only the
//                      OVERRIDDEN keys are present; absent = inherit the
//                      global settings.
//   chat.bg.<sid>      {"rev":N,"mime":"image/jpeg","b64":"…"} — the
//                      cropped background image the client uploads.
//                      Its own row because it's binary-sized, while the
//                      tweaks blob stays tiny (fetched on every chat
//                      open to re-scope the chat's CSS variables).
//   chat.tex.<sid>     {"rev":N,"mime":"image/jpeg","b64":"…"} — v0.44:
//                      the gradient's texture (≤512px, client-side
//                      downscale); the blob's bg slot carries only texRev.
//
// The background + texture are served at GET /api/sessions/{id}/background
// and /api/sessions/{id}/texture — the client appends ?v=<rev> (the PUT
// response's rev) so it can cache the URL forever yet still bust on
// re-upload.

import (
        "encoding/base64"
        "encoding/json"
        "io"
        "net/http"
        "strconv"
        "strings"
)

const (
        tweaksMaxBytes = 64 << 10 // the tweaks JSON — it's sliders + hex colors, tiny by design
        bgMaxBytes     = 4 << 20  // the background image (the client downscales first; this is the hard stop)
        iconMaxBytes   = 2 << 20  // v0.52: the chat icon (square-cropped, client-downscaled — small by construction)
)

func chatTweaksKey(sid string) string { return "chat.tweaks." + sid }
func chatBgKey(sid string) string     { return "chat.bg." + sid }
func chatIconKey(sid string) string   { return "chat.icon." + sid }

// handleSessionTweaksGet is GET /api/sessions/{id}/tweaks — the chat's
// tweak overrides (empty object when the chat never customized anything:
// it inherits the global settings).
func (s *Server) handleSessionTweaksGet(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        if sess, err := s.db.GetSession(id); err != nil {
                writeError(w, 500, "get: "+err.Error())
                return
        } else if sess == nil {
                writeError(w, 404, "not found")
                return
        }
        raw, err := s.db.GetSetting(chatTweaksKey(id))
        if err != nil {
                writeError(w, 500, "tweaks: "+err.Error())
                return
        }
        tweaks := json.RawMessage(strings.TrimSpace(raw))
        if len(tweaks) == 0 {
                tweaks = json.RawMessage("{}")
        }
        writeJSON(w, 200, map[string]any{"tweaks": tweaks})
}

// handleSessionTweaksPut is PUT /api/sessions/{id}/tweaks — replace the
// chat's tweak blob (the client always sends the whole object; partial
// saves are its own merge, this is a dumb byte store).
func (s *Server) handleSessionTweaksPut(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        if sess, err := s.db.GetSession(id); err != nil {
                writeError(w, 500, "get: "+err.Error())
                return
        } else if sess == nil {
                writeError(w, 404, "not found")
                return
        }
        body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, tweaksMaxBytes))
        if err != nil {
                writeError(w, 413, "tweaks too large (64KB cap)")
                return
        }
        var probe map[string]any
        if err := json.Unmarshal(body, &probe); err != nil {
                writeError(w, 400, "invalid JSON: "+err.Error())
                return
        }
        if err := s.db.SetSetting(chatTweaksKey(id), string(body)); err != nil {
                writeError(w, 500, "save: "+err.Error())
                return
        }
        writeJSON(w, 200, map[string]any{"ok": true})
}

// bgRecord is the stored shape of a chat's background image.
type bgRecord struct {
        Rev  int    `json:"rev"`
        Mime string `json:"mime"`
        B64  string `json:"b64"`
}

// sniffImageMime returns the content type for the magic-byte signatures
// we accept (jpeg / png / gif / webp) — "" when the bytes aren't an image.
func sniffImageMime(b []byte) string {
        if len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF {
                return "image/jpeg"
        }
        if len(b) >= 4 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47 {
                return "image/png"
        }
        if len(b) >= 4 && (string(b[0:3]) == "GIF") {
                return "image/gif"
        }
        if len(b) >= 12 && string(b[0:4]) == "RIFF" && string(b[8:12]) == "WEBP" {
                return "image/webp"
        }
        return ""
}

// handleSessionBackgroundPut is PUT /api/sessions/{id}/background — raw
// image bytes (the client downscales + re-encodes before sending, so the
// payload is typically a few hundred KB). Responds with the new rev so
// the client can cache-bust its URL (?v=rev).
func (s *Server) handleSessionBackgroundPut(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        if sess, err := s.db.GetSession(id); err != nil {
                writeError(w, 500, "get: "+err.Error())
                return
        } else if sess == nil {
                writeError(w, 404, "not found")
                return
        }
        body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, bgMaxBytes))
        if err != nil {
                writeError(w, 413, "image too large (4MB cap — the app downscales before upload)")
                return
        }
        if len(body) == 0 {
                writeError(w, 400, "empty body")
                return
        }
        mime := sniffImageMime(body)
        if mime == "" {
                writeError(w, 415, "not a recognized image (jpeg, png, gif, webp)")
                return
        }
        // read-modify-write the rev (the row also survives as the version counter)
        rec := bgRecord{Rev: 1, Mime: mime}
        if raw, err := s.db.GetSetting(chatBgKey(id)); err == nil && strings.TrimSpace(raw) != "" {
                var prev bgRecord
                if json.Unmarshal([]byte(raw), &prev) == nil && prev.Rev > 0 {
                        rec.Rev = prev.Rev + 1
                }
        }
        rec.B64 = base64.StdEncoding.EncodeToString(body)
        raw, err := json.Marshal(rec)
        if err != nil {
                writeError(w, 500, "encode: "+err.Error())
                return
        }
        if err := s.db.SetSetting(chatBgKey(id), string(raw)); err != nil {
                writeError(w, 500, "save: "+err.Error())
                return
        }
        writeJSON(w, 200, map[string]any{"ok": true, "rev": rec.Rev, "mime": mime})
}

// handleSessionBackgroundGet is GET /api/sessions/{id}/background — the
// stored image bytes (404 when the chat never set one). Immutable per
// ?v=rev, so it carries a long cache header.
func (s *Server) handleSessionBackgroundGet(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        if sess, err := s.db.GetSession(id); err != nil {
                writeError(w, 500, "get: "+err.Error())
                return
        } else if sess == nil {
                writeError(w, 404, "not found")
                return
        }
        raw, err := s.db.GetSetting(chatBgKey(id))
        if err != nil {
                writeError(w, 500, "background: "+err.Error())
                return
        }
        if strings.TrimSpace(raw) == "" {
                writeError(w, 404, "no background set")
                return
        }
        var rec bgRecord
        if err := json.Unmarshal([]byte(raw), &rec); err != nil || rec.B64 == "" {
                writeError(w, 404, "no background set")
                return
        }
        img, err := base64.StdEncoding.DecodeString(rec.B64)
        if err != nil || sniffImageMime(img) == "" {
                writeError(w, 500, "stored background is corrupt")
                return
        }
        w.Header().Set("Content-Type", rec.Mime)
        w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
        w.Header().Set("Content-Length", strconv.Itoa(len(img)))
        w.WriteHeader(http.StatusOK)
        _, _ = w.Write(img)
}

// handleSessionBackgroundDelete is DELETE /api/sessions/{id}/background —
// drop the image (the tweaks blob's bg slot is the client's to clear).
func (s *Server) handleSessionBackgroundDelete(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        if sess, err := s.db.GetSession(id); err != nil {
                writeError(w, 500, "get: "+err.Error())
                return
        } else if sess == nil {
                writeError(w, 404, "not found")
                return
        }
        if err := s.db.DeleteSetting(chatBgKey(id)); err != nil {
                writeError(w, 500, "delete: "+err.Error())
                return
        }
        writeJSON(w, 200, map[string]bool{"ok": true})
}

// ── v0.44: the chat background TEXTURE ─────────────────────────────
// The gradient editor's texture pick (a blended overlay UNDER the
// gradient — background-blend-mode: color client-side) gets its own kv
// row, exactly like the background image: "chat.tex.<sid>" =
// {"rev":N,"mime":"…","b64":"…"}. The tweaks blob's bg slot carries only
// texRev (never the bytes) so the tiny blob stays tiny; the css
// composes the engine URL ?v=<rev> as the bottom background-image layer.

func chatTexKey(sid string) string { return "chat.tex." + sid }

// handleSessionTexturePut is PUT /api/sessions/{id}/texture — raw image
// bytes (the shared uikit pipeline downscales to ≤512px JPEG q0.8 before
// sending, so typically well under 100KB). Same contract as the
// background PUT: magic-byte sniffing (Content-Type is advisory), rev
// bump on re-upload, {ok,rev,mime} response.
func (s *Server) handleSessionTexturePut(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        if sess, err := s.db.GetSession(id); err != nil {
                writeError(w, 500, "get: "+err.Error())
                return
        } else if sess == nil {
                writeError(w, 404, "not found")
                return
        }
        body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, bgMaxBytes))
        if err != nil {
                writeError(w, 413, "texture too large (4MB cap — the app downscales to ≤512px before upload)")
                return
        }
        if len(body) == 0 {
                writeError(w, 400, "empty body")
                return
        }
        mime := sniffImageMime(body)
        if mime == "" {
                writeError(w, 415, "not a recognized image (jpeg, png, gif, webp)")
                return
        }
        rec := bgRecord{Rev: 1, Mime: mime}
        if raw, err := s.db.GetSetting(chatTexKey(id)); err == nil && strings.TrimSpace(raw) != "" {
                var prev bgRecord
                if json.Unmarshal([]byte(raw), &prev) == nil && prev.Rev > 0 {
                        rec.Rev = prev.Rev + 1
                }
        }
        rec.B64 = base64.StdEncoding.EncodeToString(body)
        raw, err := json.Marshal(rec)
        if err != nil {
                writeError(w, 500, "encode: "+err.Error())
                return
        }
        if err := s.db.SetSetting(chatTexKey(id), string(raw)); err != nil {
                writeError(w, 500, "save: "+err.Error())
                return
        }
        writeJSON(w, 200, map[string]any{"ok": true, "rev": rec.Rev, "mime": mime})
}

// handleSessionTextureGet is GET /api/sessions/{id}/texture?v=N — the
// stored texture bytes (404 when the gradient has none). Immutable per
// ?v=rev, so it carries the same forever-cache header as the background.
func (s *Server) handleSessionTextureGet(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        if sess, err := s.db.GetSession(id); err != nil {
                writeError(w, 500, "get: "+err.Error())
                return
        } else if sess == nil {
                writeError(w, 404, "not found")
                return
        }
        raw, err := s.db.GetSetting(chatTexKey(id))
        if err != nil {
                writeError(w, 500, "texture: "+err.Error())
                return
        }
        if strings.TrimSpace(raw) == "" {
                writeError(w, 404, "no texture set")
                return
        }
        var rec bgRecord
        if err := json.Unmarshal([]byte(raw), &rec); err != nil || rec.B64 == "" {
                writeError(w, 404, "no texture set")
                return
        }
        img, err := base64.StdEncoding.DecodeString(rec.B64)
        if err != nil || sniffImageMime(img) == "" {
                writeError(w, 500, "stored texture is corrupt")
                return
        }
        w.Header().Set("Content-Type", rec.Mime)
        w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
        w.Header().Set("Content-Length", strconv.Itoa(len(img)))
        w.WriteHeader(http.StatusOK)
        _, _ = w.Write(img)
}

// handleSessionTextureDelete is DELETE /api/sessions/{id}/texture — drop
// the texture (the tweaks blob's texRev is the client's to clear).
func (s *Server) handleSessionTextureDelete(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        if sess, err := s.db.GetSession(id); err != nil {
                writeError(w, 500, "get: "+err.Error())
                return
        } else if sess == nil {
                writeError(w, 404, "not found")
                return
        }
        if err := s.db.DeleteSetting(chatTexKey(id)); err != nil {
                writeError(w, 500, "delete: "+err.Error())
                return
        }
        writeJSON(w, 200, map[string]bool{"ok": true})
}

// handleSessionIconPut is PUT /api/sessions/{id}/icon — the custom chat
// icon's raw image bytes (square-cropped by the shared CropUI pipeline,
// downscaled client-side, so typically tens of KB). Same contract as the
// background/texture PUTs: magic-byte sniffing, rev bump, {ok,rev,mime}.
func (s *Server) handleSessionIconPut(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        if sess, err := s.db.GetSession(id); err != nil {
                writeError(w, 500, "get: "+err.Error())
                return
        } else if sess == nil {
                writeError(w, 404, "not found")
                return
        }
        body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, iconMaxBytes))
        if err != nil {
                writeError(w, 413, "icon too large (2MB cap — the app square-crops and downscales before upload)")
                return
        }
        if len(body) == 0 {
                writeError(w, 400, "empty body")
                return
        }
        mime := sniffImageMime(body)
        if mime == "" {
                writeError(w, 415, "not a recognized image (jpeg, png, gif, webp)")
                return
        }
        rec := bgRecord{Rev: 1, Mime: mime}
        if raw, err := s.db.GetSetting(chatIconKey(id)); err == nil && strings.TrimSpace(raw) != "" {
                var prev bgRecord
                if json.Unmarshal([]byte(raw), &prev) == nil && prev.Rev > 0 {
                        rec.Rev = prev.Rev + 1
                }
        }
        rec.B64 = base64.StdEncoding.EncodeToString(body)
        raw, err := json.Marshal(rec)
        if err != nil {
                writeError(w, 500, "encode: "+err.Error())
                return
        }
        if err := s.db.SetSetting(chatIconKey(id), string(raw)); err != nil {
                writeError(w, 500, "save: "+err.Error())
                return
        }
        writeJSON(w, 200, map[string]any{"ok": true, "rev": rec.Rev, "mime": mime})
}

// handleSessionIconGet is GET /api/sessions/{id}/icon?v=N — the custom
// icon bytes (404 when the chat uses a built-in/default icon).
func (s *Server) handleSessionIconGet(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        if sess, err := s.db.GetSession(id); err != nil {
                writeError(w, 500, "get: "+err.Error())
                return
        } else if sess == nil {
                writeError(w, 404, "not found")
                return
        }
        raw, err := s.db.GetSetting(chatIconKey(id))
        if err != nil {
                writeError(w, 500, "icon: "+err.Error())
                return
        }
        if strings.TrimSpace(raw) == "" {
                writeError(w, 404, "no custom icon set")
                return
        }
        var rec bgRecord
        if err := json.Unmarshal([]byte(raw), &rec); err != nil || rec.B64 == "" {
                writeError(w, 404, "no custom icon set")
                return
        }
        img, err := base64.StdEncoding.DecodeString(rec.B64)
        if err != nil || sniffImageMime(img) == "" {
                writeError(w, 500, "stored icon is corrupt")
                return
        }
        w.Header().Set("Content-Type", rec.Mime)
        w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
        w.Header().Set("Content-Length", strconv.Itoa(len(img)))
        w.WriteHeader(http.StatusOK)
        _, _ = w.Write(img)
}

// handleSessionIconDelete is DELETE /api/sessions/{id}/icon — drop the
// custom icon (the tweaks blob's iconCustom flag is the client's to clear).
func (s *Server) handleSessionIconDelete(w http.ResponseWriter, r *http.Request) {
        id := r.PathValue("id")
        if sess, err := s.db.GetSession(id); err != nil {
                writeError(w, 500, "get: "+err.Error())
                return
        } else if sess == nil {
                writeError(w, 404, "not found")
                return
        }
        if err := s.db.DeleteSetting(chatIconKey(id)); err != nil {
                writeError(w, 500, "delete: "+err.Error())
                return
        }
        writeJSON(w, 200, map[string]bool{"ok": true})
}

// deleteSessionTweaks drops a chat's tweak + background + texture + icon
// rows (called from the session DELETE handler so chats don't leak kv rows).
func (s *Server) deleteSessionTweaks(id string) {
        _ = s.db.DeleteSetting(chatTweaksKey(id))
        _ = s.db.DeleteSetting(chatBgKey(id))
        _ = s.db.DeleteSetting(chatTexKey(id))
        _ = s.db.DeleteSetting(chatIconKey(id))
}

// ── v0.52: the CHAT ICON (user spec item 10) ───────────────────────
// "Let's add new features to tweaks… changing the chat icon (the default
//  icon; the user will provide their own default icon set later), and the
//  user can customize by browsing an image — reusing the existing browse
//  image + crop method."
//
// The custom icon bytes ride their own kv row ("chat.icon.<sid>" = the
// bgRecord shape) exactly like the background/texture; the tweaks blob
// carries the selection: {iconIndex:N} for a built-in default icon, or
// {iconCustom:true, iconRev:N} for the uploaded one (absent keys = the
// stock family glyph, exactly as before). Served at
// GET /api/sessions/{id}/icon — same immutable-cache contract.
