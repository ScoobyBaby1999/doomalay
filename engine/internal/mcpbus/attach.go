package mcpbus

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/client"
	"github.com/mark3labs/mcp-go/client/transport"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// attach.go — v1.13.4 THE CHAIN (PLAN-V113 §4).
//
// The bus becomes an MCP AGGREGATOR: external MCP servers (stdio
// subprocesses on desktop, streamable-HTTP remotes anywhere) attach with
// a namespace prefix, their tools list merges into the manifest (the
// 100+ tools horizon), and every call routes through the SAME bus —
// our MCPServer hosts PROXY tools that forward to the external client,
// so the chat loop's calling convention never changes and the
// observers/hooks see external calls exactly like internal ones.
//
// Android: stdio subprocesses are skipped (Android restricts exec;
// streamable-HTTP remotes work everywhere).

// ServerConfig describes ONE external MCP server to chain.
type ServerConfig struct {
	Name      string            `json:"name"`                // the namespace (tools appear as name_tool)
	Command   string            `json:"command,omitempty"`   // stdio transport: the executable
	Args      []string          `json:"args,omitempty"`      // stdio: its arguments
	Env       []string          `json:"env,omitempty"`       // stdio: extra env (KEY=VAL)
	URL       string            `json:"url,omitempty"`       // streamable-HTTP transport
	Headers   map[string]string `json:"headers,omitempty"`   // HTTP: extra headers (auth…)
	TimeoutMS int               `json:"timeout_ms,omitempty"` // per-call timeout (default 60s)
}

// extTool is one proxied external tool.
type extTool struct {
	client       *client.Client
	externalName string
	timeout      time.Duration
}

// defaultExternalTimeout bounds one external tool call.
const defaultExternalTimeout = 60 * time.Second

// LoadServerConfigs reads the chain config: the DOOMALAY_MCP_SERVERS env
// var (a JSON array) overrides, then <dataDir>/mcp_servers.json.
func LoadServerConfigs(dataDir string) []ServerConfig {
	if raw := os.Getenv("DOOMALAY_MCP_SERVERS"); strings.TrimSpace(raw) != "" {
		var cfgs []ServerConfig
		if err := json.Unmarshal([]byte(raw), &cfgs); err != nil {
			log.Printf("mcpbus: DOOMALAY_MCP_SERVERS is not valid JSON — ignoring: %v", err)
			return nil
		}
		return cfgs
	}
	if dataDir == "" {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(dataDir, "mcp_servers.json"))
	if err != nil {
		return nil // no config file = no external servers (the normal case)
	}
	var cfgs []ServerConfig
	if err := json.Unmarshal(raw, &cfgs); err != nil {
		log.Printf("mcpbus: %s/mcp_servers.json is not valid JSON — ignoring: %v", dataDir, err)
		return nil
	}
	return cfgs
}

// Attach connects one external MCP server and proxies its tools onto the
// bus under the "<name>_tool" namespace. Failures are logged and
// returned — one bad server never blocks the chain.
func (b *Bus) Attach(ctx context.Context, cfg ServerConfig) error {
	if cfg.Name == "" {
		return fmt.Errorf("mcpbus: attach needs a name")
	}
	if cfg.Command == "" && cfg.URL == "" {
		return fmt.Errorf("mcpbus: attach %q needs command (stdio) or url (HTTP)", cfg.Name)
	}
	if cfg.Command != "" && cfg.URL != "" {
		return fmt.Errorf("mcpbus: attach %q: command and url are exclusive", cfg.Name)
	}
	if cfg.Command != "" && runtime.GOOS == "android" && os.Getenv("DOOMALAY_MCP_ALLOW_STDIO") != "1" {
		log.Printf("mcpbus: skipping stdio server %q on Android (exec restrictions; set DOOMALAY_MCP_ALLOW_STDIO=1 to force)", cfg.Name)
		return nil
	}

	timeout := time.Duration(cfg.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = defaultExternalTimeout
	}

	var cli *client.Client
	var err error
	if cfg.URL != "" {
		opts := []transport.StreamableHTTPCOption{}
		if len(cfg.Headers) > 0 {
			opts = append(opts, transport.WithHTTPHeaders(cfg.Headers))
		}
		cli, err = client.NewStreamableHttpClient(cfg.URL, opts...)
		if err != nil {
			return fmt.Errorf("mcpbus: attach %q: HTTP client: %w", cfg.Name, err)
		}
	} else {
		cli, err = client.NewStdioMCPClient(cfg.Command, cfg.Env, cfg.Args...)
		if err != nil {
			return fmt.Errorf("mcpbus: attach %q: stdio client: %w", cfg.Name, err)
		}
	}
	if err := cli.Start(ctx); err != nil {
		return fmt.Errorf("mcpbus: attach %q: start: %w", cfg.Name, err)
	}
	initReq := mcp.InitializeRequest{Params: mcp.InitializeParams{
		ProtocolVersion: mcp.LATEST_PROTOCOL_VERSION,
		Capabilities:    mcp.ClientCapabilities{},
		ClientInfo:      mcp.Implementation{Name: "doomalay-engine", Version: busVersion},
	}}
	info, err := cli.Initialize(ctx, initReq)
	if err != nil {
		_ = cli.Close()
		return fmt.Errorf("mcpbus: attach %q: initialize: %w", cfg.Name, err)
	}

	// ListTools auto-follows pagination (the 100+ tool case).
	toolsRes, err := cli.ListTools(ctx, mcp.ListToolsRequest{})
	if err != nil {
		_ = cli.Close()
		return fmt.Errorf("mcpbus: attach %q: list tools: %w", cfg.Name, err)
	}

	prefix := cfg.Name + "_"
	attached := 0
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, tool := range toolsRes.Tools {
		prefixed := prefix + tool.Name
		if defByName(prefixed) != nil || b.external[prefixed] != nil {
			log.Printf("mcpbus: attach %q: tool %q collides with an existing tool — skipped", cfg.Name, prefixed)
			continue
		}
		desc := tool.Description
		if desc == "" {
			desc = "External tool " + tool.Name + " (via MCP server " + cfg.Name + ")."
		}
		schema := tool.InputSchema
		if schema.Type == "" {
			schema = mcp.ToolInputSchema{Type: "object", Properties: map[string]any{}}
		}
		schemaJSON, err := json.Marshal(schema)
		if err != nil {
			log.Printf("mcpbus: attach %q: tool %q schema unmarshalable — skipped: %v", cfg.Name, tool.Name, err)
			continue
		}
		ext := &extTool{client: cli, externalName: tool.Name, timeout: timeout}
		proxy := func(ext *extTool) server.ToolHandlerFunc {
			return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				callCtx, cancel := context.WithTimeout(ctx, ext.timeout)
				defer cancel()
				res, err := ext.client.CallTool(callCtx, mcp.CallToolRequest{
					Params: mcp.CallToolParams{
						Name:      ext.externalName,
						Arguments: req.GetArguments(),
					},
				})
				if err != nil {
					return mcp.NewToolResultError("external tool error: " + err.Error()), nil
				}
				return res, nil
			}
		}(ext)
		b.srv.AddTool(mcp.NewToolWithRawSchema(prefixed, desc, schemaJSON), proxy)
		b.external[prefixed] = ext
		b.externalSpecs = append(b.externalSpecs, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        prefixed,
				"description": desc,
				"parameters":  json.RawMessage(schemaJSON),
			},
		})
		attached++
	}
	log.Printf("mcpbus: chained %q (%s) — %d tools attached (%s)", cfg.Name, serverLabel(cfg, info), attached, transportLabel(cfg))
	return nil
}

func serverLabel(cfg ServerConfig, info *mcp.InitializeResult) string {
	if info != nil && info.ServerInfo.Name != "" {
		return info.ServerInfo.Name
	}
	return "unknown server"
}

func transportLabel(cfg ServerConfig) string {
	if cfg.URL != "" {
		return "streamable-http"
	}
	return "stdio"
}

// ExternalTools reports the chained external tool count (the scale
// readout).
func (b *Bus) ExternalTools() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.external)
}
