import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { config } from './server/config.ts';

export default defineConfig(({ mode }) => ({
  base: mode === 'pages' ? '/temporal4l/' : '/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${config.port}`, changeOrigin: true },
    },
  },
}));
