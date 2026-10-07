import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs separately (npm run dev in tvspy-backend, PORT=8080) and is proxied, so the
// browser sees one origin, as in production.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.TVSPY_API ?? 'http://127.0.0.1:8080' } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
