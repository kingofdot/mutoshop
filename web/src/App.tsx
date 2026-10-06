import { useCallback, useEffect } from "react";
import { applyCrop, cancelCrop, copyToClipboard, openFromPicker, openImage, refreshServer } from "./actions";
import { ExportDialog } from "./components/ExportDialog";
import { OptionsBar } from "./components/OptionsBar";
import { ConfirmDialog, DragOverlay, ShortcutsDialog, Toasts } from "./components/Overlays";
import { SidePanel } from "./components/SidePanel";
import { StatusBar } from "./components/StatusBar";
import { Toolbar } from "./components/Toolbar";
import { TopBar, cycleView } from "./components/TopBar";
import { Viewport, useKeys } from "./components/Viewport";
import { toolKey } from "./selectTools";
import { applySelection, clearSelection, invertSelection, selectAll } from "./selection";
import { hasUnsaved, useStore } from "./store";

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

function useShortcuts() {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const s = useStore.getState();
      if (s.exportOpen || s.shortcutsOpen) {
        if (e.key === "Escape") s.set({ exportOpen: false, shortcutsOpen: false });
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const img = !!s.image;
      const handled = () => e.preventDefault();

      // 다각형 올가미 / 펜: Enter(닫기·선택 영역으로), Backspace(마지막 점), Esc(취소)
      if (img && toolKey(e)) {
        handled();
        return;
      }

      if (mod) {
        if (img && k === "a") { handled(); selectAll(); return; }
        if (img && k === "d") { handled(); clearSelection(); return; }
        if (img && k === "i" && e.shiftKey) { handled(); invertSelection(); return; }
        if (img && k === "j") { handled(); applySelection("keep"); return; }
        if (k === "z") { handled(); e.shiftKey ? s.redo() : s.undo(); return; }
        if (k === "y") { handled(); s.redo(); return; }
        if (k === "o") { handled(); openFromPicker(); return; }
        if (k === "s" && img) { handled(); s.set({ exportOpen: true }); return; }
        if (k === "c" && e.shiftKey && img) { handled(); copyToClipboard(); return; }
        if (k === "0" && img) { handled(); s.fitView(); return; }
        if (k === "1" && img) { handled(); s.zoomAt(1); return; }
        if ((k === "=" || k === "+") && img) { handled(); s.zoomAt(s.view.zoom * 1.25); return; }
        if (k === "-" && img) { handled(); s.zoomAt(s.view.zoom / 1.25); return; }
        if (k === "i" && s.doc.cutout) {
          handled();
          s.change(s.doc.invert ? "마스크 반전 해제" : "마스크 반전", (d) => { d.invert = !d.invert; });
          return;
        }
        return;
      }

      if (e.key === " " && img) {
        handled();
        if (!e.repeat) useKeys.setState({ space: true });
        return;
      }
      if (e.key === "\\" && img) {
        handled();
        if (!s.compare) s.set({ compare: true });
        return;
      }
      if (e.key === "?" || e.key === "F1" || (e.code === "Slash" && e.shiftKey)) { handled(); s.set({ shortcutsOpen: true }); return; }
      if (s.tool === "crop") {
        if (e.key === "Enter") { handled(); applyCrop(); return; }
        if (e.key === "Escape") { handled(); cancelCrop(); return; }
      }
      if (!img) return;
      if (e.key === "Escape" && s.tool === "eyedropper") { s.setTool("hand"); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && s.sel.box) {
        handled();
        applySelection("delete");
        return;
      }
      switch (k) {
        case "h": s.setTool("hand"); break;
        case "m":
          if (e.shiftKey || s.tool === "marquee") s.set({ marqueeShape: s.marqueeShape === "rect" ? "ellipse" : "rect" });
          s.setTool("marquee");
          break;
        case "l":
          if (e.shiftKey || s.tool === "lasso") s.set({ lassoMode: s.lassoMode === "free" ? "poly" : "free" });
          s.setTool("lasso");
          break;
        case "w": s.setTool("wand"); break;
        case "p": s.setTool("pen"); break;
        case "z": s.setTool("zoom"); break;
        case "b": s.setBrush({ mode: "add" }); s.setTool("brush"); break;
        case "e": s.setBrush({ mode: "sub" }); s.setTool("brush"); break;
        case "x": s.setBrush({ mode: s.brush.mode === "add" ? "sub" : "add" }); break;
        case "c": s.setTool("crop"); break;
        case "i": s.setTool("eyedropper"); break;
        case "f": cycleView(); break;
        case "[":
        case "{":
          if (e.shiftKey) s.setBrush({ hardness: Math.max(0, s.brush.hardness - 10) });
          else s.setBrush({ size: Math.max(2, Math.round(s.brush.size / 1.18)) });
          break;
        case "]":
        case "}":
          if (e.shiftKey) s.setBrush({ hardness: Math.min(100, s.brush.hardness + 10) });
          else s.setBrush({ size: Math.min(2000, Math.round(s.brush.size * 1.18) + 1) });
          break;
        default:
          return;
      }
      handled();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") useKeys.setState({ space: false });
      if (e.key === "\\") useStore.getState().set({ compare: false });
    };
    const blur = () => {
      useKeys.setState({ space: false });
      useStore.getState().set({ compare: false });
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
}

export default function App() {
  useShortcuts();

  // 서버 상태 확인 (연결이 끊기면 주기적으로 재확인)
  useEffect(() => {
    let timer = 0;
    const tick = async () => {
      const info = await refreshServer();
      timer = window.setTimeout(tick, info.ok ? 30_000 : 4_000);
    };
    tick();
    return () => clearTimeout(timer);
  }, []);

  // 붙여넣기
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      const f = item?.getAsFile();
      if (f) {
        e.preventDefault();
        openImage(f, f.name && f.name !== "image.png" ? f.name : "붙여넣은 이미지.png");
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // 저장 안 한 채 닫기 경고
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (hasUnsaved()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, []);

  const onDropFile = useCallback((f: File) => openImage(f, f.name), []);

  return (
    <div className="app">
      <TopBar />
      <OptionsBar />
      <Toolbar />
      <Viewport />
      <SidePanel />
      <StatusBar />
      <ExportDialog />
      <ConfirmDialog />
      <ShortcutsDialog />
      <DragOverlay onFile={onDropFile} />
      <Toasts />
    </div>
  );
}
