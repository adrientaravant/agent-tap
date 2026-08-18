import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The viewer is served by server.mjs under /__wire/, and the build lands in
// viewer/dist so the server has no build step of its own.
export default defineConfig({
  base: "/__wire/",
  build: {
    outDir: path.resolve(__dirname, "../viewer/dist"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/__wire/api": "http://127.0.0.1:8317",
    },
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
