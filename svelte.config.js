import adapterNode from '@sveltejs/adapter-node';
import adapterStatic from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Web build -> Node server (the /api/extract route holds the key).
// Tauri build (TAURI=1) -> static SPA bundled into the desktop app; the key
// lives in the Rust backend instead, so the server route is simply omitted.
const tauri = !!process.env.TAURI;

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: tauri
      ? adapterStatic({ fallback: 'index.html', strict: false })
      : adapterNode()
  }
};

export default config;
