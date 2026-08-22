import { fileURLToPath } from "node:url"
import { foldkit } from "@foldkit/vite-plugin"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [foldkit()],
  resolve: {
    alias: [{ find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) }],
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./src/client/entry.ts", import.meta.url)),
      output: {
        entryFileNames: "thread-client.js",
        assetFileNames: "thread-client.[ext]",
      },
    },
  },
})
