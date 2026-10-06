// 무거운 픽셀 데이터 보관소. 문서(Doc)는 여기의 id 만 참조한다.

export interface SourceImage {
  name: string;
  w: number;
  h: number;
  data: Uint8ClampedArray; // RGBA, 위→아래 행 순서
  hasAlpha: boolean;
  version: number; // 새 이미지를 열 때마다 증가
}

export interface MaskData {
  w: number;
  h: number;
  data: Uint8Array; // 1채널
}

export interface RgbaData {
  w: number;
  h: number;
  data: Uint8Array; // RGBA
}

let seq = 0;
export const newId = (prefix: string) => `${prefix}${++seq}`;

export const resources = {
  source: null as SourceImage | null,
  masks: new Map<string, MaskData>(),
  fgs: new Map<string, RgbaData>(),
  bgImages: new Map<string, ImageBitmap>(),
};

/** 더 이상 어떤 기록에서도 참조하지 않는 리소스를 해제하고, 해제된 id 목록을 돌려준다. */
export function collectGarbage(referenced: Set<string>): string[] {
  const freed: string[] = [];
  for (const map of [resources.masks, resources.fgs, resources.bgImages] as Map<string, unknown>[]) {
    for (const id of [...map.keys()]) {
      if (!referenced.has(id)) {
        const v = map.get(id);
        if (v instanceof ImageBitmap) v.close();
        map.delete(id);
        freed.push(id);
      }
    }
  }
  return freed;
}

export function clearResources() {
  resources.masks.clear();
  resources.fgs.clear();
  for (const b of resources.bgImages.values()) b.close();
  resources.bgImages.clear();
}
