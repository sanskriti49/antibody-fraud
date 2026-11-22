import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API runs on 127.0.0.1:3001 (npm run dev at the repository root).
const api = 'http://127.0.0.1:' + (process.env.API_PORT ?? '3001');
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': api, '/health': api } },
  build: { outDir: 'dist', emptyOutDir: true },
});
