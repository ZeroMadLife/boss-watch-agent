import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const extensionRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: extensionRoot,
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL("../dist/extension", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: fileURLToPath(new URL("./sidepanel.html", import.meta.url)),
        "service-worker": fileURLToPath(new URL("./src/service-worker.ts", import.meta.url)),
        "content-script": fileURLToPath(new URL("./src/content-script.ts", import.meta.url)),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
