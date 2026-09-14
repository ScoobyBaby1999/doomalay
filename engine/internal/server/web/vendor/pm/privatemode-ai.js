import { createWasmClient, errManifestMismatch, errNoSecretForID, initWasm, } from './wasm.js';
/** @internal Low-level implementation used by the OpenAI transport. */
export class PrivatemodeCore {
    authProvider;
    apiBaseURL;
    isBrowser;
    _manifestBytes;
    wasmURL;
    browserWasmURL;
    enableWasmLogging;
    expectedWasmHash;
    onManifestUpdate;
    onSecretUpdate;
    verified = false;
    initialized = false;
    hasSecret = false;
    closed = false;
    wasmClient = null;
    constructor(options = {}) {
        this.isBrowser =
            typeof window !== 'undefined' &&
                typeof window.document !== 'undefined' &&
                typeof navigator !== 'undefined';
        if (this.isBrowser && !options.dangerouslyAllowBrowser) {
            throw new Error("It looks like you're running in a browser-like environment.\n\n" +
                'This is disabled by default, as it risks exposing your secret API credentials to attackers.\n' +
                'If you understand the risks and have appropriate mitigations in place,\n' +
                'you can set the `dangerouslyAllowBrowser` option to `true`.');
        }
        if (options.apiKey !== undefined && options.auth !== undefined) {
            throw new Error('Pass either `apiKey` or an `auth` provider to the PrivatemodeAI ' +
                'client, not both.');
        }
        const { apiKey } = options;
        const auth = options.auth ??
            (apiKey
                ? () => ({ type: 'apiKey', value: apiKey })
                : undefined);
        if (!auth) {
            throw new Error('No authentication configured. Pass an `apiKey` or an `auth` ' +
                'provider to the PrivatemodeAI client.');
        }
        this.authProvider = auth;
        this.apiBaseURL = options.apiBaseURL ?? 'https://api.privatemode.ai';
        this._manifestBytes = options.manifestBytes ?? null;
        this.wasmURL = options.wasmURL ?? defaultWasmURL();
        this.browserWasmURL =
            options.browserWasmURL ??
                options.wasmURL?.toString() ??
                './privatemode.wasm';
        this.enableWasmLogging = options.enableWasmLogging ?? true;
        this.expectedWasmHash = options.expectedWasmHash;
        this.onManifestUpdate = options.onManifestUpdate;
        this.onSecretUpdate = options.onSecretUpdate;
    }
    /**
     * Verify the Privatemode deployment by fetching and verifying the
     * attestation document of the coordinator, and initialize the
     * encryption secret. If the encryption secret has already been
     * initialized, the verification is still performed, keeping the
     * existing secret.
     *
     * @returns The verification result.
     * @throws If verification fails.
     */
    async verify() {
        await this.loadWasm();
        if (!this._manifestBytes) {
            this._manifestBytes = new TextEncoder().encode(await this.wasm.fetchManifest());
        }
        this.initialized = true;
        await this.initializeWithManifestRetry(await this.resolveCredential());
        return {
            manifest: JSON.parse(new TextDecoder().decode(this._manifestBytes)),
        };
    }
    /**
     * Initialize the client offline without performing attestation.
     * This loads the Wasm module and sets up the API key and base URL,
     * but skips remote attestation. Use this together with
     * {@link importSecret} to restore a previously cached secret.
     *
     * @param manifestBytes - Manifest bytes to set on the
     * client (e.g. from a previous session's cache).
     */
    async initializeOffline(manifestBytes) {
        await this.loadWasm();
        const cred = await this.resolveCredential();
        this.wasm.initializeOffline(cred.type, cred.value, this.apiBaseURL, this.enableWasmLogging);
        this._manifestBytes = manifestBytes;
        this.initialized = true;
    }
    /**
     * Update the encryption secret. {@link verify} must have been called
     * before calling this. Most callers will want to call this in some
     * sort of loop to keep the secret up-to-date.
     *
     * @throws If the secret update fails or verify hasn't been called.
     */
    async refreshSecret() {
        if (!this.initialized) {
            // Security-wise, this is not a safeguard against users who
            // *really* want to shoot themselves in the foot, but it still
            // provides some protection against using this function before
            // properly initializing the client.
            throw new Error('verify() or initializeOffline() must be called before refreshSecret().');
        }
        const cred = await this.resolveCredential();
        this.wasm.setAuth(cred.type, cred.value);
        if (!this.verified) {
            await this.initializeWithManifestRetry(cred);
        }
        await this.wasm.updateSecret();
        this.hasSecret = true;
        if (this.onSecretUpdate) {
            this.onSecretUpdate(this.exportSecret());
        }
    }
    /**
     * Send a chat completions request. The request body is encrypted
     * and the response is decrypted transparently.
     *
     * {@link verify} and {@link refreshSecret} must have been called
     * first.
     *
     * @param body - The JSON request body (OpenAI chat completions
     * format).
     * @param options - Optional request headers and abort signal.
     * @returns The parsed response body and response headers.
     * @throws If encryption, sending, or decryption fails.
     */
    async chatCompletions(body, options) {
        await this.applyCredential();
        return this.retryWithSecretRefresh(async () => {
            const resp = await this.wasm.chatCompletions(JSON.stringify(body), headersToRecord(options?.headers), options?.signal);
            return { body: JSON.parse(resp.body), headers: resp.headers };
        });
    }
    /**
     * Send an embeddings request. The request body is encrypted and the
     * response is decrypted transparently.
     *
     * {@link verify} and {@link refreshSecret} must have been called first.
     *
     * @param body - The JSON request body (OpenAI embeddings format).
     * @param options - Optional request headers and abort signal.
     * @returns The parsed response body and response headers.
     * @throws If encryption, sending, or decryption fails.
     */
    async embeddings(body, options) {
        await this.applyCredential();
        return this.retryWithSecretRefresh(async () => {
            const resp = await this.wasm.embeddings(JSON.stringify(body), headersToRecord(options?.headers), options?.signal);
            return { body: JSON.parse(resp.body), headers: resp.headers };
        });
    }
    /**
     * Stream chat completions. The request body is encrypted and
     * response chunks are decrypted transparently.
     *
     * {@link verify} and {@link refreshSecret} must have been called
     * first.
     *
     * @param body - The JSON request body (OpenAI chat completions
     * format). Should include `stream: true`.
     * @param options - Optional parameters.
     * @param options.signal - An AbortSignal to cancel the stream.
     * @param options.headers - Additional request headers.
     * @param options.onResponseHeaders - Called with the response headers.
     * @returns An async generator yielding decrypted response chunks.
     * @throws If encryption, streaming, or decryption fails.
     */
    async *streamChatCompletions(body, options) {
        await this.applyCredential();
        const generator = await this.retryWithSecretRefresh(async () => this.initiateStream((onChunk) => this.wasm.streamChatCompletions(JSON.stringify(body), onChunk, options?.signal, options?.onResponseHeaders, headersToRecord(options?.headers)), options));
        yield* generator;
    }
    /**
     * Initiate a streaming request and return an async generator.
     * Waits for the stream to successfully start (first chunk, completion,
     * or error) before returning. This allows retryWithSecretRefresh to
     * catch "no secret for ID" errors that occur before streaming starts.
     *
     * The chunk callback resolves only when the consumer advances the
     * iterator, so the bridge holds at most one undelivered chunk and a slow
     * consumer backpressures the response instead of buffering it in memory.
     */
    async initiateStream(start, options) {
        let pending = null;
        let waiter = null;
        let done = false;
        let streamError = null;
        let closed = false;
        const notify = () => {
            waiter?.();
            waiter = null;
        };
        const takePending = () => {
            const chunk = pending;
            pending = null;
            return chunk;
        };
        const rejectPending = (error) => {
            pending?.reject(error);
            pending = null;
        };
        const onChunk = (chunk) => new Promise((acknowledge, reject) => {
            if (closed) {
                reject(new Error('Stream consumer closed.'));
                return;
            }
            if (options?.signal?.aborted) {
                reject(options.signal.reason ??
                    new DOMException('The operation was aborted.', 'AbortError'));
                return;
            }
            if (pending) {
                reject(new Error('Stream backpressure invariant violated.'));
                return;
            }
            const onAbort = () => {
                pending = null;
                reject(options?.signal?.reason ??
                    new DOMException('The operation was aborted.', 'AbortError'));
                notify();
            };
            const cleanup = () => options?.signal?.removeEventListener('abort', onAbort);
            options?.signal?.addEventListener('abort', onAbort, { once: true });
            pending = {
                value: chunk,
                acknowledge: () => {
                    cleanup();
                    acknowledge();
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                },
            };
            notify();
        });
        const streamPromise = start(onChunk);
        streamPromise
            .then(() => {
            done = true;
            notify();
        })
            .catch((e) => {
            streamError = e;
            notify();
        });
        // Wait for first chunk, completion, or error to verify the stream started successfully.
        // "no secret for ID" errors occur before streaming starts, so they'll be caught here.
        while (pending === null && streamError === null && !done) {
            if (options?.signal?.aborted) {
                throw new DOMException('The operation was aborted.', 'AbortError');
            }
            await new Promise((r) => {
                waiter = r;
            });
        }
        // If there's an error at this point, throw it so retryWithSecretRefresh can catch it
        if (streamError !== null) {
            throw streamError;
        }
        // Stream has started successfully. A chunk is acknowledged only when the
        // consumer advances the iterator, keeping the bridge bounded to one chunk.
        return (async function* () {
            let inFlight = null;
            try {
                while (true) {
                    if (options?.signal?.aborted) {
                        throw new DOMException('The operation was aborted.', 'AbortError');
                    }
                    const next = takePending();
                    if (next) {
                        inFlight = next;
                        yield JSON.parse(inFlight.value);
                        inFlight.acknowledge();
                        inFlight = null;
                    }
                    else if (streamError !== null) {
                        throw streamError;
                    }
                    else if (done) {
                        return;
                    }
                    else {
                        await new Promise((r) => {
                            waiter = r;
                        });
                    }
                }
            }
            finally {
                closed = true;
                const error = new Error('Stream consumer closed.');
                if (inFlight)
                    inFlight.reject(error);
                rejectPending(error);
            }
        })();
    }
    /**
     * Send a request to the unstructured partition endpoint. The request
     * is encrypted and the response is decrypted transparently.
     *
     * {@link verify} and {@link refreshSecret} must have been called
     * first.
     *
     * @param files - One or more files to process.
     * @param options - Optional partitioning parameters.
     * @returns The decrypted response body as a parsed object.
     * @throws If encryption, sending, or decryption fails or the
     * response is invalid JSON.
     */
    async unstructured(files, options) {
        await this.applyCredential();
        return this.retryWithSecretRefresh(async () => {
            const wasmFiles = files.map((f) => ({
                name: f.name,
                content: f.content instanceof Uint8Array
                    ? f.content
                    : new Uint8Array(f.content),
                ...(f.contentType ? { contentType: f.contentType } : {}),
            }));
            const optsJSON = options ? JSON.stringify(options) : '';
            const resp = await this.wasm.unstructured(wasmFiles, optsJSON);
            return JSON.parse(resp);
        });
    }
    /**
     * Send an audio file to the OpenAI-compatible transcription endpoint.
     * The request is encrypted and the response is decrypted transparently.
     *
     * {@link verify} and {@link refreshSecret} must have been called
     * first.
     *
     * @param file - The audio file to transcribe.
     * @param options - Transcription options, including the STT model.
     * @param requestOptions - Optional request headers and abort signal.
     * @returns The parsed response body and response headers.
     * @throws If encryption, sending, or decryption fails or the
     * response is invalid JSON.
     */
    async transcribeAudio(file, options, requestOptions) {
        await this.applyCredential();
        return this.retryWithSecretRefresh(async () => {
            const wasmFile = this.toWasmAudioFile(file);
            const resp = await this.wasm.transcribeAudio(wasmFile, JSON.stringify(options), headersToRecord(requestOptions?.headers), requestOptions?.signal);
            return { body: JSON.parse(resp.body), headers: resp.headers };
        });
    }
    /**
     * Stream an audio transcription. The request is encrypted and each response
     * event is decrypted transparently.
     *
     * {@link verify} and {@link refreshSecret} must have been called first.
     *
     * @param file - The audio file to transcribe.
     * @param options - Transcription options, including the STT model.
     * @param streamOptions - Optional request headers, response-header callback,
     * and abort signal.
     * @returns An async generator yielding parsed transcription events.
     */
    async *streamTranscribeAudio(file, options, streamOptions) {
        await this.applyCredential();
        const wasmFile = this.toWasmAudioFile(file);
        const generator = await this.retryWithSecretRefresh(async () => this.initiateStream((onChunk) => this.wasm.streamTranscribeAudio(wasmFile, JSON.stringify(options), onChunk, streamOptions?.signal, streamOptions?.onResponseHeaders, headersToRecord(streamOptions?.headers)), streamOptions));
        yield* generator;
    }
    toWasmAudioFile(file) {
        return {
            name: file.name,
            content: file.content instanceof Uint8Array
                ? file.content
                : new Uint8Array(file.content),
            ...(file.contentType ? { contentType: file.contentType } : {}),
        };
    }
    /**
     * List available models. The response is not encrypted and only
     * requires authentication.
     *
     * {@link verify} must have been called first.
     *
     * @param options - Optional request headers and abort signal.
     * @returns The parsed response body and response headers from /v1/models.
     * @throws If the request fails.
     */
    async listModels(options) {
        await this.applyCredential();
        const resp = await this.wasm.listModels(headersToRecord(options?.headers), options?.signal);
        return { body: JSON.parse(resp.body), headers: resp.headers };
    }
    /**
     * Export the current encryption secret so it can be cached and
     * restored later with {@link importSecret}, avoiding a full HPKE
     * handshake on reload.
     *
     * {@link verify} and {@link refreshSecret} must have been called
     * first.
     *
     * @returns The exported secret.
     * @throws If no secret has been established yet.
     */
    exportSecret() {
        return JSON.parse(this.wasm.exportSecret());
    }
    /**
     * Import a previously exported secret, restoring the encryption
     * state without performing a new HPKE handshake.
     *
     * {@link verify} must have been called first.
     *
     * @param secret - A secret previously obtained from
     * {@link exportSecret}.
     * @throws If the import fails.
     */
    importSecret(secret) {
        this.wasm.importSecret(secret.id, secret.data, secret.expiresAtUnix);
        this.hasSecret = true;
    }
    /**
     * Release the Wasm resources backing this client. Any further use of the
     * client throws. Closing an already-closed client is a no-op.
     */
    close() {
        this.closed = true;
        this.wasmClient?.close();
        this.wasmClient = null;
        this.verified = false;
        this.initialized = false;
        this.hasSecret = false;
    }
    /** @throws If {@link close} has been called on this client. */
    ensureNotClosed() {
        if (this.closed) {
            throw new Error('Client is closed and can no longer be used.');
        }
    }
    /** @internal Whether inference can proceed without automatic setup. */
    get readyForInference() {
        return this.initialized && this.hasSecret;
    }
    // TODO(msanft): Expose manifest fetching on the client?
    /**
     * The current manifest in use. If no manifest has been set or
     * fetched yet, this returns null.
     * To save/restore the manifest use {@link manifestBytes} instead of this function,
     * as JSON encoding/decoding may alter the bytes and cause verification to fail.
     */
    get manifest() {
        if (!this._manifestBytes)
            return null;
        return JSON.parse(new TextDecoder().decode(this._manifestBytes));
    }
    /**
     * The current manifest in use as raw bytes.
     * Use this for caching the manifest or initializing the client offline with {@link initializeOffline}.
     */
    get manifestBytes() {
        return this._manifestBytes;
    }
    /**
     * Ensure the WASM module is loaded and this instance's client is created.
     * The module itself is a per-realm singleton: only the first loader's
     * wasmURL takes effect, while client state remains isolated per instance.
     * A later expectedWasmHash is checked against the hash of the first load.
     */
    async loadWasm() {
        this.ensureNotClosed();
        if (this.isBrowser) {
            await initWasm(fetch(this.browserWasmURL), this.expectedWasmHash);
            this.wasmClient ??= createWasmClient();
            return;
        }
        const { readFile } = await import('node:fs/promises');
        const wasmBuffer = await readFile(this.wasmURL);
        await initWasm(wasmBuffer, this.expectedWasmHash);
        this.wasmClient ??= createWasmClient();
    }
    /** The state-isolated Wasm client backing this SDK instance. */
    get wasm() {
        this.ensureNotClosed();
        if (!this.wasmClient) {
            throw new Error('Client not initialized. Call verify() or initializeOffline() first.');
        }
        return this.wasmClient;
    }
    /**
     * Resolve the current authentication credential via the configured provider.
     */
    async resolveCredential() {
        return this.authProvider();
    }
    /**
     * Resolve the current credential and push it into the WASM client so the next
     * request is authenticated with it. Used before network operations to keep
     * short-lived credentials (e.g. JWTs) fresh.
     */
    async applyCredential() {
        const cred = await this.resolveCredential();
        this.wasm.setAuth(cred.type, cred.value);
    }
    /**
     * Initialize with automatic manifest retry if the active manifest doesn't match.
     * If initialization fails with a manifest mismatch error, fetches a new manifest
     * and retries once.
     *
     * @throws If initialization fails for reasons other than manifest mismatch, or if retry fails.
     */
    async initializeWithManifestRetry(cred) {
        const manifestBase64 = btoa(String.fromCharCode(...this._manifestBytes));
        try {
            await this.wasm.initialize(manifestBase64, cred.type, cred.value, this.apiBaseURL, this.enableWasmLogging);
        }
        catch (error) {
            if (error instanceof Error &&
                error.message.includes(errManifestMismatch())) {
                // Fetch a new manifest and retry
                console.log('Manifest mismatch, trying again with new manifest...');
                const manifestBytes = new TextEncoder().encode(await this.wasm.fetchManifest());
                const newManifestBase64 = btoa(String.fromCharCode(...manifestBytes));
                await this.wasm.initialize(newManifestBase64, cred.type, cred.value, this.apiBaseURL, this.enableWasmLogging);
                this._manifestBytes = manifestBytes;
                if (this.onManifestUpdate) {
                    this.onManifestUpdate(manifestBytes);
                }
            }
            else {
                throw error;
            }
        }
        this.verified = true;
    }
    /**
     * Retry an operation with automatic secret refresh if a "no secret for ID" error occurs.
     * This handles expired secrets transparently without requiring manual retry logic in consumers.
     */
    async retryWithSecretRefresh(operation) {
        let retryCount = 0;
        const MAX_RETRIES = 1;
        while (retryCount <= MAX_RETRIES) {
            try {
                return await operation();
            }
            catch (error) {
                // Check if this is a "no secret for ID" error and we haven't retried yet
                if (error instanceof Error &&
                    error.message.includes(errNoSecretForID()) &&
                    retryCount < MAX_RETRIES) {
                    console.log('Secret expired, refreshing and retrying...');
                    try {
                        await this.refreshSecret();
                        retryCount++;
                        continue; // Retry the operation
                    }
                    catch (refreshError) {
                        console.error('Failed to refresh secret:', refreshError);
                        throw refreshError; // Throw refresh error
                    }
                }
                else {
                    throw error; // Re-throw if it's not a secret error or max retries reached
                }
            }
        }
        throw new Error('Retry loop exhausted'); // Should never reach here
    }
}
function headersToRecord(headers) {
    if (!headers)
        return undefined;
    return Object.fromEntries(new Headers(headers));
}
/** The location of the Wasm binary shipped with the SDK (Node.js loading). */
function defaultWasmURL() {
    // Vitest executes the TypeScript source directly. Published builds execute
    // from dist, where the Wasm binary is copied beside this module.
    // The path is kept out of the `new URL` literal: bundlers statically
    // analyze `new URL('...', import.meta.url)` and would otherwise emit the
    // multi-megabyte binary as an asset of every browser build. Browsers load
    // the Wasm from `browserWasmURL` instead.
    const wasmPath = import.meta.url.endsWith('/src/privatemode-ai.ts')
        ? '../../wasm/privatemode.wasm'
        : './privatemode.wasm';
    return new URL(wasmPath, import.meta.url);
}
//# sourceMappingURL=privatemode-ai.js.map