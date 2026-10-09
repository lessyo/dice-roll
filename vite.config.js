import { resolve } from "path"
import { defineConfig } from 'vite'
// vite.config.js

const root = resolve(__dirname, 'src')
const outDir = resolve(__dirname, 'dist')
const demoOutDir = resolve(__dirname, 'dist-demo')

// moves the bundled scripts into index.html so the demo is a single self-contained file
const inlineScripts = () => ({
  name: 'inline-scripts',
  enforce: 'post',
  generateBundle(options, bundle) {
    const html = Object.values(bundle).find(file => file.fileName.endsWith('.html'))
    if (!html) return
    for (const [name, chunk] of Object.entries(bundle)) {
      if (chunk.type !== 'chunk') continue
      const fileName = chunk.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const tag = new RegExp(`<script[^>]*src="[^"]*${fileName}"[^>]*></script>`)
      const code = chunk.code.replace(/<\/script/gi, '<\\/script')
      html.source = html.source.replace(tag, () => `<script type="module">\n${code}</script>`)
      delete bundle[name]
    }
  }
})

const libConfig = {
  root,
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.js'),
      name: 'dice-box-threejs',
      fileName: (format) => `dice-box-threejs.${format}.js`
    },
    outDir,
    emptyOutDir: true,
  }
}

// npm run build:demo -> dist-demo/index.html with all the code inside
const demoConfig = {
  root,
  base: './',
  plugins: [inlineScripts()],
  build: {
    outDir: demoOutDir,
    emptyOutDir: true,
    // the demo page uses top-level await
    target: 'esnext',
    modulePreload: { polyfill: false },
    assetsInlineLimit: 100000000,
    rollupOptions: {
      input: resolve(root, 'index.html'),
      output: { inlineDynamicImports: true }
    }
  }
}

export default defineConfig(({ mode }) => mode === 'demo' ? demoConfig : libConfig)
