import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // platform-api's own default port is 3000, but so is platform-web's, and
      // on a machine where anything else already holds 3000 platform-api has to
      // move. Without this override the dev proxy still points at 3000 and every
      // request in live mode reaches whatever is there instead of the API.
      "/api": {
        target: process.env.PLATFORM_API_PROXY_TARGET ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  // @alterx/contracts is a workspace package built as CommonJS. Vite serves a
  // linked package as source and never converts it, so the browser loads the
  // raw CommonJS file and every named import from it fails, leaving a blank
  // page. Pre-bundling converts it to ES modules.
  optimizeDeps: {
    include: ["@alterx/contracts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
})
