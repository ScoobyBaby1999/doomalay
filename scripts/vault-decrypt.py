#!/usr/bin/env python3
"""Decrypt a vault entry for debugging (our own infra — the space token
the engine minted at adopt). master.key = AES-GCM key, secrets.json holds
key_cipher/key_nonce."""
import base64
import json
import sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pathlib import Path

data = Path(sys.argv[1])
env = sys.argv[2]
master = (data / "master.key").read_bytes()  # raw 32 bytes (not base64)
secrets = json.loads((data / "secrets.json").read_text())
ent = secrets[env]
ct = base64.b64decode(ent["key_cipher"])
nonce = base64.b64decode(ent["key_nonce"])
aes = AESGCM(master)
print(aes.decrypt(nonce, ct, None).decode())
