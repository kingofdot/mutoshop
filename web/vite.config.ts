import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 개발 중에는 Vite(5173)에서 화면을, Python 서버(8765)에서 API를 제공한다.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8765" },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
});
