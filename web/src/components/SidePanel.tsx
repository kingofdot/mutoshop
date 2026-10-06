import { History, Layers, Palette, Scissors } from "lucide-react";
import { useStore, type Panel } from "../store";
import { adjustIsIdentity } from "../types";
import { AdjustPanel } from "./panels/AdjustPanel";
import { BackgroundPanel } from "./panels/BackgroundPanel";
import { CutoutPanel } from "./panels/CutoutPanel";
import { HistoryPanel } from "./panels/HistoryPanel";

export function SidePanel() {
  const panel = useStore((s) => s.panel);
  const set = useStore((s) => s.set);
  const hasMask = useStore((s) => !!s.doc.cutout);
  const adjusted = useStore((s) => {
    const a = s.doc.adjust, f = s.doc.effects;
    return !adjustIsIdentity(a.global) || !adjustIsIdentity(a.subject) || !adjustIsIdentity(a.background) ||
      !!(f.clarity || f.sharpen || f.vignette || f.grain);
  });
  const bgChanged = useStore((s) => !!s.doc.cutout && (s.doc.bg.mode !== "original" || s.doc.shadow.enabled));

  const tabs: { id: Panel; label: string; icon: typeof Scissors; dot?: boolean }[] = [
    { id: "cutout", label: "누끼", icon: Scissors, dot: hasMask },
    { id: "adjust", label: "색감", icon: Palette, dot: adjusted },
    { id: "background", label: "배경", icon: Layers, dot: bgChanged },
    { id: "history", label: "기록", icon: History },
  ];

  return (
    <div className="sidepanel">
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`tab${panel === t.id ? " on" : ""}`} onClick={() => set({ panel: t.id })}>
            <t.icon size={18} />
            {t.label}
            {t.dot && <i className="tab-dot" />}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {panel === "cutout" && <CutoutPanel />}
        {panel === "adjust" && <AdjustPanel />}
        {panel === "background" && <BackgroundPanel />}
        {panel === "history" && <HistoryPanel />}
      </div>
    </div>
  );
}
