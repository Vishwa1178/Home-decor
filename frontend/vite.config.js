import { defineConfig } from "vite";

// Vite config for the Home Decor static frontend.
// - Entry: index.html at project root
// - Env vars prefixed VITE_ are exposed to the client (see .env.example)
// - Output: dist/ (Vercel picks this up automatically)
export default defineConfig({
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    port: 4173,
    host: true,
  },
});
