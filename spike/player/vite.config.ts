// THROWAWAY — Story 0.4 spike player. Not production code; delete after Epic 0.
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative base so `dist/` also works from any static host / sub-path.
  base: "./",
  // Cloudflare quick tunnels (README) arrive with a *.trycloudflare.com Host header.
  server: { port: 5173, allowedHosts: [".trycloudflare.com"] },
  preview: { port: 4173, allowedHosts: [".trycloudflare.com"] },
  worker: { format: "es" },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
