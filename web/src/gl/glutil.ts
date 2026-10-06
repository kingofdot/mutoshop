// WebGL2 보조 도구: 프로그램, 텍스처, 렌더 타깃(FBO)

export type Fmt = "r8" | "rgba8" | "rgba16f" | "rgba32f";

export class Program {
  readonly prog: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();

  constructor(private gl: WebGL2RenderingContext, vs: string, fs: string) {
    const v = shader(gl, gl.VERTEX_SHADER, vs);
    const f = shader(gl, gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram()!;
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error("셰이더 링크 실패: " + gl.getProgramInfoLog(p));
    }
    gl.deleteShader(v);
    gl.deleteShader(f);
    this.prog = p;
  }

  use() {
    this.gl.useProgram(this.prog);
    return this;
  }

  loc(name: string) {
    let l = this.locs.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.prog, name);
      this.locs.set(name, l);
    }
    return l;
  }

  i(name: string, v: number) {
    this.gl.uniform1i(this.loc(name), v);
    return this;
  }
  f(name: string, v: number) {
    this.gl.uniform1f(this.loc(name), v);
    return this;
  }
  f2(name: string, a: number, b: number) {
    this.gl.uniform2f(this.loc(name), a, b);
    return this;
  }
  f3(name: string, a: number, b: number, c: number) {
    this.gl.uniform3f(this.loc(name), a, b, c);
    return this;
  }
  f4(name: string, a: number, b: number, c: number, d: number) {
    this.gl.uniform4f(this.loc(name), a, b, c, d);
    return this;
  }
  v4(name: string, data: Float32Array) {
    this.gl.uniform4fv(this.loc(name), data);
    return this;
  }
  m3(name: string, data: Float32Array) {
    this.gl.uniformMatrix3fv(this.loc(name), false, data);
    return this;
  }
  /** 텍스처를 유닛에 바인딩하고 샘플러 유니폼을 지정 */
  tex(name: string, unit: number, t: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(this.loc(name), unit);
    return this;
  }
}

function shader(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const numbered = src.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
    console.error(numbered);
    throw new Error("셰이더 컴파일 실패: " + log);
  }
  return s;
}

function formatInfo(gl: WebGL2RenderingContext, fmt: Fmt) {
  switch (fmt) {
    case "r8":
      return { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE };
    case "rgba16f":
      return { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT };
    case "rgba32f":
      return { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT };
    default:
      return { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
  }
}

export function createTexture(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  fmt: Fmt,
  data: ArrayBufferView | null = null,
  mips = false,
): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  const { internal, format, type } = formatInfo(gl, fmt);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  setFilter(gl, mips);
  if (fmt === "rgba32f") {
    // 32비트 실수는 선형 필터가 기본 지원되지 않으므로(텍스처 불완전) 최근접으로
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (mips && data) gl.generateMipmap(gl.TEXTURE_2D);
  return t;
}

export function textureFromImage(gl: WebGL2RenderingContext, img: TexImageSource, mips = true): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
  setFilter(gl, mips);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (mips) gl.generateMipmap(gl.TEXTURE_2D);
  return t;
}

function setFilter(gl: WebGL2RenderingContext, mips: boolean) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

export interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
  fmt: Fmt;
  mips: boolean;
}

export function createTarget(gl: WebGL2RenderingContext, w: number, h: number, fmt: Fmt, mips = false): Target {
  const tex = createTexture(gl, w, h, fmt, null, mips);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    throw new Error(`렌더 타깃 생성 실패 (${fmt} ${w}x${h})`);
  }
  return { tex, fbo, w, h, fmt, mips };
}

/** 크기/형식이 같으면 그대로, 다르면 새로 만든다 */
export function ensureTarget(
  gl: WebGL2RenderingContext,
  t: Target | null,
  w: number,
  h: number,
  fmt: Fmt,
  mips = false,
): Target {
  if (t && t.w === w && t.h === h && t.fmt === fmt && t.mips === mips) return t;
  if (t) deleteTarget(gl, t);
  return createTarget(gl, w, h, fmt, mips);
}

export function deleteTarget(gl: WebGL2RenderingContext, t: Target | null) {
  if (!t) return;
  gl.deleteFramebuffer(t.fbo);
  gl.deleteTexture(t.tex);
}

export function bindTarget(gl: WebGL2RenderingContext, t: Target | null, w?: number, h?: number) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
  gl.viewport(0, 0, t ? t.w : w!, t ? t.h : h!);
}
