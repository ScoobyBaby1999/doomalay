package llm

// localtools_v1701_test.go — v1.70.1 THE ROBUST FIELD pins (the provider
// campaign's convictions, unit-pinned):
//
//   - THE COERCED ARG: a "text" param arriving as a raw JSON OBJECT
//     (json_tool got {"a":1}) coerces to compact JSON text instead of
//     silently parsing an empty string (the campaign's FAIL verdict on a
//     perfectly good tool).
//   - THE LOUD REQUIREMENT: a missing/empty required text param answers
//     the honest teach, never a silent empty success.
//   - json_tool "pretty": the manifest's own enum value finally maps to
//     format (it used to silently fall to validate).
//   - THE POWER OP: `**` is Python-style power with Python precedence
//     (2*3**2 == 18), alongside the existing ^.
//   - THE UNDEUPED RETRY classifier: a failed observation is detected;
//     a success and a mere truncation are not.
//   - THE HONEST REGION/QUOTA: limit-wearing 401s classify as quota
//     (cooldown, not the engine-lifetime auth blacklist); region 403s
//     are model-scoped (no provider penalty); both carry friendly text
//     that names the switch path.

import (
        "strings"
        "testing"
)

func TestV1701_CoercedArgJSONTool(t *testing.T) {
        // the exact live fumble: text passed as a raw JSON object
        got := RunLocalTool("json_tool", `{"mode":"validate","text":{"a":1,"b":[2,3],"c":{"d":"e"}}}`, nil)
        if !strings.Contains(got, "valid JSON") {
                t.Fatalf("object-coerced text must validate: %s", got)
        }
        got = RunLocalTool("json_tool", `{"mode":"pretty","text":{"a":1}}`, nil)
        if !strings.Contains(got, "\"a\": 1") {
                t.Fatalf("pretty mode must format (was silently validate): %s", got)
        }
        got = RunLocalTool("json_tool", `{"mode":"minify","text":{"system":"doomalay","day":23}}`, nil)
        if strings.Contains(got, "error") || !strings.Contains(got, `"day":23`) {
                t.Fatalf("minify on coerced object must succeed: %s", got)
        }
}

func TestV1701_LoudRequiredText(t *testing.T) {
        for _, tool := range []string{"base64", "hash", "text_stats", "url_encode", "regex_extract", "json_tool"} {
                got := RunLocalTool(tool, `{"mode":"encode","pattern":"x"}`, nil)
                if !strings.Contains(got, "error:") || !strings.Contains(got, "needs {\"text\"") {
                        t.Fatalf("%s must teach the missing text param loudly, got: %s", tool, got)
                }
        }
        // a typo'd key (the live base64 conviction) teaches too
        got := RunLocalTool("base64", `{"mode":"encode","txet":"doomalay"}`, nil)
        if !strings.Contains(got, "error:") {
                t.Fatalf("typo'd param must not silently succeed: %s", got)
        }
        // string inputs keep working exactly as before
        got = RunLocalTool("base64", `{"mode":"encode","text":"doomalay"}`, nil)
        if !strings.Contains(got, "ZG9vbWFsYXk=") {
                t.Fatalf("plain string text must still encode: %s", got)
        }
}

func TestV1701_CalculatorDoubleStar(t *testing.T) {
        cases := map[string]string{
                "2**10":            "1024",
                "3.5**4":           "150.0625",
                "2*3**2":           "18", // Python precedence: 2*(3**2)
                "2**3*4":           "32", // (2**3)*4
                "2**-2":            "0.25",
                "2^3":              "8",  // the old power op keeps working
                "(65535/255)+3.5**4+17*23": "798.0625", // the campaign's live expression
        }
        for expr, want := range cases {
                got := calcEval(expr)
                if got != want {
                        t.Fatalf("calcEval(%q) = %s, want %s", expr, got, want)
                }
        }
}

func TestV1701_FailedObservationClassifier(t *testing.T) {
        fails := []string{
                "OBSERVATION:\nerror: not valid base64 — x",
                "OBSERVATION:\nREFUSED — the command looks like the file-destroying class",
                "OBSERVATION:\nJAIL REFUSED: /etc is outside",
                "OBSERVATION:\nTIMEOUT — the 600s exec budget ended",
                "OBSERVATION:\nerror: exec rate cap — this chat's burst cap is 5",
                "OBSERVATION:\nEXEC DONE — workdir /x\nexit_code: 1\nstdout:\n(error from inner script) whatever\nstderr:\nerror: boom",
        }
        for _, obs := range fails {
                if !failedObservation(obs, false) {
                        t.Fatalf("must classify as failed: %q", obs[:min(60, len(obs))])
                }
        }
        // successes + mere truncations must NOT be classified failed
        oks := []string{
                "OBSERVATION:\n391",
                "OBSERVATION:\nEXEC DONE — workdir /x\nexit_code: 0\nstdout:\nall good",
                "OBSERVATION:\nbig listing\n[truncated: first 8192 of 99999 bytes shown]",
                "OBSERVATION:\nTEXT — notes.txt (10 bytes)\nthe text mentions error: in prose but is a success",
        }
        for _, obs := range oks {
                if failedObservation(obs, false) {
                        t.Fatalf("must NOT classify as failed: %q", obs[:min(60, len(obs))])
                }
        }
}

func TestV1701_RegionQuotaClassification(t *testing.T) {
        // the live PrivateMode 401: quota wearing auth's clothes
        pmBody := `{"error":{"message":"invalid API key: you have exceeded your organization's monthly limit of 1000000 prompt tokens","type":""}}`
        if got := ClassifyProviderError(401, pmBody); got != "quota" {
                t.Fatalf("limit-wearing 401 must classify quota, got %s", got)
        }
        // the live OpenRouter 403: region-blocked MODEL on a working provider
        orBody := `{"error":{"message":"This model is not available in your region.","code":403}}`
        if got := ClassifyProviderError(403, orBody); got != "modelgone" {
                t.Fatalf("region 403 must be model-scoped, got %s", got)
        }
        // a real bad key stays auth (the engine-lifetime blacklist)
        if got := ClassifyProviderError(401, `{"error":{"message":"invalid api key"}}`); got != "auth" {
                t.Fatalf("plain bad key must stay auth, got %s", got)
        }
        // the friendly text names the switch path for both live shapes
        msg := friendlyHTTPErrorFor(403, orBody, "openrouter", "anthropic/claude-haiku-5.5")
        if !strings.Contains(msg, "region-blocked") || !strings.Contains(msg, "Pick another model") {
                t.Fatalf("region friendly text drifted: %s", msg)
        }
        msg = friendlyHTTPErrorFor(401, pmBody, "privatemodeai", "glm-5.3")
        if !strings.Contains(msg, "quota") || !strings.Contains(msg, "switch provider") {
                t.Fatalf("quota friendly text drifted: %s", msg)
        }
        // and the permanent blacklist no longer fires for the quota shape
        // (a 60s cooldown is correct and DOES make it briefly unavailable —
        // the conviction is that it is not the engine-lifetime blacklist)
        RecordProviderFailure("privatemodeai-test", ClassifyProviderError(401, pmBody), "x")
        _, blacklisted, _ := ProviderState("privatemodeai-test")
        if blacklisted {
                t.Fatalf("quota 401 must NOT permanently blacklist the provider")
        }
        RecordProviderFailure("badkey-test", "auth", "x")
        if ProviderAvailable("badkey-test") {
                t.Fatalf("a real auth failure must still blacklist")
        }
}
