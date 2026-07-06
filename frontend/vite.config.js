import { defineConfig } from "vite";
import { resolve } from "path";

// Vite config for the Home Decor static frontend.
// - Entries: index.html (home/admin SPA) + each standalone theme page
// - Env vars prefixed VITE_ are exposed to the client (see .env.example)
// - Output: dist/ (Vercel picks this up automatically)
export default defineConfig({
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        birthday: resolve(__dirname, "src/themes/birthday.html"),
        anniversary: resolve(__dirname, "src/themes/anniversary.html"),
        babyshower: resolve(__dirname, "src/themes/babyshower.html"),
        engagement: resolve(__dirname, "src/themes/engagement.html"),
        festival: resolve(__dirname, "src/themes/festival.html"),
        housewarming: resolve(__dirname, "src/themes/housewarming.html"),
      },
    },
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