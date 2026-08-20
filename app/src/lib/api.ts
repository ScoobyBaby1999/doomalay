// Engine HTTP + WebSocket client.
// Talks to whichever engine is active in engineStore. All URLs are relative
// ("/api/...") so the same code works in dev (Vite proxy → localhost:8080)
// and in production (PWA served from the engine itself → same origin).

import type {
  ChatEvent,
  ChatSession,
  EngineCapabilities,
  ModelsResponse,
  ProviderKeyInfo,
} from '../types';

export interface EngineClient {
  baseUrl: string;
  token: string;

  // Health + capabilities.
  health(): Promise<{ status: string; brain: boolean; mode: string; version: string }>;
  capabilities(): Promise<EngineCapabilities>;

  // Models + keys.
  models(refresh?: boolean): Promise<ModelsResponse>;
  listKeys(): Promise<Record<string, ProviderKeyInfo>>;
  setKey(envVar: string, provider: string, key: string, extra?: string): Promise<void>;
  deleteKey(envVar: string): Promise<void>;

  // Sessions.
  listSessions(): Promise<ChatSession[]>;
  createSession(opts: Partial<ChatSession>): Promise<ChatSession>;
  getSession(id: string): Promise<ChatSession | null>;
  updateSession(id: string, patch: Record<string, unknown>): Promise<ChatSession>;
  deleteSession(id: string): Promise<void>;
  getEvents(id: string, since?: number): Promise<ChatEvent[]>;

  // Chat WebSocket.
  // Returns the raw WebSocket. The caller (useChat hook) manages the lifecycle.
  chatWS(sessionId: string): WebSocket;
}

export function makeClient(baseUrl: string, token: string): EngineClient {
  const base = baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const res = await fetch(`${base}${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`${res.status}: ${text}`);
    }
    return res.json();
  }

  return {
    baseUrl: base,
    token,

    async health() {
      return req('/api/health');
    },

    async capabilities() {
      return req('/api/capabilities');
    },

    async models(refresh = false) {
      const q = refresh ? '?refresh=1' : '';
      return req(`/api/models${q}`);
    },

    async listKeys() {
      return req('/api/keys');
    },

    async setKey(envVar, provider, key, extra) {
      await req('/api/keys', {
        method: 'POST',
        body: JSON.stringify({ env_var: envVar, provider, key, extra }),
      });
    },

    async deleteKey(envVar) {
      await req(`/api/keys/${encodeURIComponent(envVar)}`, { method: 'DELETE' });
    },

    async listSessions() {
      const data = await req<{ sessions: ChatSession[] }>('/api/sessions');
      return data.sessions || [];
    },

    async createSession(opts) {
      return req('/api/sessions', {
        method: 'POST',
        body: JSON.stringify(opts),
      });
    },

    async getSession(id) {
      try {
        return await req(`/api/sessions/${id}`);
      } catch {
        return null;
      }
    },

    async updateSession(id, patch) {
      return req(`/api/sessions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    },

    async deleteSession(id) {
      await req(`/api/sessions/${id}`, { method: 'DELETE' });
    },

    async getEvents(id, since = 0) {
      const data = await req<{ events: ChatEvent[] }>(`/api/sessions/${id}/events?since=${since}`);
      return data.events || [];
    },

    chatWS(sessionId) {
      const wsBase = base.replace(/^http/, 'ws');
      let url = `${wsBase}/api/chat?session_id=${encodeURIComponent(sessionId)}`;
      // Browsers don't support custom headers on WebSocket, so we pass the
      // token as a query param. This is safe over WSS (TLS) and over ws://
      // localhost (no network transit). The engine accepts ?token= as a
      // fallback when the Authorization header isn't present.
      if (token) {
        url += `&token=${encodeURIComponent(token)}`;
      }
      return new WebSocket(url);
    },
  };
}
