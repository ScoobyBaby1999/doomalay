// Copyright (c) Edgeless Systems GmbH — upstream package MIT; this
// TOFU variant is a doomalay local delta (see pm/PROVENANCE.md).
//
// Package attest provides a Getter to get the mesh CA of the
// Privatemode deployment. DOOMALAY TRUST CONTRACT: the pinned CA is
// established at provider-connect time by the one-shot WASM oracle
// (the vendored npm privatemode-ai SDK, MIT artifact, which runs the
// full Contrast attestation verification we cannot compile — its
// sdk dependency is BSL-1.1). This getter only FETCHES the
// coordinator attestation document and extracts the mesh CA (TOFU:
// trust-on-first-use, gated by the oracle). It never verifies the
// SNP attestation itself.
package attest

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"

	"github.com/ScoobyBaby1999/doomalay/engine/internal/pm/auth"
	"github.com/ScoobyBaby1999/doomalay/engine/internal/pm/httpapi"
)

// ErrManifestMismatch mirrors the upstream sentinel.
var ErrManifestMismatch = errors.New("active manifest does not match expected manifest")

// Getter is a client that gets the mesh CA of the Privatemode deployment.
type Getter struct {
	httpClient *http.Client
	endpoint   string
}

// NewGetter creates a new Getter.
func NewGetter(httpClient *http.Client, endpoint string) Getter {
	return Getter{httpClient: httpClient, endpoint: endpoint}
}

// attestationDoc is the wire shape of the coordinator's attestation
// response (live-observed 2026-10-19; snake_case JSON, base64 fields):
//
//	{AttestationDoc: base64(JSON{
//	  version, attestation_type, manifests: [base64(manifest)],
//	  policies, mesh_ca: base64(PEM), root_ca, raw_attestation_doc})}
//
// The engine reads manifests + mesh_ca only.
type attestationDoc struct {
	Manifests []string `json:"manifests"`
	MeshCA    string   `json:"mesh_ca"`
}

// GetAttestedMeshCA fetches the coordinator attestation document and
// extracts the mesh CA certificate. When expectedMfBytes is non-nil the
// first manifest is compared byte-for-byte (the pinned-manifest check).
func (c Getter) GetAttestedMeshCA(ctx context.Context, expectedMfBytes []byte, cred auth.Credential) (*x509.Certificate, error) {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("generating nonce: %w", err)
	}
	attestReq, err := json.Marshal(httpapi.AttestReq{Nonce: nonce})
	if err != nil {
		return nil, fmt.Errorf("marshaling attest request: %w", err)
	}
	attestResp, err := httpapi.Do(ctx, c.httpClient, http.MethodPost, "https://"+c.endpoint+"/privatemode/v1/attest", attestReq, cred)
	if err != nil {
		return nil, fmt.Errorf("doing attest request: %w", err)
	}
	var outer struct {
		AttestationDoc string `json:"AttestationDoc"`
	}
	if err := json.Unmarshal(attestResp, &outer); err != nil {
		return nil, fmt.Errorf("unmarshaling attest response: %w", err)
	}
	inner, err := base64.StdEncoding.DecodeString(outer.AttestationDoc)
	if err != nil {
		return nil, fmt.Errorf("decoding attestation doc: %w", err)
	}
	var doc attestationDoc
	if err := json.Unmarshal(inner, &doc); err != nil {
		return nil, fmt.Errorf("unmarshaling attestation doc: %w", err)
	}
	if len(doc.Manifests) == 0 {
		return nil, errors.New("coordinator state does not include manifests")
	}
	if expectedMfBytes != nil {
		mf, err := base64.StdEncoding.DecodeString(doc.Manifests[0])
		if err != nil {
			return nil, fmt.Errorf("decoding manifest: %w", err)
		}
		if !bytes.Equal(mf, expectedMfBytes) {
			return nil, ErrManifestMismatch
		}
	}
	caPEM, err := base64.StdEncoding.DecodeString(doc.MeshCA)
	if err != nil {
		return nil, fmt.Errorf("decoding mesh CA: %w", err)
	}
	block, _ := pem.Decode(caPEM)
	if block == nil {
		return nil, errors.New("decoding mesh CA certificate failed")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parsing mesh CA certificate: %w", err)
	}
	return cert, nil
}
