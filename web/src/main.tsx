import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./styles.css";
import App from "./App";
import { getRenderer } from "./actions";
import { resources } from "./resources";
import { useStore } from "./store";

// 문제 추적용: 주소 뒤에 ?debug 를 붙여 열면 콘솔에서 내부 상태를 볼 수 있다
if (location.search.includes("debug")) {
  (window as unknown as Record<string, unknown>).__ms = { useStore, getRenderer, resources };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
