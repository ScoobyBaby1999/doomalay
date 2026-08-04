// Type definitions for the Doomalay PWA.
// Matches the wire format the Go engine emits (see lib/engine/internal/store/events.go).

export interface ChatSession {
  ID: string;
  Title: string;
  Model: string;
  Provider: string;
  Effort: string;
  Mode: string;
  WebSearch: boolean;
  DeepResearch: boolean;
  WebTemplate: string;
  DeepTemplate: string;
  DeepMode: string;
  JudgeCount: number;
  JudgeTemplate: string;
  SlidingWindow: number;
  MaxContext: number;
  ToolAllowlist: string;
  HooksConfig: string;
  Routing: string;
  WorkspaceID: string;
  ManuallyRenamed: boolean;
  CreatedAt: number;
  UpdatedAt: number;
}

export interface ChatEvent {
  i: number;          // event id (auto-increment)
  ts: number;         // timestamp
  seq: number;        // per-session sequence
  type: EventType;
  session_id: string;
  text?: string;
  name?: string;       // tool_use: tool name
  summary?: string;    // tool_use: args summary
  tool_use_id?: string;
  is_error?: boolean;
  state?: string;      // status: idle|running|error
  usage?: Usage | null;
  title?: string;
  error?: string;
  message?: string;
}

export type EventType =
  | 'user'
  | 'thinking'
  | 'assistant_delta'
  | 'assistant_complete'
  | 'tool_use'
  | 'tool_result'
  | 'status'
  | 'title'
  | 'error'
  | 'queued';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
}

export interface Engine {
  id: string;
  name: string;
  url: string;
  token: string;
  type: 'local' | 'lan' | 'mesh' | 'hf-demo' | 'cloud-llm' | 'cloud';
  status: 'online' | 'offline' | 'waking';
  lastSeen: number;
  capabilities: EngineCapabilities;
}

export interface EngineCapabilities {
  canChat: boolean;
  canBuild: boolean;
  canShell: boolean;
  hasGPU: boolean;
  hasKVM: boolean;
  type: string;
  version: string;
  brainAlive: boolean;
  note?: string;
}

export interface ProviderConfig {
  env_var: string;
  base_url: string;
  litellm_prefix: string;
  label: string;
  description: string;
  signup_url: string;
  free_tier: boolean;
  color: string;
  extra_env_var?: string;
}

export interface ProviderKeyInfo {
  env_var: string;
  provider: string;
  has_key: boolean;
  has_extra: boolean;
}

export interface SyncStatus {
  provider: string;
  has_key: boolean;
  model_count: number;
  error?: string;
}

export interface ModelInfo {
  id: string;
  provider: string;
  label: string;
}

export interface ModelsResponse {
  providers: Record<string, ProviderConfig>;
  models: ModelInfo[];
  syncStatus: SyncStatus[];
  totalModels: number;
  error?: string;
}

// A chat message is the PWA's rendered view of one or more events.
// Multiple events (e.g. assistant_delta chunks) merge into one message.
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'thinking' | 'tool' | 'system';
  content: string;
  toolName?: string;
  toolSummary?: string;
  toolUseId?: string;
  isError?: boolean;
  isStreaming?: boolean;
  model?: string;
  cost?: number;
  timestamp: number;
}
