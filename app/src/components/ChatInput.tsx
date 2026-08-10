// ChatInput — auto-growing textarea with send/stop. Enter to send,
// Shift+Enter for newline. Shows stop button when isBusy.

import { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';

export function ChatInput({
  onSend,
  onStop,
  isBusy,
  disabled,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  isBusy: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-grow.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  function handleSend() {
    const t = text.trim();
    if (!t || isBusy || disabled) return;
    onSend(t);
    setText('');
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="border-t border-border bg-surface p-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          placeholder={disabled ? 'Connect an engine to start chatting…' : 'Send a message…'}
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-text outline-none focus:border-accent disabled:opacity-50"
        />
        {isBusy ? (
          <motion.button
            initial={{ scale: 0.9 }}
            animate={{ scale: 1 }}
            onClick={onStop}
            className="rounded-xl bg-danger px-4 py-3 font-semibold text-white hover:bg-danger/90"
          >
            ■
          </motion.button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!text.trim() || disabled}
            className="rounded-xl bg-accent px-4 py-3 font-semibold text-white hover:bg-accent-hover disabled:opacity-30"
          >
            ➤
          </button>
        )}
      </div>
    </div>
  );
}
