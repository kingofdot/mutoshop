import { useStore } from "../../store";
import { defaultOutlineWidth, type Outline } from "../../types";
import { Section } from "../controls";
import { OutlineControls } from "../OutlineControls";

/** 외곽선(포토샵 레이어 스타일의 '획'). 마스크 윤곽을 따라 그린다. 그라디언트는 바깥 → 안쪽으로.
 *  화면 부품은 폴더 작업과 같이 쓰는 OutlineControls */
export function OutlineSection() {
  const ol = useStore((s) => s.doc.outline);
  const image = useStore((s) => s.image);
  const viewMode = useStore((s) => s.viewMode);
  const setStore = useStore((s) => s.set);
  const long = image ? Math.max(image.w, image.h) : 2000;

  // 외곽선은 최종 결과('합성' 보기)에만 그려진다 → 만지면 합성 보기로 전환
  const set = (p: Partial<Outline>) => {
    const st = useStore.getState();
    if (st.viewMode !== "normal") st.set({ viewMode: "normal" });
    st.setDoc((d) => { Object.assign(d.outline, p); });
  };
  const commit = (label: string) => useStore.getState().commit(label);

  return (
    <Section id="cut.outline" title="외곽선" modified={ol.enabled}
      extra={ol.enabled ? <span className="sw-dot" style={{ background: ol.color }} /> : undefined}>
      <OutlineControls
        value={ol}
        long={long}
        set={set}
        commit={commit}
        moreId="cut.outline.more"
        defWidth={image ? defaultOutlineWidth(image.w, image.h) : undefined}
        viewHint={viewMode !== "normal" ? (
          <div className="hint mt8">
            외곽선은 <b>합성</b> 보기에서만 보여요.{" "}
            <button className="btn sm ghost" onClick={() => setStore({ viewMode: "normal" })}>합성으로 보기</button>
          </div>
        ) : undefined}
      />
    </Section>
  );
}
