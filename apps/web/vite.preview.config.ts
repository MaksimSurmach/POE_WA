import { fileURLToPath } from 'node:url';
import config from './vite.config.js';

export default {
  ...config,
  base: './',
  build: {
    outDir: 'dist-preview',
    assetsInlineLimit: Infinity,
    rolldownOptions: {
      input: fileURLToPath(new URL('./preview.html', import.meta.url)),
      output: { codeSplitting: false },
    },
  },
};
