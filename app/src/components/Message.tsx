// Message — renders one chat message bubble. Handles all roles:
// user, assistant, thinking, tool, system/error.
//
// Tool messages are paired by tool_use_id (the V0 fix) — tool_use and
// tool_result render as one card with the tool name + output.

import { memo, useState } from 'react';
import { motion } from 'framer-motion';
import { marked } from 'marked';
import type { ChatMessage } from '../types';

marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(text: string): string {
  try {
    return marked.parse(text) as string;
  } catch {
    return text;
  }
}

export const Message = memo(function Message({ msg }: { msg: ChatMessage }) {
  const [showThinking, setShowThinking] = useState(false);

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent px-4 py-2 text-white">
          <div className="whitespace-pre-wrap break-words text-sm">{msg.content}</div>
        </div>
      </div>
    );
  }

  if (msg.role === 'thinking') {
    return (
      <div className="flex justify-start">
        <button
          onClick={() => setShowThinking(!showThinking)}
          className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs text-muted hover:text-text"
        >
          <span className={msg.isStreaming ? 'animate-pulse' : ''}>💭</span>
          {msg.isStreaming ? 'thinking…' : (showThinking ? '▾ thought process' : '▸ thought process')}
        </button>
        {showThinking && !msg.isStreaming && (
          <div className="mt-1 w-full rounded-lg border border-border bg-surface-2 p-3 text-xs text-muted">
            <div className="whitespace-pre-wrap">{msg.content}</div>
          </div>
        )}
      </div>
    );
  }

  if (msg.role === 'tool') {
    return (
      <motion.div
        layout
        className="rounded-xl border border-border bg-surface-2 p-3"
      >
        <div className="mb-1 flex items-center gap-2 text-xs">
          <span className="font-mono text-accent">{msg.toolName || 'tool'}</span>
          {msg.toolSummary && <span className="text-muted">{msg.toolSummary}</span>}
          {msg.isError && <span className="text-danger">error</span>}
        </div>
        {msg.content && (
          <pre className="overflow-x-auto rounded-lg bg-bg p-2 text-xs text-muted">
            <code>{msg.content}</code>
          </pre>
        )}
      </motion.div>
    );
  }

  if (msg.role === 'system' || msg.isError) {
    return (
      <div className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
        {msg.content}
      </div>
    );
  }

  // assistant
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-2xl rounded-bl-md bg-surface-2 px-4 py-2">
        <div
          className="prose prose-invert prose-sm max-w-none text-text"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
        />
        {msg.isStreaming && (
          <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-accent align-middle" />
        )}
      </div>
    </div>
  );
});
