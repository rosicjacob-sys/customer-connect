import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` serves the app on :5173 and sends /api and /u to the API on :3000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${process.env.PORT || 3000}`,
      '/u': `http://localhost:${process.env.PORT || 3000}`,
    },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1000 },
});
