import {
  FMT_BYTES,
  Program,
  bindTarget,
  createTexture,
  deleteTarget,
  ensureTarget,
  textureFromImage,
  type Target,
} from "./glutil";
import * as S from "./shaders";
import { SET_VEC4, hexToRgb, orientMatrix, packAdjust } from "./params";
import { Stamper } from "./stamper";
import { curvesToLut } from "../lib/curves";
import { resources, type SourceImage } from "../resources";
import { outputSize, type Doc, type Effects, type MaskOp, type RasterOp, type Rect, type Stroke } from "../types";

export interface DisplayState {
  canvasW: number;
  canvasH: number;
  dpr: number;
  zoom: number;
  ox: number;
  oy: number;
  /** 화면에 보이는 영역 (출력 px) */
  viewRect: [number, number, number, number];
  mode: number; // 0 합성, 1 오버레이, 2 마스크, 3 검정, 4 흰색, 5 원본
  split: number; // 분할 비교 x (device px), 없으면 -1
  shade: [number, number, number, number] | null; // 자르기 음영 (출력 px)
}

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  l: Uint32Array;
  max: number;
}

export interface PreviewItem {
  params: Float32Array;
  lut: Uint8Array;
  vignette: number;
}

const BG_MODE = { original: 0, transparent: 1, color: 2, blur: 3, image: 4 } as const;
const WORKSPACE: [number, number, number] = [0.086, 0.09, 0.1];
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** 렌더 타깃 필드 전체 */
const TARGETS = [
  "work", "refined", "rA", "rB", "bgA", "bgB", "shA", "shB", "frA", "frB", "mtA", "mtB", "refA", "refB",
  "rnA", "rnB", "thA", "thB", "thC", "thD", "roiA", "roiB", "kA", "kB", "jfA", "jfB", "calpha",
  "clA", "clB", "comp", "fxT", "small", "smallFx", "histT", "svA", "svB",
] as const;
type TargetKey = (typeof TARGETS)[number];
/** 계산하는 동안에만 쓰는 중간 타깃 (결과는 다른 타깃에 남는다) — 한동안 쓰지 않으면 내려놓는다.
 *  (테두리 거리장 jfA/jfB 는 결과가 든 쪽만 남긴다) */
const SCRATCH: readonly TargetKey[] = [
  "rA", "rB", "bgB", "shB", "frB", "mtB", "refA", "refB", "rnB", "thA", "thB", "thC", "thD", "roiA", "roiB",
  "kA", "kB", "clA", "clB", "svB",
];
/** 마지막 계산 뒤 이만큼(ms) 아무 계산도 없으면 중간 타깃을 내려놓는다 */
const SCRATCH_IDLE_MS = 4000;
/** 테두리 거리장을 절반 해상도로 계산하는 크기 (원본 px 수). 그 이하는 원본 해상도 그대로 */
const OUTLINE_HALF_RES = 6e6;

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private p: Record<"copy" | "orient" | "down" | "bgprep" | "blur" | "refine" | "stamp" | "region" | "fringe" | "calpha" | "morph" | "erode" | "key" | "max2" | "jfaInit" | "jfaStep" | "comp" | "fx" | "display", Program>;
  private quad: WebGLVertexArrayObject;
  private stampVao: WebGLVertexArrayObject;
  private instBuf: WebGLBuffer;
  private white: WebGLTexture;
  private clear: WebGLTexture;
  /** 정수 샘플러(테두리 거리장) 자리에 끼울 빈 텍스처 */
  private clearU: WebGLTexture;
  private lut: WebGLTexture;
  private lutThumb: WebGLTexture;
  private lutData = new Uint8Array(256 * 3 * 4);
  private half: boolean;
  private lost = false;

  private src: WebGLTexture | null = null;
  private srcW = 0;
  private srcH = 0;
  private srcVersion = -1;
  private maskTex = new Map<string, WebGLTexture>();
  private fgTex = new Map<string, WebGLTexture>();
  private bgTex = new Map<string, { tex: WebGLTexture; w: number; h: number }>();

  private work: Target | null = null;
  private refined: Target | null = null;
  /** 테두리 깎기 결과 (svB 는 계산용) */
  private svA: Target | null = null;
  private svB: Target | null = null;
  private rA: Target | null = null;
  private rB: Target | null = null;
  private bgA: Target | null = null;
  private bgB: Target | null = null;
  private shA: Target | null = null;
  private frA: Target | null = null;
  private frB: Target | null = null;
  private fringeValid = false;
  private mtA: Target | null = null;
  private mtB: Target | null = null;
  private matteValid = false;
  private refA: Target | null = null;
  private refB: Target | null = null;
  private rnA: Target | null = null;
  private rnB: Target | null = null;
  private thA: Target | null = null;
  private thB: Target | null = null;
  private thC: Target | null = null;
  private thD: Target | null = null;
  private roiA: Target | null = null;
  private roiB: Target | null = null;
  private kA: Target | null = null;
  private kB: Target | null = null;
  private jfA: Target | null = null;
  private jfB: Target | null = null;
  private distT: Target | null = null;
  /** 거리장 1픽셀 = 원본 몇 px */
  private distF = 1;
  private calpha: Target | null = null;
  private calphaValid = false;
  private shB: Target | null = null;
  private clA: Target | null = null;
  private clB: Target | null = null;
  private comp: Target | null = null;
  private fxT: Target | null = null;
  private small: Target | null = null;
  private smallFx: Target | null = null;
  private histT: Target | null = null;
  private maskOut: WebGLTexture | null = null;
  private finalT: Target | null = null;
  private bgBlurValid = false;
  private selTex: WebGLTexture | null = null;
  private selSize = [0, 0];
  private selVersion = -1;
  private time = 0;
  private shadowValid = false;

  private doc: Doc | null = null;
  private view: DisplayState | null = null;
  private applied: MaskOp[] = [];
  private baseKey: string | null = null;
  private live: { stroke: Stroke; stamper: Stamper } | null = null;
  private params = new Float32Array(3 * SET_VEC4 * 4);
  private d = { mask: true, matte: true, calpha: true, refine: true, fringe: true, outline: true, bgBlur: true, shadow: true, comp: true };
  private raf = 0;
  private idleTimer = 0;
  /** trim() 뒤: 화면에는 마지막 결과만 보여 주고, 무엇이 바뀌기 전까지 다시 계산하지 않는다 */
  private trimmed = false;

  onComposite?: () => void;
  onLost?: () => void;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("이 브라우저는 WebGL2를 지원하지 않습니다.");
    this.gl = gl;
    this.half = !!gl.getExtension("EXT_color_buffer_float");
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
      this.onLost?.();
    });

    this.p = {
      copy: new Program(gl, S.VS_QUAD, S.FS_COPY),
      orient: new Program(gl, S.VS_QUAD, S.FS_ORIENT),
      down: new Program(gl, S.VS_QUAD, S.FS_DOWN),
      bgprep: new Program(gl, S.VS_QUAD, S.FS_BGPREP),
      blur: new Program(gl, S.VS_QUAD, S.FS_BLUR),
      refine: new Program(gl, S.VS_QUAD, S.FS_REFINE),
      stamp: new Program(gl, S.VS_STAMP, S.FS_STAMP),
      region: new Program(gl, S.VS_REGION, S.FS_REGION),
      fringe: new Program(gl, S.VS_QUAD, S.FS_FRINGEPREP),
      calpha: new Program(gl, S.VS_QUAD, S.FS_CALPHA),
      morph: new Program(gl, S.VS_QUAD, S.FS_MORPH),
      erode: new Program(gl, S.VS_QUAD, S.FS_ERODE),
      key: new Program(gl, S.VS_QUAD, S.FS_KEY),
      max2: new Program(gl, S.VS_QUAD, S.FS_MAX2),
      jfaInit: new Program(gl, S.VS_QUAD, S.FS_JFA_INIT),
      jfaStep: new Program(gl, S.VS_QUAD, S.FS_JFA_STEP),
      comp: new Program(gl, S.VS_QUAD, S.FS_COMPOSITE),
      fx: new Program(gl, S.VS_QUAD, S.FS_EFFECTS),
      display: new Program(gl, S.VS_QUAD, S.FS_DISPLAY),
    };

    const quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.stampVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.stampVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);

    this.white = createTexture(gl, 1, 1, "rgba8", new Uint8Array([255, 255, 255, 255]));
    this.clear = createTexture(gl, 1, 1, "rgba8", new Uint8Array([0, 0, 0, 0]));
    this.clearU = createTexture(gl, 1, 1, "rg16ui", new Uint16Array([0, 0xffff]));
    const ident = new Uint8Array(256 * 3 * 4);
    for (let r = 0; r < 3; r++) for (let i = 0; i < 256; i++) ident.fill(i, (r * 256 + i) * 4, (r * 256 + i) * 4 + 4);
    this.lut = createTexture(gl, 256, 3, "rgba8", ident);
    this.lutThumb = createTexture(gl, 256, 3, "rgba8", ident);
  }

  // -------------------------------------------------------------------------
  // 상태 동기화

  sync(doc: Doc | null) {
    this.trimmed = false;
    const src = resources.source;
    if (!src || !doc) {
      if (this.src) this.resetImage();
      this.doc = null;
      this.request();
      return;
    }
    if (src.version !== this.srcVersion) this.loadSource(src);
    const p = this.doc;
    if (!p || doc.cutout !== p.cutout || doc.strokes !== p.strokes) this.d.mask = true;
    if (!p || doc.edge !== p.edge || doc.invert !== p.invert) {
      if (!p || doc.edge.feather !== p.edge.feather || doc.edge.shift !== p.edge.shift ||
          doc.edge.contrast !== p.edge.contrast || doc.invert !== p.invert || doc.edge.shave !== p.edge.shave) this.d.refine = true;
      if (!p || doc.edge.defringe !== p.edge.defringe || doc.invert !== p.invert) this.d.fringe = true;
      if (!p || doc.edge.deconMode !== p.edge.deconMode || doc.edge.matteSource !== p.edge.matteSource ||
          doc.edge.colorAlpha !== p.edge.colorAlpha || doc.invert !== p.invert) this.d.matte = true;
      if (!p || doc.edge.colorAlpha !== p.edge.colorAlpha || doc.edge.matteColor !== p.edge.matteColor) this.d.calpha = true;
      this.d.comp = true;
    }
    if (!p || doc.bg !== p.bg) {
      this.d.comp = true;
      if (!p || doc.bg.mode !== p.bg.mode || doc.bg.blur !== p.bg.blur) this.d.bgBlur = true;
    }
    if (!p || doc.outline !== p.outline) {
      this.d.comp = true;
      if (!p || doc.outline.enabled !== p.outline.enabled) this.d.outline = true;
    }
    if (!p || doc.shadow !== p.shadow) {
      this.d.comp = true;
      if (!p || doc.shadow.blur !== p.shadow.blur || doc.shadow.enabled !== p.shadow.enabled) this.d.shadow = true;
    }
    if (!p || doc.adjust !== p.adjust) {
      this.d.comp = true;
      this.uploadLut(doc, this.lut);
    }
    if (!p || doc.effects !== p.effects || doc.crop !== p.crop || doc.orient !== p.orient) this.d.comp = true;
    this.doc = doc;
    this.gcTextures();
    this.request();
  }

  setView(v: DisplayState) {
    this.view = v;
    this.trimmed = false;
    this.request();
  }

  request() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  private frame() {
    this.raf = 0;
    if (this.lost) return;
    const composed = this.trimmed ? false : this.flush();
    this.drawDisplay();
    if (composed) this.onComposite?.();
  }

  /** 밀린 계산을 모두 처리. 합성을 새로 했으면 true */
  private flush(): boolean {
    this.trimmed = false;
    if (!this.src || !this.doc) return false;
    const d = this.d;
    if (d.mask || d.matte || d.calpha || d.refine || d.fringe || d.outline || d.bgBlur || d.shadow || d.comp) {
      this.scheduleScratchRelease();
    }
    // 마스크 → 주변 배경색 → 투명도 다시 계산 → 가장자리 다듬기 → (색 채우기·배경 흐림·그림자) → 합성
    if (this.d.mask) this.updateMask();
    if (this.d.matte) {
      this.updateMatte();
      this.d.calpha = this.d.comp = true;
    }
    if (this.d.calpha) {
      this.updateColorAlpha();
      this.d.refine = true;
    }
    if (this.d.refine) {
      this.updateRefine();
      this.d.fringe = this.d.outline = this.d.bgBlur = this.d.shadow = this.d.comp = true;
    }
    if (this.d.fringe) this.updateFringe();
    if (this.d.outline) this.updateOutline();
    if (this.d.bgBlur) this.updateBgBlur();
    if (this.d.shadow) this.updateShadow();
    if (this.d.comp) {
      this.updateComposite();
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // 리소스

  private loadSource(src: SourceImage) {
    const gl = this.gl;
    this.resetImage();
    this.src = createTexture(gl, src.w, src.h, "rgba8",
      new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.byteLength), true);
    this.srcW = src.w;
    this.srcH = src.h;
    this.srcVersion = src.version;
  }

  private resetImage() {
    const gl = this.gl;
    if (this.src) gl.deleteTexture(this.src);
    this.src = null;
    this.srcVersion = -1;
    for (const t of this.maskTex.values()) gl.deleteTexture(t);
    for (const t of this.fgTex.values()) gl.deleteTexture(t);
    for (const t of this.bgTex.values()) gl.deleteTexture(t.tex);
    this.maskTex.clear();
    this.fgTex.clear();
    this.bgTex.clear();
    this.drop(...TARGETS);
    this.maskOut = null;
    this.finalT = null;
    if (this.selTex) gl.deleteTexture(this.selTex);
    this.selTex = null;
    this.selVersion = -1;
    this.applied = [];
    this.baseKey = null;
    this.live = null;
    this.doc = null;
    this.d = { mask: true, matte: true, calpha: true, refine: true, fringe: true, outline: true, bgBlur: true, shadow: true, comp: true };
    this.distT = null;
  }

  /** 렌더 타깃을 지운다 (다음에 필요할 때 ensureTarget 이 다시 만든다) */
  private drop(...keys: TargetKey[]) {
    for (const k of keys) {
      const t = this[k];
      if (!t) continue;
      deleteTarget(this.gl, t);
      this[k] = null;
    }
  }

  /** GPU 에는 지금 문서가 쓰는 마스크·전경·배경 이미지만 둔다.
   *  실행 취소 기록에만 남은 누끼 결과는 CPU 사본(resources)에서 필요할 때 다시 올린다 (결과마다 6B/px 절약) */
  private gcTextures() {
    const gl = this.gl;
    const doc = this.doc;
    const masks = new Set<string>();
    if (doc?.cutout) masks.add(doc.cutout.maskId);
    if (doc) for (const op of doc.strokes) if (op.kind === "raster") masks.add(op.id);
    const fg = doc?.cutout?.fgId ?? null;
    const bg = doc?.bg.mode === "image" ? doc.bg.imageId : null;
    for (const [id, t] of this.maskTex) if (!masks.has(id) || !resources.masks.has(id)) { gl.deleteTexture(t); this.maskTex.delete(id); }
    for (const [id, t] of this.fgTex) if (id !== fg || !resources.fgs.has(id)) { gl.deleteTexture(t); this.fgTex.delete(id); }
    for (const [id, t] of this.bgTex) if (id !== bg || !resources.bgImages.has(id)) { gl.deleteTexture(t.tex); this.bgTex.delete(id); }
  }

  private scheduleScratchRelease() {
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.releaseScratch(), SCRATCH_IDLE_MS);
  }

  /** 계산용 중간 타깃을 내려놓는다. 결과(마스크·투명도·거리장·합성 등)는 그대로라 화면은 바뀌지 않는다 */
  private releaseScratch() {
    this.idleTimer = 0;
    if (this.lost) return;
    this.drop(...SCRATCH);
    if (this.distT !== this.jfA) this.drop("jfA");
    if (this.distT !== this.jfB) this.drop("jfB");
  }

  private getMask(id: string): WebGLTexture {
    let t = this.maskTex.get(id);
    if (!t) {
      const m = resources.masks.get(id)!;
      t = createTexture(this.gl, m.w, m.h, "r8", m.data);
      this.maskTex.set(id, t);
    }
    return t;
  }

  private getFg(id: string | null): WebGLTexture | null {
    if (!id) return null;
    let t = this.fgTex.get(id);
    if (!t) {
      const f = resources.fgs.get(id);
      if (!f) return null;
      t = createTexture(this.gl, f.w, f.h, "rgba8", f.data, true);
      this.fgTex.set(id, t);
    }
    return t;
  }

  private getBg(id: string | null) {
    if (!id) return null;
    let t = this.bgTex.get(id);
    if (!t) {
      const b = resources.bgImages.get(id);
      if (!b) return null;
      t = { tex: textureFromImage(this.gl, b, true), w: b.width, h: b.height };
      this.bgTex.set(id, t);
    }
    return t;
  }

  private uploadLut(doc: Doc, tex: WebGLTexture) {
    curvesToLut(doc.adjust.global.curves, this.lutData, 0);
    curvesToLut(doc.adjust.subject.curves, this.lutData, 1024);
    curvesToLut(doc.adjust.background.curves, this.lutData, 2048);
    this.writeLut(tex, this.lutData);
  }

  private writeLut(tex: WebGLTexture, data: Uint8Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 3, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  private drawQuad() {
    const gl = this.gl;
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  private blur(input: WebGLTexture, out: Target, sigma: number, dx: number, dy: number) {
    bindTarget(this.gl, out);
    this.p.blur.use().tex("uTex", 0, input).f2("uDir", dx, dy)
      .f("uSigma", Math.max(sigma, 0.05)).i("uRadius", Math.min(64, Math.max(1, Math.ceil(sigma * 3))));
    this.drawQuad();
  }

  // -------------------------------------------------------------------------
  // 마스크 (원본 좌표계)

  private updateMask() {
    this.d.mask = false;
    const doc = this.doc!;
    if (!doc.cutout || !resources.masks.has(doc.cutout.maskId)) {
      this.applied = [];
      this.baseKey = null;
      this.maskOut = null;
      this.drop("work");
      this.d.matte = this.d.calpha = this.d.refine = true; // 누끼에서 나온 타깃들도 정리되게
      return;
    }
    const gl = this.gl;
    this.work = ensureTarget(gl, this.work, this.srcW, this.srcH, "r8");
    const key = doc.cutout.maskId;
    const strokes = doc.strokes;
    const prefix = key === this.baseKey && this.applied.length <= strokes.length &&
      this.applied.every((s, i) => s === strokes[i]);
    let todo: MaskOp[];
    if (!prefix) {
      bindTarget(gl, this.work);
      gl.disable(gl.BLEND);
      this.p.copy.use().tex("uTex", 0, this.getMask(key));
      this.drawQuad();
      todo = strokes;
    } else {
      todo = strokes.slice(this.applied.length);
    }
    for (const s of todo) {
      if (s.kind === "raster") this.drawRaster(s);
      else this.drawStamps(s, new Stamper(s).next());
    }
    this.applied = strokes.slice();
    this.baseKey = key;
    this.d.matte = this.d.calpha = this.d.refine = true;
  }

  /** 선택 영역 적용 기록을 마스크에 찍기 */
  private drawRaster(op: RasterOp) {
    if (!this.work || !resources.masks.has(op.id)) return;
    const gl = this.gl;
    bindTarget(gl, this.work);
    if (op.mode === "replace") {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.enable(gl.BLEND);
    gl.blendEquation(op.mode === "sub" ? gl.MIN : gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.p.region.use()
      .tex("uTex", 0, this.getMask(op.id))
      .f4("uRect", op.x, op.y, op.w, op.h)
      .f2("uSize", this.srcW, this.srcH)
      .i("uSub", op.mode === "sub" ? 1 : 0);
    this.drawQuad();
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
  }

  /** 선택 영역(원본 크기 0..255) — 화면에 움직이는 점선으로 표시 */
  setSelection(sel: { data: Uint8Array; w: number; h: number; dirty?: { x: number; y: number; w: number; h: number } | null } | null, version: number) {
    if (version === this.selVersion) return;
    this.selVersion = version;
    this.trimmed = false;
    const gl = this.gl;
    if (!sel) {
      if (this.selTex) gl.deleteTexture(this.selTex);
      this.selTex = null;
    } else if (this.selTex && this.selSize[0] === sel.w && this.selSize[1] === sel.h) {
      gl.bindTexture(gl.TEXTURE_2D, this.selTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const d = sel.dirty;
      if (d && d.w > 0 && d.h > 0) {
        // 선택 붓: 바뀐 부분만 올린다
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, sel.w);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, d.x);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, d.y);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, d.x, d.y, d.w, d.h, gl.RED, gl.UNSIGNED_BYTE, sel.data);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, sel.w, sel.h, gl.RED, gl.UNSIGNED_BYTE, sel.data);
    } else {
      if (this.selTex) gl.deleteTexture(this.selTex);
      this.selTex = createTexture(gl, sel.w, sel.h, "r8", sel.data);
      this.selSize = [sel.w, sel.h];
    }
    this.request();
  }

  setTime(t: number) {
    this.time = t;
    this.request();
  }

  private drawStamps(s: Stroke, stamps: Float32Array) {
    if (!stamps.length || !this.work || !this.src) return;
    const gl = this.gl;
    bindTarget(gl, this.work);
    gl.enable(gl.BLEND);
    gl.blendEquation(s.mode === "add" ? gl.MAX : gl.MIN);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.p.stamp.use()
      .f2("uSize", this.srcW, this.srcH)
      .f("uHard", s.hardness / 100)
      .f("uOpacity", s.opacity / 100)
      .f("uTol", 0.04 + (s.tolerance / 100) * 0.42)
      .i("uSub", s.mode === "sub" ? 1 : 0)
      .i("uAuto", s.auto ? 1 : 0)
      .tex("uSrc", 0, this.src);
    gl.bindVertexArray(this.stampVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, stamps, gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, stamps.length / 3);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
  }

  /** 실시간 붓질 시작 — 획 객체의 pts 에 점을 추가하면서 extendStroke() 를 부른다 */
  beginStroke(s: Stroke) {
    this.trimmed = false;
    if (this.d.mask) this.updateMask();
    this.live = { stroke: s, stamper: new Stamper(s) };
    this.extendStroke();
  }

  extendStroke() {
    if (!this.live) return;
    this.drawStamps(this.live.stroke, this.live.stamper.next());
    this.d.calpha = this.d.refine = true;
    this.request();
  }

  /** 붓질 끝 — 곧이어 문서에 같은 획 객체가 추가되므로, 다시 그리지 않도록 표시 */
  endStroke() {
    if (this.live) {
      this.applied = [...this.applied, this.live.stroke];
      this.live = null;
    }
  }

  private updateRefine() {
    this.d.refine = false;
    const doc = this.doc!;
    if (!doc.cutout || !this.work) {
      this.maskOut = null;
      this.drop("refined", "rA", "rB", "svA", "svB");
      return;
    }
    this.refineBase(doc);
    this.shave(Math.round(doc.edge.shave || 0));
  }

  /** 테두리 깎기: n 번 1px 씩 (결과는 svA) */
  private shave(n: number) {
    if (n <= 0 || !this.maskOut) {
      this.drop("svA", "svB");
      return;
    }
    const gl = this.gl;
    const W = this.srcW, H = this.srcH;
    this.svA = ensureTarget(gl, this.svA, W, H, "r8");
    if (n > 1) this.svB = ensureTarget(gl, this.svB, W, H, "r8");
    else this.drop("svB");
    // 마지막이 svA 에 떨어지도록 시작 타깃을 고른다
    let input = this.maskOut;
    for (let i = 0; i < n; i++) {
      const out = (n - i) % 2 === 1 ? this.svA : this.svB!;
      bindTarget(gl, out);
      this.p.erode.use().tex("uTex", 0, input).i("uDiag", i % 2);
      this.drawQuad();
      input = out.tex;
    }
    this.maskOut = this.svA.tex;
  }

  private refineBase(doc: Doc) {
    const e = doc.edge;
    const s = e.shift / 100;
    const k = e.contrast / 100;
    if (e.feather === 0 && s === 0 && k === 0 && !doc.invert) {
      this.maskOut = this.alphaTex();
      this.drop("refined", "rA", "rB");
      return;
    }
    const gl = this.gl;
    const W = this.srcW, H = this.srcH;
    const shiftPx = Math.abs(s) * Math.max(4, Math.max(W, H) / 150);
    const sigma = Math.hypot(e.feather / 2, shiftPx / 2);
    let input = this.alphaTex();
    if (sigma > 0.3) {
      const f = clamp(Math.floor(sigma / 2.5), 1, 16);
      const lw = Math.ceil(W / f), lh = Math.ceil(H / f);
      this.rA = ensureTarget(gl, this.rA, lw, lh, "r8");
      this.rB = ensureTarget(gl, this.rB, lw, lh, "r8");
      if (f > 1) {
        bindTarget(gl, this.rA);
        this.p.down.use().tex("uTex", 0, this.work!.tex).f2("uSrcTexel", 1 / W, 1 / H).f("uFactor", f);
        this.drawQuad();
        input = this.rA.tex;
      }
      this.blur(input, this.rB, sigma / f, 1 / lw, 0);
      this.blur(this.rB.tex, this.rA, sigma / f, 0, 1 / lh);
      input = this.rA.tex;
    } else {
      this.drop("rA", "rB");
    }
    const c = 0.5 - 0.45 * s;
    const w = Math.max(0.02, (1 - k) * (1 - 0.9 * Math.abs(s)));
    this.refined = ensureTarget(gl, this.refined, W, H, "r8");
    bindTarget(gl, this.refined);
    this.p.refine.use().tex("uTex", 0, input).f("uLo", c - w / 2).f("uHi", c + w / 2).i("uInvert", doc.invert ? 1 : 0);
    this.drawQuad();
    this.maskOut = this.refined.tex;
  }

  private updateBgBlur() {
    this.d.bgBlur = false;
    this.bgBlurValid = false;
    const doc = this.doc!;
    if (!doc.cutout || doc.bg.mode !== "blur" || !this.maskOut || !this.src) {
      this.drop("bgA", "bgB");
      return;
    }
    const gl = this.gl;
    const W = this.srcW, H = this.srcH;
    const sigma = Math.max(1, (doc.bg.blur / 100) * Math.max(W, H) * 0.03);
    const f = clamp(Math.floor(sigma / 3), 2, 16);
    const lw = Math.ceil(W / f), lh = Math.ceil(H / f);
    const fmt = this.half ? "rgba16f" : "rgba8";
    this.bgA = ensureTarget(gl, this.bgA, lw, lh, fmt);
    this.bgB = ensureTarget(gl, this.bgB, lw, lh, fmt);
    bindTarget(gl, this.bgA);
    this.p.bgprep.use().tex("uSrc", 0, this.src).tex("uMask", 1, this.maskOut)
      .f2("uSrcTexel", 1 / W, 1 / H).f("uFactor", f);
    this.drawQuad();
    this.blur(this.bgA.tex, this.bgB, sigma / f, 1 / lw, 0);
    this.blur(this.bgB.tex, this.bgA, sigma / f, 0, 1 / lh);
    this.bgBlurValid = true;
  }

  /** 가장자리 색 채우기: 불투명 피사체 픽셀의 색을 바깥으로 번지게 한 장 (premultiplied) */
  private updateFringe() {
    this.d.fringe = false;
    this.fringeValid = false;
    const doc = this.doc!;
    if (!doc.cutout || !this.work || !this.src || doc.edge.defringe <= 0) {
      this.drop("frA", "frB");
      return;
    }
    const gl = this.gl;
    const W = this.srcW, H = this.srcH;
    const sigma = Math.max(0.6, doc.edge.defringe / 2);
    const f = clamp(Math.floor(sigma / 1.5), W * H > 4e6 ? 2 : 1, 16);
    const lw = Math.ceil(W / f), lh = Math.ceil(H / f);
    const fmt = this.half ? "rgba16f" : "rgba8";
    this.frA = ensureTarget(gl, this.frA, lw, lh, fmt);
    this.frB = ensureTarget(gl, this.frB, lw, lh, fmt);
    bindTarget(gl, this.frA);
    this.p.fringe.use().tex("uSrc", 0, this.src).tex("uMask", 1, this.alphaTex())
      .f2("uSrcTexel", 1 / W, 1 / H).f("uFactor", f).i("uInvert", doc.invert ? 1 : 0).i("uPickBg", 0);
    this.drawQuad();
    this.blur(this.frA.tex, this.frB, sigma / f, 1 / lw, 0);
    this.blur(this.frB.tex, this.frA, sigma / f, 0, 1 / lh);
    this.fringeValid = true;
  }

  /** 경계 주변의 실제 배경색 (확실한 배경 픽셀을 안쪽으로 번지게) — '배경색 빼기 · 자동'용 */
  private updateMatte() {
    this.d.matte = false;
    this.matteValid = false;
    const doc = this.doc!;
    const e = doc.edge;
    const forMatte = !!doc.cutout && e.deconMode === "matte" && e.matteSource === "auto" && doc.cutout.source !== "alpha";
    const forAlpha = e.colorAlpha > 0 && !doc.invert;
    if (!doc.cutout || !this.work || !this.src || (!forMatte && !forAlpha)) {
      this.drop("mtA", "mtB");
      return;
    }
    const gl = this.gl;
    const W = this.srcW, H = this.srcH;
    // 경계 띠를 덮을 만큼: 긴 변의 0.8% (최소 6px)
    const sigma = Math.max(6, Math.max(W, H) * 0.008);
    const f = clamp(Math.floor(sigma / 3), 2, 16);
    const lw = Math.ceil(W / f), lh = Math.ceil(H / f);
    const fmt = this.half ? "rgba16f" : "rgba8";
    this.mtA = ensureTarget(gl, this.mtA, lw, lh, fmt);
    this.mtB = ensureTarget(gl, this.mtB, lw, lh, fmt);
    bindTarget(gl, this.mtA);
    this.p.fringe.use().tex("uSrc", 0, this.src).tex("uMask", 1, this.work.tex)
      .f2("uSrcTexel", 1 / W, 1 / H).f("uFactor", f).i("uInvert", doc.invert ? 1 : 0).i("uPickBg", 1);
    this.drawQuad();
    this.blur(this.mtA.tex, this.mtB, sigma / f, 1 / lw, 0);
    this.blur(this.mtB.tex, this.mtA, sigma / f, 0, 1 / lh);
    this.matteValid = true;
  }

  /** 테두리용 거리장: 피사체 윤곽(마스크 0.5)까지의 거리를 Jump Flooding 으로 계산.
   *  RG16UI 2장(픽셀당 8B)으로 계산하고, 끝나면 결과가 든 1장만 남는다 (잠시 뒤 releaseScratch) */
  private updateOutline() {
    this.d.outline = false;
    this.distT = null;
    const doc = this.doc!;
    if (!doc.cutout || !doc.outline.enabled || !this.maskOut) {
      this.drop("jfA", "jfB");
      return;
    }
    const gl = this.gl;
    const W = this.srcW, H = this.srcH;
    const f = W * H > OUTLINE_HALF_RES ? 2 : 1; // 아주 큰 사진은 절반 해상도 (오차 1px 이내)
    const lw = Math.ceil(W / f), lh = Math.ceil(H / f);
    this.jfA = ensureTarget(gl, this.jfA, lw, lh, "rg16ui");
    this.jfB = ensureTarget(gl, this.jfB, lw, lh, "rg16ui");
    this.distF = f;
    gl.disable(gl.BLEND);
    bindTarget(gl, this.jfA);
    this.p.jfaInit.use().tex("uMask", 0, this.maskOut).f2("uSize", lw, lh);
    this.drawQuad();
    let read = this.jfA, write = this.jfB;
    const steps: number[] = [];
    for (let k = 1 << Math.ceil(Math.log2(Math.max(lw, lh))); k >= 1; k >>= 1) steps.push(k);
    steps.push(1); // JFA+1: 마지막에 한 번 더 다듬어 오차 줄이기
    for (const k of steps) {
      bindTarget(gl, write);
      this.p.jfaStep.use().tex("uTex", 0, read.tex).i("uStep", k).f("uF", f);
      this.drawQuad();
      [read, write] = [write, read];
    }
    this.distT = read;
  }

  /** 투명도 다시 계산 (색 기준). 결과가 이후 단계의 '원래 알파'가 된다 */
  private updateColorAlpha() {
    this.d.calpha = false;
    this.calphaValid = false;
    const doc = this.doc!;
    if (!doc.cutout || !this.work || !this.src || doc.edge.colorAlpha <= 0 || doc.invert) {
      this.drop("thA", "thB", "thC", "thD", "kA", "kB", "roiA", "roiB", "refA", "refB", "rnA", "rnB", "calpha");
      return;
    }
    const gl = this.gl;
    const W = this.srcW, H = this.srcH;
    const long = Math.max(W, H);
    const fmt = this.half ? "rgba16f" : "rgba8";
    const [mr, mg, mb] = hexToRgb(doc.edge.matteColor);
    const r8 = (t: Target | null) => ensureTarget(gl, t, W, H, "r8");
    this.thA = r8(this.thA); this.thB = r8(this.thB); this.thC = r8(this.thC); this.thD = r8(this.thD);
    this.kA = r8(this.kA); this.kB = r8(this.kB);
    const open = (src: WebGLTexture, a: Target, b: Target, rad: number) => {
      this.morph(src, a, rad, 1 / W, 0, false); this.morph(a.tex, b, rad, 0, 1 / H, false);
      this.morph(b.tex, a, rad, 1 / W, 0, true); this.morph(a.tex, b, rad, 0, 1 / H, true);
    };

    // 1) AI 가 확신한 굵은 부분 (마스크 '열림'). 줄기·제품 몸통처럼 확실히 굵은 것만 — 옅은 가지는 AI 가 확신해도 제외
    const rThick = Math.max(4, Math.round(long * 0.004));
    open(this.work.tex, this.thA, this.thB, rThick);
    const g = this.globalFgColor(doc);
    const key = (target: Target, mode: number) => {
      bindTarget(gl, target);
      this.p.key.use().tex("uSrc", 0, this.src!)
        .tex("uMatteTex", 1, this.matteValid && this.mtA ? this.mtA.tex : this.clear)
        .i("uMatteLocal", this.matteLocal(doc) ? 1 : 0).f3("uMatteColor", mr, mg, mb)
        .i("uDark", mode).f3("uRefGlobal", g ? g[0] : 0, g ? g[1] : 0, g ? g[2] : 0);
      this.drawQuad();
    };
    const re = Math.max(2, Math.round(long * 0.001));
    // 2) 꽉 찬 영역: 배경과 다른 색 중 줄기·큰 가지 굵기 (큰 반경 열림) ∪ AI 의 굵은 부분.
    //    옅게 그려진 잔가지나 잔가지가 엇갈린 곳은 '꽉 찬 영역'이 아니다
    key(this.kA, 0);
    open(this.kA.tex, this.thC, this.kB, rThick);
    bindTarget(gl, this.kA);
    this.p.max2.use().tex("uA", 0, this.kB.tex).tex("uB", 1, this.thB.tex);
    this.drawQuad();
    // 굵은 구조 바로 옆까지 (경계의 반투명 띠는 그 구조의 색 기준으로 계산) — 부드럽게 넘어가도록 흐림
    this.morph(this.kA.tex, this.thC, re + 2, 1 / W, 0, true); this.morph(this.thC.tex, this.thA, re + 2, 0, 1 / H, true);
    this.blur(this.thA.tex, this.thC, re * 1.5, 1 / W, 0); this.blur(this.thC.tex, this.thA, re * 1.5, 0, 1 / H);
    const nearThick = this.thA.tex;
    // 핵심부만 남김(침식): 경계 띠의 흰 섞인 픽셀은 꽉 찬 영역에서 빠지고, 경계는 핵심부 색을 기준으로 계산된다
    this.morph(this.kA.tex, this.thC, re, 1 / W, 0, false); this.morph(this.thC.tex, this.kB, re, 0, 1 / H, false);
    const solid = this.kB.tex;
    // 3) 가지마다의 진한 정도: 주변 몇 px 안에서 가장 진한 값 (가지 가운데의 진하기 = 그 가지의 원래 색)
    //    + 그 가지가 진하기를 믿을 만큼 굵은지 (1~2px 잔가지는 가운데도 반쯤 투명해서 진하기를 믿을 수 없다)
    if (g) {
      key(this.kA, 1);
      this.morph(this.kA.tex, this.thC, re + 1, 1 / W, 0, true); this.morph(this.thC.tex, this.kA, re + 1, 0, 1 / H, true);
      this.blur(this.kA.tex, this.thC, re / 2, 1 / W, 0); this.blur(this.thC.tex, this.kA, re / 2, 0, 1 / H);
      key(this.thB, 2);
      const r1 = Math.max(1, re - 1);
      this.morph(this.thB.tex, this.thC, r1, 1 / W, 0, false); this.morph(this.thC.tex, this.thB, r1, 0, 1 / H, false);
      this.morph(this.thB.tex, this.thC, r1 + re + 1, 1 / W, 0, true); this.morph(this.thC.tex, this.thB, r1 + re + 1, 0, 1 / H, true);
      this.blur(this.thB.tex, this.thC, re, 1 / W, 0); this.blur(this.thC.tex, this.thB, re, 0, 1 / H);
    }
    const coreTone = this.kA.tex;
    const wide = this.thB.tex;
    // 4) 범위: AI 마스크를 넉넉히 넓힘 (AI 가 놓친 가까운 잔가지까지). 굵은 지도라 축소해서 계산
    //    (가는 가지가 줄이면서 사라지지 않게 최대값으로 줄임)
    const R = Math.max(8, Math.round(long * 0.01));
    const fr = clamp(Math.round(R / 8), 1, 8);
    const lw = Math.ceil(W / fr), lh = Math.ceil(H / fr);
    this.roiA = ensureTarget(gl, this.roiA, lw, lh, "r8");
    this.roiB = ensureTarget(gl, this.roiB, lw, lh, "r8");
    const hf = Math.ceil(fr / 2);
    this.morph(this.work.tex, this.thC, hf, 1 / W, 0, true);
    this.morph(this.thC.tex, this.thD, hf, 0, 1 / H, true);
    this.morph(this.thD.tex, this.roiA, 0, 0, 0, true);
    this.morph(this.roiA.tex, this.roiB, Math.round(R / fr), 1 / lw, 0, true);
    this.morph(this.roiB.tex, this.roiA, Math.round(R / fr), 0, 1 / lh, true);
    // 범위 끝에서 뚝 끊기지 않게 부드럽게
    this.blur(this.roiA.tex, this.roiB, R / 2 / fr, 1 / lw, 0);
    this.blur(this.roiB.tex, this.roiA, R / 2 / fr, 0, 1 / lh);
    const roi = this.roiA.tex;

    // 4) 피사체 기준 색: 꽉 찬 영역의 색만으로
    const prep = (a: Target, b: Target, sigma: number, f: number) => {
      bindTarget(gl, a);
      this.p.fringe.use().tex("uSrc", 0, this.src!).tex("uMask", 1, solid)
        .f2("uSrcTexel", 1 / W, 1 / H).f("uFactor", f).i("uInvert", 0).i("uPickBg", 0);
      this.drawQuad();
      this.blur(a.tex, b, sigma / f, 1 / a.w, 0);
      this.blur(b.tex, a, sigma / f, 0, 1 / a.h);
    };
    const sigma = Math.max(8, long * 0.012);
    const f = clamp(Math.floor(sigma / 3), 2, 16);
    this.refA = ensureTarget(gl, this.refA, Math.ceil(W / f), Math.ceil(H / f), fmt);
    this.refB = ensureTarget(gl, this.refB, Math.ceil(W / f), Math.ceil(H / f), fmt);
    prep(this.refA, this.refB, sigma, f);
    const sn = Math.max(2, long * 0.0015);
    const fn = clamp(Math.floor(sn / 1.5), 1, 8);
    this.rnA = ensureTarget(gl, this.rnA, Math.ceil(W / fn), Math.ceil(H / fn), fmt);
    this.rnB = ensureTarget(gl, this.rnB, Math.ceil(W / fn), Math.ceil(H / fn), fmt);
    prep(this.rnA, this.rnB, sn, fn);

    // 5) 투명도 다시 계산 (r: 최종 투명도, g: 색 계산용 투명도 — 두 채널만 쓰므로 RG8)
    this.calpha = ensureTarget(gl, this.calpha, W, H, "rg8");
    bindTarget(gl, this.calpha);
    this.p.calpha.use()
      .tex("uSrc", 0, this.src)
      .tex("uMask", 1, this.work.tex)
      .tex("uRef", 2, this.refA.tex)
      .tex("uMatteTex", 3, this.matteValid && this.mtA ? this.mtA.tex : this.clear)
      .tex("uRefNear", 4, this.rnA.tex)
      .tex("uSolid", 5, solid)
      .tex("uROI", 6, roi)
      .tex("uNearThick", 7, nearThick)
      .tex("uCoreTone", 8, coreTone)
      .tex("uWide", 9, wide)
      .tex("uBase", 10, this.getMask(doc.cutout.maskId))
      .i("uMatteLocal", this.matteLocal(doc) ? 1 : 0)
      .f3("uMatteColor", mr, mg, mb)
      .f3("uRefGlobal", g ? g[0] : 0, g ? g[1] : 0, g ? g[2] : 0)
      .i("uHasGlobal", g ? 1 : 0)
      .f("uAmt", doc.edge.colorAlpha / 100);
    this.drawQuad();
    this.calphaValid = true;
  }

  private morph(input: WebGLTexture, out: Target, radius: number, dx: number, dy: number, max: boolean) {
    bindTarget(this.gl, out);
    this.p.morph.use().tex("uTex", 0, input).f2("uDir", dx, dy).i("uRadius", radius).i("uMax", max ? 1 : 0);
    this.drawQuad();
  }

  /** 주변 배경색 텍스처를 배경색으로 쓸지 (투명 PNG 는 배경 정보가 없으므로 지정 색) */
  private matteLocal(doc: Doc) {
    return this.matteValid && doc.edge.matteSource === "auto" && doc.cutout?.source !== "alpha";
  }

  private globalFgKey = "";
  private globalFg: [number, number, number] | null = null;

  /** 피사체(확실히 불투명한 곳)의 평균 색 — 원래 마스크 기준으로 한 번만 계산 */
  private globalFgColor(doc: Doc): [number, number, number] | null {
    const key = doc.cutout?.maskId ?? "";
    if (key === this.globalFgKey) return this.globalFg;
    this.globalFgKey = key;
    this.globalFg = null;
    const src = resources.source;
    const mask = key ? resources.masks.get(key) : null;
    if (!src || !mask || mask.w !== src.w) return null;
    const step = Math.max(1, Math.floor(Math.sqrt((src.w * src.h) / 200_000)));
    const px: [number, number, number, number][] = [];
    for (let y = 0; y < src.h; y += step) {
      for (let x = 0; x < src.w; x += step) {
        const p = y * src.w + x;
        if (mask.data[p] < 235) continue;
        const r = src.data[p * 4], g = src.data[p * 4 + 1], b = src.data[p * 4 + 2];
        px.push([0.2126 * r + 0.7152 * g + 0.0722 * b, r, g, b]);
      }
    }
    if (px.length <= 30) return null;
    // 피사체 중 어두운 쪽 40% 의 평균 (근처에 굵은 부분이 없는 잔가지용 — 밝은 줄기 색이 섞이지 않게)
    px.sort((u, v) => u[0] - v[0]);
    const k = Math.max(10, Math.floor(px.length * 0.4));
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < k; i++) { r += px[i][1]; g += px[i][2]; b += px[i][3]; }
    this.globalFg = [r / k / 255, g / k / 255, b / k / 255];
    return this.globalFg;
  }

  /** 다듬기 전의 알파 (투명도 다시 계산을 켰으면 그 결과) */
  private alphaTex(): WebGLTexture {
    return this.calphaValid && this.calpha ? this.calpha.tex : this.work!.tex;
  }

  /** 경계 색 보정(cleanFg)에 필요한 텍스처·값 (합성과 화면 표시 공용) */
  private bindFg(p: Program, doc: Doc, hasMask: boolean) {
    const fg = hasMask ? this.getFg(doc.cutout!.fgId) : null;
    const [mr, mg, mb] = hexToRgb(doc.edge.matteColor);
    p.tex("uMaskRaw", 7, this.work ? this.alphaTex() : this.white)
      .tex("uFringe", 8, this.fringeValid && this.frA ? this.frA.tex : this.clear)
      .tex("uFg", 9, fg ?? this.src!)
      .tex("uMatteTex", 10, this.matteValid && this.mtA ? this.mtA.tex : this.clear)
      .tex("uFgRef", 11, this.calphaValid && this.rnA ? this.rnA.tex : this.clear)
      .i("uHasFgRef", this.calphaValid && this.rnA ? 1 : 0)
      .i("uMatteLocal", this.matteLocal(doc) ? 1 : 0)
      .i("uHasFg", fg ? 1 : 0)
      .i("uMatteOn", hasMask && doc.edge.deconMode === "matte" ? 1 : 0)
      .i("uHasFringe", hasMask && this.fringeValid ? 1 : 0)
      .i("uRawInvert", doc.invert ? 1 : 0)
      .f("uDecon", doc.edge.decontaminate / 100)
      .f3("uMatteColor", mr, mg, mb);
  }

  private updateShadow() {
    this.d.shadow = false;
    this.shadowValid = false;
    const doc = this.doc!;
    if (!doc.cutout || !doc.shadow.enabled || !this.maskOut) {
      this.drop("shA", "shB");
      return;
    }
    const gl = this.gl;
    const W = this.srcW, H = this.srcH;
    const sigma = 1 + (doc.shadow.blur / 100) * Math.max(W, H) * 0.035;
    const f = clamp(Math.floor(sigma / 3), 1, 16);
    const lw = Math.ceil(W / f), lh = Math.ceil(H / f);
    this.shA = ensureTarget(gl, this.shA, lw, lh, "r8");
    this.shB = ensureTarget(gl, this.shB, lw, lh, "r8");
    bindTarget(gl, this.shA);
    this.p.down.use().tex("uTex", 0, this.maskOut).f2("uSrcTexel", 1 / W, 1 / H).f("uFactor", f);
    this.drawQuad();
    this.blur(this.shA.tex, this.shB, sigma / f, 1 / lw, 0);
    this.blur(this.shB.tex, this.shA, sigma / f, 0, 1 / lh);
    this.shadowValid = true;
  }

  // -------------------------------------------------------------------------
  // 합성 (출력 좌표계)

  private packParams(doc: Doc, out: Float32Array) {
    packAdjust(doc.adjust.global, out, 0);
    packAdjust(doc.adjust.subject, out, 1);
    packAdjust(doc.adjust.background, out, 2);
  }

  private runComposite(target: Target, doc: Doc, params: Float32Array, lut: WebGLTexture) {
    const gl = this.gl;
    const [W, H] = outputSize(this.srcW, this.srcH, doc.orient);
    bindTarget(gl, target);
    gl.disable(gl.BLEND);
    const hasMask = !!doc.cutout && !!this.maskOut;
    let mode: number = hasMask ? BG_MODE[doc.bg.mode] : 0;
    let bgTex = this.clear;
    let xf: [number, number, number, number] = [1, 1, 0, 0];
    if (mode === 4) {
      const b = this.getBg(doc.bg.imageId);
      if (b) {
        bgTex = b.tex;
        xf = bgTransform(doc.crop, doc.bg.fit, W, H, b.w, b.h);
      } else mode = 1;
    }
    const crop = doc.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const sh = doc.shadow;
    const [br, bg, bb] = hexToRgb(doc.bg.color);
    const [sr, sg, sb] = hexToRgb(sh.color);
    const prog = this.p.comp.use();
    this.bindFg(prog, doc, hasMask);
    prog
      .tex("uSrc", 0, this.src!)
      .tex("uMask", 2, this.maskOut ?? this.white)
      .tex("uBgBlur", 3, this.bgBlurValid && this.bgA ? this.bgA.tex : this.clear)
      .tex("uShadow", 4, this.shadowValid && this.shA ? this.shA.tex : this.clear)
      .tex("uBgImg", 5, bgTex)
      .tex("uLut", 6, lut)
      .m3("uOrient", orientMatrix(doc.orient))
      .i("uHasMask", hasMask ? 1 : 0)
      .i("uBgMode", mode)
      .f3("uBgColor", br, bg, bb)
      .f4("uBgImgXf", ...xf)
      .i("uShadowOn", hasMask && sh.enabled && this.shadowValid ? 1 : 0)
      .f4("uShadowP", (sh.x / 100) * 0.2 * crop.w, (sh.y / 100) * 0.2 * crop.h, sh.opacity / 100, 0)
      .f3("uShadowColor", sr, sg, sb)
      .v4("uP", params);
    const ol = doc.outline;
    const [o1r, o1g, o1b] = hexToRgb(ol.color);
    const [o2r, o2g, o2b] = ol.fill === "gradient" ? hexToRgb(ol.color2) : [o1r, o1g, o1b];
    const a1 = ol.alpha1 / 100, a2 = ol.fill === "gradient" ? ol.alpha2 / 100 : a1;
    this.p.comp
      .tex("uDist", 12, this.distT ? this.distT.tex : this.clearU)
      .f("uDistF", this.distF)
      .f2("uSrcSize", this.srcW, this.srcH)
      .i("uOutlineOn", hasMask && ol.enabled && this.distT ? 1 : 0)
      .i("uOutlinePos", ol.position === "outside" ? 0 : ol.position === "center" ? 1 : 2)
      .f("uOutlineW", Math.max(0.5, ol.width))
      .f("uOutlineSoft", ol.soft)
      .f("uOutlineOpacity", ol.opacity / 100)
      .f4("uOutlineC1", o1r, o1g, o1b, a1)
      .f4("uOutlineC2", o2r, o2g, o2b, a2);
    this.drawQuad();
  }

  private updateComposite() {
    this.d.comp = false;
    const doc = this.doc!;
    const gl = this.gl;
    const [W, H] = outputSize(this.srcW, this.srcH, doc.orient);
    const prevComp = this.comp;
    this.comp = ensureTarget(gl, this.comp, W, H, "rgba8", true);
    if (this.comp !== prevComp) {
      // 새로 만든 밉맵 텍스처는 밉맵을 한 번 만들어 둬야 '완전한' 텍스처가 된다. 안 그러면 효과 단계가
      // 읽을 때 검게 나온다 (효과를 켠 채 90° 회전하거나 trim() 뒤 다시 계산할 때)
      gl.bindTexture(gl.TEXTURE_2D, this.comp.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    this.packParams(doc, this.params);
    this.runComposite(this.comp, doc, this.params, this.lut);

    const fx = doc.effects;
    if (fx.clarity || fx.sharpen || fx.vignette || fx.grain) {
      let blurTex = this.clear;
      if (fx.clarity) {
        const sigma = Math.max(2, Math.max(W, H) * 0.012);
        const f = clamp(Math.floor(sigma / 3), 1, 16);
        const lw = Math.ceil(W / f), lh = Math.ceil(H / f);
        this.clA = ensureTarget(gl, this.clA, lw, lh, "rgba8");
        this.clB = ensureTarget(gl, this.clB, lw, lh, "rgba8");
        bindTarget(gl, this.clA);
        this.p.down.use().tex("uTex", 0, this.comp.tex).f2("uSrcTexel", 1 / W, 1 / H).f("uFactor", f);
        this.drawQuad();
        this.blur(this.clA.tex, this.clB, sigma / f, 1 / lw, 0);
        this.blur(this.clB.tex, this.clA, sigma / f, 0, 1 / lh);
        blurTex = this.clA.tex;
      } else {
        this.drop("clA", "clB");
      }
      this.fxT = ensureTarget(gl, this.fxT, W, H, "rgba8", true);
      this.runEffects(this.fxT, this.comp.tex, blurTex, doc, fx, W, H);
      this.finalT = this.fxT;
    } else {
      this.finalT = this.comp;
      this.drop("fxT", "clA", "clB");
    }
    gl.bindTexture(gl.TEXTURE_2D, this.finalT.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  private runEffects(out: Target, comp: WebGLTexture, blurTex: WebGLTexture, doc: Doc, fx: Effects, W: number, H: number) {
    const crop = doc.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    bindTarget(this.gl, out);
    this.p.fx.use()
      .tex("uComp", 0, comp)
      .tex("uBlur", 1, blurTex)
      .f2("uTexel", 1 / out.w, 1 / out.h)
      .f2("uOutSize", W, H)
      .f4("uCrop", crop.x, crop.y, crop.w, crop.h)
      .f("uClarity", fx.clarity / 100)
      .f("uSharpen", fx.sharpen / 100)
      .f("uVignette", fx.vignette / 100)
      .f("uGrain", fx.grain / 100)
      .f("uGrainSize", Math.max(1, Math.max(W, H) / 1800));
    this.drawQuad();
  }

  // -------------------------------------------------------------------------
  // 화면 표시

  private drawDisplay() {
    const gl = this.gl;
    const v = this.view;
    if (!v) return;
    const canvas = gl.canvas as HTMLCanvasElement;
    if (canvas.width !== v.canvasW || canvas.height !== v.canvasH) {
      canvas.width = v.canvasW;
      canvas.height = v.canvasH;
    }
    bindTarget(gl, null, canvas.width, canvas.height);
    if (!this.src || !this.doc || !this.finalT) {
      gl.clearColor(...WORKSPACE, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const doc = this.doc;
    const [W, H] = outputSize(this.srcW, this.srcH, doc.orient);
    const hasMask = !!doc.cutout && !!this.maskOut;
    const shade = v.shade ?? [0, 0, -1, -1];
    const prog = this.p.display.use();
    this.bindFg(prog, doc, hasMask);
    prog
      .tex("uFinal", 0, this.finalT.tex)
      .tex("uSrc", 1, this.src)
      .tex("uMask", 3, this.maskOut ?? this.white)
      .m3("uOrient", orientMatrix(doc.orient))
      .f2("uCanvas", canvas.width, canvas.height)
      .f2("uOrigin", v.ox, v.oy)
      .f2("uOut", W, H)
      .f("uZoom", v.zoom)
      .f("uChecker", Math.round(8 * v.dpr))
      .f("uSplit", v.split)
      .f4("uView", ...v.viewRect)
      .f4("uShade", ...shade)
      .i("uMode", hasMask || v.mode === 5 ? v.mode : 0)
      .i("uHasMask", hasMask ? 1 : 0)
      .f3("uWork", ...WORKSPACE)
      .tex("uSel", 4, this.selTex ?? this.clear)
      .i("uHasSel", this.selTex ? 1 : 0)
      .f("uTime", this.time);
    this.drawQuad();
  }

  // -------------------------------------------------------------------------
  // 판독 (내보내기 / 히스토그램 / 필터 미리보기)

  /** 최종 결과의 일부를 읽는다 (출력 px, 위→아래 행 순서) */
  readOutput(r: { x: number; y: number; w: number; h: number }): ImageData | null {
    this.flush();
    if (!this.finalT) return null;
    const gl = this.gl;
    const buf = new Uint8ClampedArray(r.w * r.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.finalT.fbo);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return new ImageData(buf, r.w, r.h);
  }

  /** 디버그용: 내부 렌더 타깃을 읽는다 (?debug 로 열었을 때 콘솔에서 사용) */
  debugTarget(name: string) {
    this.flush();
    const t = (this as unknown as Record<string, Target | null>)[name];
    if (!t) return null;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    let data: Float32Array | Uint8Array | Uint32Array;
    if (t.fmt === "rgba16f" || t.fmt === "rgba32f") {
      data = new Float32Array(t.w * t.h * 4);
      gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.FLOAT, data);
    } else if (t.fmt === "rg16ui") {
      data = new Uint32Array(t.w * t.h * 4);
      gl.readPixels(0, 0, t.w, t.h, gl.RGBA_INTEGER, gl.UNSIGNED_INT, data);
    } else {
      data = new Uint8Array(t.w * t.h * 4);
      gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { w: t.w, h: t.h, fmt: t.fmt, data };
  }

  outputDims(): [number, number] | null {
    if (!this.doc || !this.src) return null;
    return outputSize(this.srcW, this.srcH, this.doc.orient);
  }

  /** 피사체(마스크)가 차지하는 영역 — 출력 px. 내보내기의 '피사체에 맞춰 자르기'용 */
  subjectBounds(region: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } | null {
    this.flush();
    if (!this.maskOut || !this.doc) return null;
    const gl = this.gl;
    const [W, H] = outputSize(this.srcW, this.srcH, this.doc.orient);
    // 1채널(R8)로 그려서 띠 단위로 읽는다 — 큰 사진에서도 임시 메모리가 작게 (예전: RGBA8 전체 + 전체 판독)
    const t = ensureTarget(gl, null, W, H, "r8");
    bindTarget(gl, t);
    this.p.orient.use().tex("uTex", 0, this.maskOut).m3("uOrient", orientMatrix(this.doc.orient));
    this.drawQuad();
    const band = Math.max(1, Math.min(region.h, Math.floor((8 << 20) / (region.w * 4)))); // 띠 하나 ≤ 8MB
    const buf = new Uint8Array(region.w * band * 4);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    let x0 = region.w, y0 = region.h, x1 = -1, y1 = -1;
    for (let b0 = 0; b0 < region.h; b0 += band) {
      const n = Math.min(band, region.h - b0);
      gl.readPixels(region.x, region.y + b0, region.w, n, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      for (let r = 0; r < n; r++) {
        const row = r * region.w * 4;
        const y = b0 + r;
        for (let x = 0; x < region.w; x++) {
          if (buf[row + x * 4] > 6) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            y1 = y;
          }
        }
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    deleteTarget(gl, t);
    if (x1 < 0) return null;
    const ol = this.doc.outline;
    const pad = ol.enabled ? Math.ceil(ol.position === "outside" ? ol.width + ol.soft : ol.position === "center" ? ol.width / 2 + ol.soft : 0) : 0;
    const bx0 = Math.max(0, x0 - pad), by0 = Math.max(0, y0 - pad);
    const bx1 = Math.min(region.w - 1, x1 + pad), by1 = Math.min(region.h - 1, y1 + pad);
    return { x: region.x + bx0, y: region.y + by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
  }

  readHistogram(crop: Rect | null): Histogram | null {
    if (!this.finalT || !this.doc) return null;
    const gl = this.gl;
    const [W, H] = outputSize(this.srcW, this.srcH, this.doc.orient);
    const s = Math.min(1, 320 / Math.max(W, H));
    const tw = Math.max(1, Math.round(W * s)), th = Math.max(1, Math.round(H * s));
    this.histT = ensureTarget(gl, this.histT, tw, th, "rgba8");
    bindTarget(gl, this.histT);
    this.p.copy.use().tex("uTex", 0, this.finalT.tex);
    this.drawQuad();
    const buf = new Uint8Array(tw * th * 4);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const x0 = Math.floor(c.x * tw), x1 = Math.ceil((c.x + c.w) * tw);
    const y0 = Math.floor(c.y * th), y1 = Math.ceil((c.y + c.h) * th);
    const h: Histogram = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256), max: 1 };
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * tw + x) * 4;
        if (buf[i + 3] < 128) continue;
        const r = buf[i], g = buf[i + 1], b = buf[i + 2];
        h.r[r]++;
        h.g[g]++;
        h.b[b]++;
        h.l[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
      }
    }
    // 양 끝(클리핑) 값이 그래프를 납작하게 만들지 않도록 끝값은 제외하고 최댓값 계산
    let mx = 1;
    for (let i = 1; i < 255; i++) mx = Math.max(mx, h.r[i], h.g[i], h.b[i]);
    h.max = mx;
    return h;
  }

  /** 필터 미리보기 썸네일 (현재 누끼/배경 상태에 보정 세트만 바꿔서) */
  renderPreviews(items: PreviewItem[], maxSide: number): ImageData[] {
    this.flush();
    if (!this.src || !this.doc) return [];
    const gl = this.gl;
    const doc = this.doc;
    const [W, H] = outputSize(this.srcW, this.srcH, doc.orient);
    const c = doc.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    // 자른 영역이 maxSide 에 맞도록 전체를 축소 렌더
    const s = maxSide / Math.max(c.w * W, c.h * H);
    const fw = Math.max(1, Math.round(W * s)), fh = Math.max(1, Math.round(H * s));
    this.small = ensureTarget(gl, this.small, fw, fh, "rgba8");
    this.smallFx = ensureTarget(gl, this.smallFx, fw, fh, "rgba8");
    const rx = Math.round(c.x * fw), ry = Math.round(c.y * fh);
    const rw = Math.max(1, Math.min(fw - rx, Math.round(c.w * fw))), rh = Math.max(1, Math.min(fh - ry, Math.round(c.h * fh)));
    const out: ImageData[] = [];
    for (const it of items) {
      this.writeLut(this.lutThumb, it.lut);
      this.runComposite(this.small, doc, it.params, this.lutThumb);
      let read = this.small;
      if (it.vignette) {
        this.runEffects(this.smallFx, this.small.tex, this.clear, doc,
          { clarity: 0, sharpen: 0, grain: 0, vignette: it.vignette }, W, H);
        read = this.smallFx;
      }
      const buf = new Uint8ClampedArray(rw * rh * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, read.fbo);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      gl.readPixels(rx, ry, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      out.push(new ImageData(buf, rw, rh));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** 현재 문서의 보정 파라미터/LUT 를 복사해 돌려준다 (미리보기용 기준값) */
  currentParams(): { params: Float32Array; lut: Uint8Array } {
    const params = new Float32Array(this.params.length);
    if (this.doc) this.packParams(this.doc, params);
    return { params, lut: this.lutData.slice() };
  }

  /** 메모리 정리 — 폴더 작업처럼 편집기를 한동안 쓰지 않을 때 부른다.
   *  다시 계산할 수 있는 중간 결과와 누끼·배경 이미지 텍스처를 모두 내려놓고, 화면에는 마지막 결과를 그대로 둔다.
   *  문서·화면·선택 영역이 바뀌거나 내보내기 등으로 결과가 필요해지면 그때 전부 다시 계산한다. */
  trim() {
    if (this.lost || !this.src || this.live) return;
    const gl = this.gl;
    const keep = this.finalT;
    for (const k of TARGETS) if (this[k] !== keep) this.drop(k);
    for (const t of this.maskTex.values()) gl.deleteTexture(t);
    for (const t of this.fgTex.values()) gl.deleteTexture(t);
    for (const t of this.bgTex.values()) gl.deleteTexture(t.tex);
    this.maskTex.clear();
    this.fgTex.clear();
    this.bgTex.clear();
    this.maskOut = null;
    this.distT = null;
    this.calphaValid = this.matteValid = this.fringeValid = this.bgBlurValid = this.shadowValid = false;
    this.applied = [];
    this.baseKey = null;
    this.d = { mask: true, matte: true, calpha: true, refine: true, fringe: true, outline: true, bgBlur: true, shadow: true, comp: true };
    clearTimeout(this.idleTimer);
    this.idleTimer = 0;
    this.trimmed = true;
  }

  /** GPU 메모리 사용량 추정 (MB) — 콘솔에서 __ms.getRenderer().memoryInfo() 로 확인 */
  memoryInfo() {
    const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;
    const targets: Record<string, number> = {};
    let total = 0;
    for (const k of TARGETS) {
      const t = this[k];
      if (!t) continue;
      const b = t.w * t.h * FMT_BYTES[t.fmt] * (t.mips ? 4 / 3 : 1);
      targets[k] = mb(b);
      total += b;
    }
    let tex = this.src ? this.srcW * this.srcH * 4 * (4 / 3) : 0;
    for (const id of this.maskTex.keys()) {
      const m = resources.masks.get(id);
      if (m) tex += m.w * m.h;
    }
    for (const id of this.fgTex.keys()) {
      const f = resources.fgs.get(id);
      if (f) tex += f.w * f.h * 4 * (4 / 3);
    }
    for (const b of this.bgTex.values()) tex += b.w * b.h * 4 * (4 / 3);
    if (this.selTex) tex += this.selSize[0] * this.selSize[1];
    return {
      totalMB: mb(total + tex),
      targetsMB: mb(total),
      texturesMB: mb(tex),
      targets,
      maskTextures: this.maskTex.size,
      fgTextures: this.fgTex.size,
      bgTextures: this.bgTex.size,
    };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.idleTimer);
    this.idleTimer = 0;
    this.resetImage();
  }
}

/** 배경 이미지를 보이는 영역(자른 영역)에 채우기/맞추기로 배치하는 uv 변환 */
function bgTransform(
  crop: Rect | null,
  fit: "cover" | "contain",
  W: number,
  H: number,
  bw: number,
  bh: number,
): [number, number, number, number] {
  const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const A = (c.w * W) / (c.h * H);
  const B = bw / bh;
  let sx = 1, sy = 1;
  if (fit === "cover") {
    if (A > B) sy = B / A;
    else sx = A / B;
  } else {
    if (A > B) sx = A / B;
    else sy = B / A;
  }
  // bu = 0.5 + ((u - c.x)/c.w - 0.5) * sx
  return [sx / c.w, sy / c.h, 0.5 - 0.5 * sx - (c.x * sx) / c.w, 0.5 - 0.5 * sy - (c.y * sy) / c.h];
}
