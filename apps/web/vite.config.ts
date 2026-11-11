import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  preview: { host: '127.0.0.1' },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: process.env.WORKSMITH_API_URL ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
});
