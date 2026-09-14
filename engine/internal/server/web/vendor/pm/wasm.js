import { PrivatemodeAPIError } from './errors.js';
import './wasm_exec.js';
let initialized = false;
let initializing = null;
/** SHA-256 the loaded module was verified with, or null if unverified. */
let loadedWasmHash = null;
function runGo(go, instance) {
    // Go disables its Fetch-based HTTP transport when process.argv0 starts with
    // "node", leaving js/wasm's fake network unable to reach external hosts.
    // Go.run enters the module synchronously, so hide argv0 while package
    // initializers select the transport. See https://go.dev/issue/60810.
    const globals = globalThis;
    const originalProcess = globals.process;
    const enableNodeFetch = typeof globalThis.fetch === 'function' &&
        typeof originalProcess?.argv0 === 'string' &&
        originalProcess.argv0.startsWith('node');
    if (enableNodeFetch) {
        globals.process = Object.create(originalProcess, {
            argv0: { value: 'wasm' },
        });
    }
    try {
        void go.run(instance);
    }
    finally {
        if (enableNodeFetch) {
            globals.process = originalProcess;
        }
    }
}
export async function initWasm(wasmSource, expectedHash) {
    if (initialized) {
        ensureHashMatchesLoaded(expectedHash);
        return;
    }
    if (initializing) {
        await initializing;
        ensureHashMatchesLoaded(expectedHash);
        return;
    }
    initializing = (async () => {
        async function verifyHash(data, expectedHash) {
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashHex = Array.from(new Uint8Array(hashBuffer))
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('');
            if (hashHex !== expectedHash.toLowerCase()) {
                throw new Error(`WASM integrity check failed: expected SHA-256 ${expectedHash}, got ${hashHex}`);
            }
        }
        const go = new Go();
        let result;
        const source = await wasmSource;
        if (source instanceof Response) {
            if (expectedHash) {
                // Need the raw bytes to hash, so we can't use streaming instantiation.
                const wasmBytes = await source.arrayBuffer();
                await verifyHash(wasmBytes, expectedHash);
                result = await WebAssembly.instantiate(wasmBytes, go.importObject);
            }
            else {
                // Browser: streaming instantiation
                result = await WebAssembly.instantiateStreaming(source, go.importObject);
            }
        }
        else {
            // Node.js: from buffer
            if (expectedHash) {
                // Hash exactly the bytes that are instantiated: for typed-array
                // views, the view's slice of the backing buffer, not the whole
                // backing buffer.
                const bytes = source instanceof ArrayBuffer
                    ? source
                    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
                await verifyHash(bytes, expectedHash);
            }
            result = await WebAssembly.instantiate(source, go.importObject);
        }
        runGo(go, result.instance);
        initialized = true;
        loadedWasmHash = expectedHash?.toLowerCase() ?? null;
    })();
    try {
        await initializing;
    }
    finally {
        initializing = null;
    }
}
/**
 * Check an expected hash against the hash the already-loaded module was
 * verified with. The module is loaded once per realm, so a later caller's
 * hash can only be honored by comparing it to the first load: a mismatch
 * fails, and so does providing a hash when the module was loaded without
 * integrity verification, instead of silently accepting any hash.
 */
function ensureHashMatchesLoaded(expectedHash) {
    if (!expectedHash)
        return;
    if (!loadedWasmHash) {
        throw new Error('WASM module was already loaded without integrity verification; the expected hash cannot be checked.');
    }
    if (loadedWasmHash !== expectedHash.toLowerCase()) {
        throw new Error(`WASM integrity check failed: module already loaded with SHA-256 ${loadedWasmHash}, expected ${expectedHash}`);
    }
}
/**
 * Create a new state-isolated Wasm client. Each client owns its
 * authentication, endpoint, manifest, and secret state, so multiple SDK
 * instances cannot overwrite each other's configuration.
 */
export function createWasmClient() {
    ensureInitialized();
    const factory = globalThis
        .createPrivatemodeClient;
    return new WasmClient(factory());
}
/** A state-isolated client handle exported by the Go Wasm module. */
export class WasmClient {
    exports;
    closed = false;
    constructor(exports) {
        this.exports = exports;
    }
    /**
     * Release the Go function references backing this client. The client
     * must not be used afterwards. Closing an already-closed client is a
     * no-op.
     */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.exports.close();
    }
    initialize(manifest, authType, authValue, apiBaseURL, enableLogging) {
        return this.exports.initialize(manifest, authType, authValue, apiBaseURL, enableLogging);
    }
    initializeOffline(authType, authValue, apiBaseURL, enableLogging) {
        this.exports.initializeOffline(authType, authValue, apiBaseURL, enableLogging);
    }
    setAuth(authType, authValue) {
        this.exports.setAuth(authType, authValue);
    }
    updateSecret() {
        return this.exports.updateSecret();
    }
    fetchManifest() {
        return this.exports.fetchManifest();
    }
    async chatCompletions(body, headers, signal) {
        return normalizeWasmResponse(await callWasm(() => this.exports.chatCompletions(body, headers, signal)));
    }
    async embeddings(body, headers, signal) {
        return normalizeWasmResponse(await callWasm(() => this.exports.embeddings(body, headers, signal)));
    }
    /**
     * Stream chat completions. If `onChunk` returns a Promise, the next chunk
     * is not read from the network until it settles, so a slow consumer
     * backpressures the response instead of buffering it in memory.
     */
    streamChatCompletions(body, onChunk, signal, onHeaders, headers) {
        return callWasm(() => this.exports.streamChatCompletions(body, onChunk, signal, onHeaders
            ? (responseHeaders) => onHeaders(new Headers(responseHeaders))
            : undefined, headers));
    }
    unstructured(files, optionsJSON) {
        return callWasm(() => this.exports.unstructured(files, optionsJSON));
    }
    async transcribeAudio(file, optionsJSON, headers, signal) {
        return normalizeWasmResponse(await callWasm(() => this.exports.transcribeAudio(file, optionsJSON, headers, signal)));
    }
    /**
     * Stream audio transcription events. If `onChunk` returns a Promise, the
     * next event is not read until it settles, so a slow consumer backpressures
     * the response instead of buffering it in memory.
     */
    streamTranscribeAudio(file, optionsJSON, onChunk, signal, onHeaders, headers) {
        return callWasm(() => this.exports.streamTranscribeAudio(file, optionsJSON, onChunk, signal, onHeaders
            ? (responseHeaders) => onHeaders(new Headers(responseHeaders))
            : undefined, headers));
    }
    async listModels(headers, signal) {
        return normalizeWasmResponse(await callWasm(() => this.exports.listModels(headers, signal)));
    }
    exportSecret() {
        return this.exports.exportSecret();
    }
    importSecret(id, base64Data, expiresAtUnix) {
        this.exports.importSecret(id, base64Data, expiresAtUnix);
    }
}
export function privatemodeVersion() {
    ensureInitialized();
    return globalThis.privatemodeVersion;
}
export function errManifestMismatch() {
    ensureInitialized();
    return globalThis.errManifestMismatch;
}
export function errNoSecretForID() {
    ensureInitialized();
    return globalThis.errNoSecretForID;
}
function ensureInitialized() {
    if (!initialized)
        throw new Error('WASM not initialized. Call initWasm() first.');
}
async function callWasm(operation) {
    try {
        return await operation();
    }
    catch (error) {
        throw normalizeWasmError(error);
    }
}
function normalizeWasmError(error) {
    if (!(error instanceof Error) || error.name !== 'PrivatemodeAPIError') {
        return error;
    }
    const raw = error;
    if (typeof raw.status !== 'number' || typeof raw.body !== 'string') {
        return error;
    }
    let body = raw.body;
    try {
        body = JSON.parse(raw.body);
    }
    catch {
        // Preserve non-JSON response bodies as text.
    }
    const headers = raw.headers && typeof raw.headers === 'object'
        ? new Headers(raw.headers)
        : undefined;
    return new PrivatemodeAPIError(error.message, raw.status, body, headers, {
        cause: error,
    });
}
function normalizeWasmResponse(value) {
    if (!value || typeof value !== 'object') {
        throw new TypeError('WASM API response must be an object.');
    }
    const raw = value;
    if (typeof raw.body !== 'string') {
        throw new TypeError('WASM API response body must be a string.');
    }
    if (!raw.headers || typeof raw.headers !== 'object') {
        throw new TypeError('WASM API response headers must be an object.');
    }
    return {
        body: raw.body,
        headers: new Headers(raw.headers),
    };
}
//# sourceMappingURL=wasm.js.map