// The name list for chat sessions. From the user.
export const CHAT_NAMES = [
  'Crippy', 'Scooby', 'Boon', 'Doobie', 'Sky', 'Faqous',
  'Lip', 'Trippy', 'Fourth Grade', 'Docks', 'Baby', 'Kenny',
] as const;

/** Pick a random unused name. Falls back to "<Name> 2" etc. if all taken. */
export function pickName(taken: Set<string>): string {
  const available = CHAT_NAMES.filter((n) => !taken.has(n));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  const base = CHAT_NAMES[Math.floor(Math.random() * CHAT_NAMES.length)];
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Hash a string to a hue (0-360) for stable per-session icon colors. */
export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

/** HSL color string from a hue. */
export function hueColor(hue: number, sat = 70, light = 60, alpha = 1): string {
  return `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
}

/** Format a token count compactly (e.g. 12345 → "12.3k"). */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Format a USD cost compactly (e.g. 0.0023 → "$0.0023"). */
export function fmtCost(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
