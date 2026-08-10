/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Doomalay palette — warm dark, not pure black.
        bg: '#0a0a0b',
        surface: '#131316',
        'surface-2': '#1c1c21',
        border: '#2a2a32',
        text: '#e4e4e7',
        muted: '#71717a',
        accent: '#a78bfa', // soft violet
        'accent-hover': '#c4b5fd',
        success: '#34d399',
        warning: '#fbbf24',
        danger: '#f87171',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
