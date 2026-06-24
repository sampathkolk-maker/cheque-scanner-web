import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  // pdfjs-dist ships a worker as an .mjs; let Vite optimize it for dev.
  optimizeDeps: { include: ['pdfjs-dist'] },
  worker: { format: 'es' }
});
