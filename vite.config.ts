import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const runtime = mode === "hosted" ? "hosted" : "local";
  return {
    root: "app",
    plugins: [react()],
    define: {
      __LOCUS_RUNTIME__: JSON.stringify(runtime),
    },
    server: {
      port: 5173,
      strictPort: true,
      host: "127.0.0.1",
    },
    build: {
      outDir: runtime === "hosted" ? "../dist/hosted-app" : "../dist/app",
      emptyOutDir: true,
    },
  };
});
