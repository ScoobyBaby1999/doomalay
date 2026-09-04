package server

import (
        "encoding/json"
        "fmt"
        "net/http"
)

// handleDeviceInfo is GET /api/device-info — returns server-side detected device
// specs. The PWA supplements this with navigator.* APIs for the client side.
// Used by the model picker to recommend a local model based on RAM.
func (s *Server) handleDeviceInfo(w http.ResponseWriter, r *http.Request) {
        info := map[string]any{
                "platform":    "android-apk", // this engine runs inside the APK
                "engine_mode": s.cfg.Mode,
                "has_brain":   s.brain != nil && s.brain.Healthy(),
                // The client adds: navigator.hardwareConcurrency, navigator.deviceMemory,
                // navigator.userAgent, screen dimensions.
        }
        writeJSON(w, 200, info)
}

// handleLocalModels is GET /api/local-models — probes for local LLM runtimes
// (Ollama at localhost:11434) and returns available models. Used by the
// "Use Local Model" picker. If no local runtime is found, returns an empty
// list + a recommendation based on the client's reported RAM.
func (s *Server) handleLocalModels(w http.ResponseWriter, r *http.Request) {
        // Probe Ollama at localhost:11434/api/tags (the standard Ollama endpoint).
        // 2s timeout — if Ollama isn't running, fail fast.
        type ollamaTag struct {
                Name string `json:"name"`
                Size int64  `json:"size"`
        }
        type ollamaResp struct {
                Models []ollamaTag `json:"models"`
        }

        models := []map[string]any{}
        ollamaURL := "http://127.0.0.1:11434/api/tags"

        client := &http.Client{Timeout: 2 * 1_000_000_000} // 2s
        resp, err := client.Get(ollamaURL)
        if err == nil && resp != nil {
                defer resp.Body.Close()
                if resp.StatusCode == 200 {
                        var data ollamaResp
                        if json.NewDecoder(resp.Body).Decode(&data) == nil {
                                for _, m := range data.Models {
                                        models = append(models, map[string]any{
                                                "id":       m.Name,
                                                "name":     m.Name,
                                                "provider": "ollama",
                                                "size":     m.Size,
                                                "running":  true,
                                        })
                                }
                        }
                }
        }

        // RAM-based recommendation (the client passes its detected RAM via query param).
        ramGB := 0
        if v := r.URL.Query().Get("ram"); v != "" {
                fmt.Sscanf(v, "%d", &ramGB)
        }
        recommendation := recommendModelByRAM(ramGB)

        writeJSON(w, 200, map[string]any{
                "models":         models,
                "ollama_running": len(models) > 0,
                "recommendation": recommendation,
                "ram_gb":         ramGB,
        })
}

// recommendModelByRAM returns a model ID + label suited for the given RAM.
// Hardcoded table — correlates model size to device RAM. The client passes
// navigator.deviceMemory (Chrome) or an estimate.
func recommendModelByRAM(ramGB int) map[string]any {
        switch {
        case ramGB <= 0:
                return map[string]any{"id": "", "label": "Unknown RAM — can't recommend", "min_ram": 0}
        case ramGB < 4:
                return map[string]any{
                        "id": "llama3.2:1b", "label": "Llama 3.2 1B (tiny, fast)",
                        "min_ram": 2, "note": "Smallest viable model. Fits in 2GB+ RAM.",
                }
        case ramGB < 8:
                return map[string]any{
                        "id": "llama3.2:3b", "label": "Llama 3.2 3B (small, capable)",
                        "min_ram": 4, "note": "Good balance for phones. Fits in 4GB+ RAM.",
                }
        case ramGB < 16:
                return map[string]any{
                        "id": "llama3.1:8b", "label": "Llama 3.1 8B (balanced)",
                        "min_ram": 8, "note": "Capable model for 8GB+ devices.",
                }
        case ramGB < 32:
                return map[string]any{
                        "id": "qwen2.5:14b", "label": "Qwen 2.5 14B (strong)",
                        "min_ram": 16, "note": "Strong reasoning for 16GB+ devices.",
                }
        default:
                return map[string]any{
                        "id": "llama3.1:70b", "label": "Llama 3.1 70B (quantized)",
                        "min_ram": 32, "note": "Large model for 32GB+ devices (desktop/server).",
                }
        }
}
