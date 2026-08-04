import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy /api to the Go engine during dev (avoids CORS + lets the PWA
    // use relative URLs in production when served from the engine itself).
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        ws: true, // proxy WebSocket /api/chat
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
