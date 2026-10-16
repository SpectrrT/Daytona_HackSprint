import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

// The arena backend (FastAPI). Override with ARENA_URL=http://127.0.0.1:8000 npm run dev
// if your machine resolves "localhost" to an address the backend is not bound to.
const ARENA_URL = process.env.ARENA_URL ?? "http://localhost:8000";

const proxy: Record<string, ProxyOptions> = {
  "/api": {
    target: ARENA_URL,
    changeOrigin: true,
    // SSE (/api/events) streams through this proxy. If the arena dies or reloads mid-stream,
    // http-proxy leaves the browser's response open forever; end it so EventSource notices
    // and reconnects (the server then re-sends the whole run).
    configure: (p) => {
      p.on("proxyRes", (proxyRes, _req, res) => {
        proxyRes.on("close", () => {
          if (!res.writableEnded) res.end();
        });
      });
    },
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, proxy },
});
