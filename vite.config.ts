import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  server: {
    // `pnpm run dev:api` serves the Worker (and so /api) on 8788.
    proxy: { '/api': { target: 'http://127.0.0.1:8788', changeOrigin: true } },
  },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
})
