import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 개발 중에는 Vite(5173)에서 화면을, Python 서버(8765)에서 API를 제공한다.
const stamp = new Date();
const pad = (n: number) => String(n).padStart(2, "0");

export default defineConfig({
  plugins: [react()],
  define: {
    // 상태 막대 오른쪽에 보이는 빌드 시각 — 화면이 최신인지 확인용
    __BUILD__: JSON.stringify(`${pad(stamp.getMonth() + 1)}.${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`),
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8765" },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
});
