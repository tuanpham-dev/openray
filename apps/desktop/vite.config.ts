import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // Tauri expects a fixed, predictable dev server port.
  clearScreen: false,
  server: {
    port: 15420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // Any `safari*` target string fails outright under Vite 8's default
    // Rolldown bundler ("Transforming destructuring to the configured
    // target environment is not supported yet") — es2020 is the closest
    // supported equivalent for the WebKit-based targets (macOS WKWebView,
    // Linux webkit2gtk) and covers everything this codebase's syntax
    // actually needs.
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'es2020',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})
