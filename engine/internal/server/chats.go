package server

import (
        "net/http"

        "github.com/ScoobyBaby1999/doomalay/engine/internal/store"
)

// handleChats is GET /api/chats — the ALL-CHATS INDEX.
//
// The canvas shows chats as icons; this is the "browse every
// conversation" surface (the WhatsApp/Telegram sidebar pattern): every
// session, most recently active first, each with a one-line preview of
// where it left off and its visible message count. Hide-masked events
// (delete / edit / regenerate) are excluded with the same semantics as
// buildHistory — a deleted last message never previews.
func (s *Server) handleChats(w http.ResponseWriter, r *http.Request) {
        limit := 200
        items, err := s.db.ListChats(limit)
        if err != nil {
                writeError(w, 500, "chats: "+err.Error())
                return
        }
        for _, it := range items {
                it.Preview = store.TrimPreview(it.Preview, 140)
        }
        if items == nil {
                items = []*store.ChatListItem{}
        }
        writeJSON(w, 200, map[string]any{"chats": items})
}
