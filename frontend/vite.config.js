/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    // By default, Vite doesn't include shims for NodeJS/
    // necessary for segment analytics lib to work
    global: {},
  },
  build: {
    // vendor-syntax (react-syntax-highlighter) and vendor-charts (recharts) are
    // ~500-780KB RAW but only ~145-240KB gzipped — well under the ≥500KB *gzipped*
    // budget (plan §16) — and are lazy-loaded only on the routes that need them
    // (chat / Insights). Raise the raw-size warning above them so the build stays
    // quiet; a real reduction (react-syntax-highlighter light build w/ registered
    // languages) is a possible follow-up.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // Split the heavy, route-specific vendors into their own cacheable
        // chunks. The student chat (react-pdf + markdown + syntax highlighter +
        // katex) and instructor Insights (recharts) were producing single 1MB+
        // bundles; isolating these libs breaks them up, clears the >500KB
        // warning, and lets them cache independently of app code. Everything
        // else stays in Vite's default chunking.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/react-pdf|pdfjs-dist/.test(id)) return 'vendor-pdf'
          if (/react-syntax-highlighter|refractor|lowlight|highlight\.js/.test(id)) return 'vendor-syntax'
          if (
            /react-markdown|remark|rehype|micromark|mdast|hast-|hastscript|unified|unist|vfile|property-information|character-entities|decode-named-character|trim-lines|mdurl/.test(
              id
            )
          )
            return 'vendor-markdown'
          if (id.includes('katex')) return 'vendor-katex'
          if (/recharts|d3-|internmap|victory-vendor/.test(id)) return 'vendor-charts'
          if (/aws-amplify|@aws-amplify|amazon-cognito-identity-js|@smithy|@aws-sdk|@aws-crypto/.test(id))
            return 'vendor-amplify'
        },
      },
    },
  },
  // Vitest config — read by `vitest` at test time; ignored by `vite build`/`vite dev`.
  // Playwright E2E specs live in ./e2e and are excluded from the Vitest run.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
    css: true,
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    exclude: ['node_modules', 'dist', 'e2e'],
  },
})
