import { build } from "vite";

// Copies site-packs/ into extension/shell/pack.js so Chrome can import it.
await build({
  configFile: false,
  logLevel: "warn",
  esbuild: { keepNames: false },
  build: {
    minify: false,
    emptyOutDir: false,
    lib: {
      entry: "site-packs/index.ts",
      formats: ["es"],
      fileName: () => "pack.js",
    },
    outDir: "extension/shell",
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        banner: "/* generated from site-packs/ — npm run build:extension */\n",
      },
    },
  },
});
