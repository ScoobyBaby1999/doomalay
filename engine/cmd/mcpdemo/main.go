// mcpdemo — v1.13.6 THE REDTEAM's chain-verification artifact (PLAN-V113 §6).
//
// A standalone, STATELESS streamable-HTTP MCP server that registers a
// configurable fleet of deterministic tools (default 100 — the 100+ tools
// horizon made concrete). The rig (scripts/v1136-redteam-rig.mjs) chains it
// onto a REAL engine's mcpbus and proves:
//
//   - the manifest scale: 100+ proxied tools flow through initialize →
//     tools/list (with pagination) → the merged Specs() manifest;
//   - the routing: a native tool_call to demo_tool_42 reaches THIS server
//     and the answer flows back through the bus to the model;
//   - the honest-degrade contracts: `boom` (error result), `hang` (the
//     per-call timeout), `boom_panic` (a panicking handler) — none of them
//     may kill the turn.
//
// Usage:
//
//	go run ./cmd/mcpdemo --port 8600 --tools 100
//
// Endpoints: POST /mcp (the MCP streamable endpoint), GET /healthz (rig
// startup probe). Everything is stateless — any request is answerable.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

var startTime = time.Now()

func main() {
	port := flag.Int("port", 8600, "listen port")
	tools := flag.Int("tools", 100, "how many demo tool_N tools to register")
	flag.Parse()

	srv := server.NewMCPServer("mcpdemo", "1.13.6",
		server.WithToolCapabilities(false),
	)

	// tool_1..tool_N — deterministic arithmetic echoes: tool_i with n
	// answers "tool_i computed n*6=<v>". The rig asserts the EXACT value,
	// proving the call reached THIS server (not a local tool).
	for i := 1; i <= *tools; i++ {
		i := i
		name := fmt.Sprintf("tool_%d", i)
		srv.AddTool(mcp.NewTool(name,
			mcp.WithDescription(fmt.Sprintf("Demo tool #%d of the mcpdemo fleet — multiplies n by 6 and reports tool_%d's own identity in the answer.", i, i)),
			mcp.WithNumber("n", mcp.Required(), mcp.Description("the number to multiply by 6")),
		), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			n, _ := req.RequireFloat("n")
			return mcp.NewToolResultText(fmt.Sprintf("tool_%d computed %.0f*6=%.0f", i, n, n*6)), nil
		})
	}

	// twin_calculator — a REAL calculator twin (the v1.13.4 chain proof
	// used B→A calls: the rig asks engine A's chat and the demo answers).
	srv.AddTool(mcp.NewTool("twin_calculator",
		mcp.WithDescription("Evaluates a plain arithmetic expression (+ - * / parentheses)."),
		mcp.WithString("expr", mcp.Required(), mcp.Description("the expression, e.g. 6*7")),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		expr, _ := req.RequireString("expr")
		v, err := evalArith(expr)
		if err != nil {
			return mcp.NewToolResultError("twin_calculator: " + err.Error()), nil
		}
		return mcp.NewToolResultText(fmt.Sprintf("%s = %s", strings.TrimSpace(expr), formatNum(v))), nil
	})

	// boom — a tool-level error result (the model self-corrects next round).
	srv.AddTool(mcp.NewTool("boom",
		mcp.WithDescription("ALWAYS fails with a tool error — the honest-degrade probe."),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return mcp.NewToolResultError("demo fault injector: boom always fails (by design)"), nil
	})

	// hang — never answers in time; the bus per-call timeout must cut it.
	srv.AddTool(mcp.NewTool("hang",
		mcp.WithDescription("ALWAYS sleeps 5 minutes — the per-call timeout probe."),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(5 * time.Minute):
			return mcp.NewToolResultText("finally awake (nobody should wait this long)"), nil
		}
	})

	// boom_panic — a panicking handler: the SERVER must contain it
	// (an HTTP-level 5xx), and the bus proxy converts it to a tool error.
	srv.AddTool(mcp.NewTool("boom_panic",
		mcp.WithDescription("PANICS on purpose — the contained-panic-through-the-chain probe."),
	), func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		panic("demo fault injector: boom_panic panics by design")
	})

	httpSrv := server.NewStreamableHTTPServer(srv, server.WithStateLess(true))
	mux := http.NewServeMux()
	mux.Handle("/mcp", httpSrv)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"ok":true,"server":"mcpdemo","tools":%d,"uptime_sec":%.0f}`, *tools+4, time.Since(startTime).Seconds())
	})

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	log.Printf("mcpdemo: stateless streamable HTTP MCP server on http://%s/mcp — %d fleet tools + twin_calculator/boom/hang/boom_panic", addr, *tools)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

// ── the tiny expression evaluator (plain + - * / parens) ────────────────

func evalArith(s string) (float64, error) {
	p := &arithParser{src: []rune(strings.TrimSpace(s))}
	p.next()
	v, err := p.parseExpr()
	if err != nil {
		return 0, err
	}
	if p.tok != 0 {
		return 0, fmt.Errorf("unexpected %q after expression", string(p.tok))
	}
	return v, nil
}

type arithParser struct {
	src []rune
	pos int
	tok rune
}

func (p *arithParser) next() {
	for p.pos < len(p.src) && (p.src[p.pos] == ' ' || p.src[p.pos] == '\t') {
		p.pos++
	}
	if p.pos >= len(p.src) {
		p.tok = 0
		return
	}
	p.tok = p.src[p.pos]
	p.pos++
}

func (p *arithParser) parseExpr() (float64, error) {
	v, err := p.parseTerm()
	if err != nil {
		return 0, err
	}
	for p.tok == '+' || p.tok == '-' {
		op := p.tok
		p.next()
		rhs, err := p.parseTerm()
		if err != nil {
			return 0, err
		}
		if op == '+' {
			v += rhs
		} else {
			v -= rhs
		}
	}
	return v, nil
}

func (p *arithParser) parseTerm() (float64, error) {
	v, err := p.parseFactor()
	if err != nil {
		return 0, err
	}
	for p.tok == '*' || p.tok == '/' {
		op := p.tok
		p.next()
		rhs, err := p.parseFactor()
		if err != nil {
			return 0, err
		}
		if op == '*' {
			v *= rhs
		} else {
			if rhs == 0 {
				return 0, fmt.Errorf("division by zero")
			}
			v /= rhs
		}
	}
	return v, nil
}

func (p *arithParser) parseFactor() (float64, error) {
	if p.tok == '(' {
		p.next()
		v, err := p.parseExpr()
		if err != nil {
			return 0, err
		}
		if p.tok != ')' {
			return 0, fmt.Errorf("missing )")
		}
		p.next()
		return v, nil
	}
	if p.tok == '-' {
		p.next()
		v, err := p.parseFactor()
		return -v, err
	}
	start := p.pos - 1
	for p.pos < len(p.src) && (p.src[p.pos] >= '0' && p.src[p.pos] <= '9' || p.src[p.pos] == '.') {
		p.pos++
	}
	numStr := string(p.src[start:p.pos])
	if numStr == "" || numStr == "." {
		return 0, fmt.Errorf("unexpected %q (want a number)", string(p.tok))
	}
	v, err := strconv.ParseFloat(numStr, 64)
	if err != nil {
		return 0, fmt.Errorf("bad number %q", numStr)
	}
	p.next()
	return v, nil
}

func formatNum(v float64) string {
	if v == float64(int64(v)) {
		return strconv.FormatInt(int64(v), 10)
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}
