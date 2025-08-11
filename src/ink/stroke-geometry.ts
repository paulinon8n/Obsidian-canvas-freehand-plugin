// =============================================
// src/ink/stroke-geometry.ts — Passo 4
// Normalização por escala de view (zoom/DPR) + motor único de contorno
// Objetivo: preview e commit com MESMA espessura em qualquer zoom.
// - StrokeBuilder agora aceita space ('world'|'view') e viewScale.
// - Largura é definida em pixels de TELA e convertida p/ o espaço local.
// - Velocidade usada no modelo é medida em pixels de TELA (consistente).
// - Live/Commit consomem o MESMO polígono (buildOutlinePath).
// - Hooks opcionais para aplicar a mesma transformação de view no preview.
// =============================================

export type InputPoint = {
  x: number;
  y: number;
  t: number; // ms (performance.now())
  pressure?: number; // 0..1
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  fromPen?: boolean; // pointerType === 'pen'
};

export type StrokeParams = {
  baseSize: number; // espessura base em PX DE TELA
  color: string; // ex: '#222'
  composite?: GlobalCompositeOperation; // 'source-over' | 'destination-out' etc.
};

export type WidthModel = {
  gamma: number; // sensibilidade à pressão
  beta: number; // sensibilidade à velocidade
  k: number; // ganho de velocidade
  min?: number; // largura mínima (PX de tela, antes de converter)
};

export type StrokeSample = {
  x: number; // no espaço LOCAL (world ou view)
  y: number; // no espaço LOCAL (world ou view)
  t: number;
  v: number; // velocidade em PX DE TELA / ms (já normalizada)
  p: number; // pressão suavizada (0..1)
  w: number; // largura no ESPAÇO LOCAL (world ou view)
};

export type StrokeBuilderOptions = {
  baseSize: number; // PX de tela
  widthModel: WidthModel;
  space?: 'world' | 'view';
  viewScale?: number; // quanto 1 unidade local equivale em PX DE TELA
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

class EMA {
  private y?: number;
  constructor(private readonly alpha: number) {}
  next(x: number) { this.y = this.y === undefined ? x : this.y + this.alpha * (x - this.y); return this.y; }
  reset() { this.y = undefined; }
}

function distance(ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay; return Math.hypot(dx, dy);
}

function unitTangent(ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay; const h = Math.hypot(dx, dy) || 1e-6; return { tx: dx / h, ty: dy / h };
}

function pressureFromVelocity(v: number) { return clamp(1 / (1 + 12 * v), 0.15, 1); }

function widthFromPV(basePx: number, p: number, vPxPerMs: number, model: WidthModel) {
  const { gamma, beta, k } = model;
  const raw = basePx * Math.pow(0.55 + 0.45 * p, gamma) * Math.pow(1 / (1 + k * vPxPerMs), beta);
  const px = model.min ? Math.max(model.min, raw) : raw; // largura EM PX DE TELA
  return px;
}

// =============================================================
// StrokeBuilder — calcula samples com largura em espaço local
// mantendo espessura em PX DE TELA consistente via viewScale
// =============================================================
export class StrokeBuilder {
  private last?: InputPoint;
  private vEma = new EMA(0.35);
  private pEma = new EMA(0.25);
  private samples: StrokeSample[] = [];
  private dsPrevLocal = 1.0; // passo mínimo no espaço local

  private baseSizePx: number; // largura base em PX DE TELA
  private widthModel: WidthModel;
  private space: 'world' | 'view' = 'world';
  private viewScale = 1; // 1 unidade local = viewScale PX de tela

  // Construtor compatível com as versões anteriores
  constructor(baseSize: number, widthModel: WidthModel);
  constructor(opts: StrokeBuilderOptions);
  constructor(a: number | StrokeBuilderOptions, b?: WidthModel) {
    if (typeof a === 'number') {
      this.baseSizePx = a;
      this.widthModel = b as WidthModel;
    } else {
      this.baseSizePx = a.baseSize;
      this.widthModel = a.widthModel;
      this.space = a.space ?? 'world';
      this.viewScale = a.viewScale ?? 1;
    }
  }

  setViewScale(s: number) { this.viewScale = Math.max(1e-6, s); }
  setSpace(space: 'world' | 'view') { this.space = space; }
  getViewScale() { return this.viewScale; }
  getSpace() { return this.space; }

  reset() { this.last = undefined; this.samples = []; this.vEma.reset(); this.pEma.reset(); this.dsPrevLocal = 1.0; }

  /** Adiciona um ponto bruto; retorna samples **novos** (0..N). */
  add(raw: InputPoint): StrokeSample[] {
    const out: StrokeSample[] = [];
    const prev = this.last; this.last = raw;

    const toPx = (dLocal: number) => dLocal * this.viewScale;   // local → px de tela
    const toLocal = (px: number) => px / this.viewScale;         // px de tela → local

    if (!prev) {
      const p = raw.pressure ?? pressureFromVelocity(0);
      const pHat = this.pEma.next(p);
      const vPx = this.vEma.next(0); // px/ms
      // largura em PX de tela → converte para espaço local
      const wPx = widthFromPV(this.baseSizePx, pHat, vPx, this.widthModel);
      const wLocal = toLocal(wPx);
      // passo mínimo (em local) proporcional à largura local
      this.dsPrevLocal = clamp(wLocal * 0.35, 0.6, 2.0);
      const s: StrokeSample = { x: raw.x, y: raw.y, t: raw.t, v: vPx, p: pHat, w: wLocal };
      this.samples.push(s); out.push(s); return out;
    }

    const dt = Math.max(1, raw.t - prev.t);
    const distLocal = distance(prev.x, prev.y, raw.x, raw.y);
    const vPx = this.vEma.next(toPx(distLocal) / dt); // velocidade em PX/ms (CONSISTENTE)
    const p = raw.pressure ?? pressureFromVelocity(vPx);
    const pHat = this.pEma.next(p);
    const wPx = widthFromPV(this.baseSizePx, pHat, vPx, this.widthModel);
    const wLocal = toLocal(wPx);

    // espaçamento mínimo em LOCAL, mas dependente da largura local atual
    const dsLocal = clamp(wLocal * 0.35, 0.6, 2.0);
    const need = distLocal >= Math.min(dsLocal, this.dsPrevLocal * 1.5);

    if (need) {
      const s: StrokeSample = { x: raw.x, y: raw.y, t: raw.t, v: vPx, p: pHat, w: wLocal };
      this.samples.push(s); out.push(s); this.dsPrevLocal = dsLocal;
    }
    return out;
  }

  getAll(): StrokeSample[] { return this.samples; }
}

// -------------------------------------------------------------
// Motor único: constrói o polígono (envelope) do traço
// (cadeia esquerda + cadeia direita invertida). Caps são desenhados à parte.
// -------------------------------------------------------------
export function buildOutlinePath(samples: StrokeSample[]): Path2D | null {
  if (!samples || samples.length < 2) return null;
  const left: Array<{ x: number; y: number }> = [];
  const right: Array<{ x: number; y: number }> = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const dx = b.x - a.x, dy = b.y - a.y; const h = Math.hypot(dx, dy) || 1e-6;
    const nx = -dy / h, ny = dx / h; const halfA = a.w / 2, halfB = b.w / 2;
    left.push({ x: a.x - nx * halfA, y: a.y - ny * halfA });
    right.push({ x: a.x + nx * halfA, y: a.y + ny * halfA });
    if (i === samples.length - 1) {
      left.push({ x: b.x - nx * halfB, y: b.y - ny * halfB });
      right.push({ x: b.x + nx * halfB, y: b.y + ny * halfB });
    }
  }
  if (left.length < 2 || right.length < 2) return null;
  const path = new Path2D();
  path.moveTo(left[0].x, left[0].y);
  for (let i = 1; i < left.length; i++) path.lineTo(left[i].x, left[i].y);
  for (let i = right.length - 1; i >= 0; i--) path.lineTo(right[i].x, right[i].y);
  path.closePath();
  return path;
}

// -------------------------------------------------------------
// LiveRenderer2D: modo 'full' (polígono idêntico ao commit) ou 'incremental'
// Suporta hook opcional setTransform para aplicar a MESMA view transform do Canvas.
// -------------------------------------------------------------
export type LiveRendererMode = 'full' | 'incremental';

export class LiveRenderer2D {
  private lastPt?: StrokeSample;      // usado no modo incremental
  private firstPt?: StrokeSample;     // para cap inicial
  private prevTx = 0;                 // incremental
  private prevTy = 0;                 // incremental
  private hasPrevDir = false;         // incremental
  private samples: StrokeSample[] = [];// usado no modo 'full'

  private readonly mode: LiveRendererMode;
  private readonly bleedTangent: number;
  private readonly onBeforeRedraw?: () => void; // ex.: limpar overlay
  private readonly setTransform?: (ctx: CanvasRenderingContext2D) => void; // aplicar MESMA matriz

  constructor(
    private ctx: CanvasRenderingContext2D,
    private color: string,
    private composite: GlobalCompositeOperation = 'source-over',
    opts?: { mode?: LiveRendererMode; bleedTangent?: number; onBeforeRedraw?: () => void; setTransform?: (ctx: CanvasRenderingContext2D) => void },
  ) {
    this.mode = opts?.mode ?? 'full';
    this.bleedTangent = opts?.bleedTangent ?? 0.5;
    this.onBeforeRedraw = opts?.onBeforeRedraw;
    this.setTransform = opts?.setTransform;
  }

  private applyTransform() { if (this.setTransform) this.setTransform(this.ctx); }

  beginStroke() {
    this.ctx.save();
    this.applyTransform();
    this.ctx.globalCompositeOperation = this.composite;
    this.ctx.fillStyle = this.color;
    this.lastPt = undefined; this.firstPt = undefined; this.prevTx = 0; this.prevTy = 0; this.hasPrevDir = false; this.samples = [];
  }

  addSample(s: StrokeSample) {
    if (this.mode === 'full') return this.addSampleFull(s);
    else return this.addSampleIncremental(s);
  }

  private addSampleFull(s: StrokeSample) {
    this.samples.push(s);
    if (!this.firstPt) this.firstPt = s;
    if (this.onBeforeRedraw) this.onBeforeRedraw();
    this.applyTransform();

    // Caps + corpo (polígono)
    if (this.firstPt) { this.ctx.beginPath(); this.ctx.arc(this.firstPt.x, this.firstPt.y, this.firstPt.w / 2, 0, Math.PI * 2); this.ctx.fill(); }
    const path = buildOutlinePath(this.samples); if (path) this.ctx.fill(path);
    const last = this.samples[this.samples.length - 1];
    if (last) { this.ctx.beginPath(); this.ctx.arc(last.x, last.y, last.w / 2, 0, Math.PI * 2); this.ctx.fill(); }
  }

  private addSampleIncremental(s: StrokeSample) {
    const prev = this.lastPt;
    if (!prev) {
      this.applyTransform();
      this.ctx.beginPath(); this.ctx.arc(s.x, s.y, s.w / 2, 0, Math.PI * 2); this.ctx.fill();
      this.firstPt = s; this.lastPt = s; this.hasPrevDir = false; return;
    }

    const { tx, ty } = unitTangent(prev.x, prev.y, s.x, s.y); const nx = -ty, ny = tx;
    const halfPrev = prev.w / 2, halfCur = s.w / 2;

    if (this.hasPrevDir) {
      this.applyTransform();
      const nPrevX = -this.prevTy, nPrevY = this.prevTx;
      const prevR_prev = { x: prev.x + nPrevX * halfPrev, y: prev.y + nPrevY * halfPrev };
      const prevR_cur  = { x: prev.x + nx     * halfPrev, y: prev.y + ny     * halfPrev };
      const prevL_prev = { x: prev.x - nPrevX * halfPrev, y: prev.y - nPrevY * halfPrev };
      const prevL_cur  = { x: prev.x - nx     * halfPrev, y: prev.y - ny     * halfPrev };
      const ex = tx * this.bleedTangent, ey = ty * this.bleedTangent;
      this.ctx.beginPath(); this.ctx.moveTo(prevR_prev.x - ex, prevR_prev.y - ey); this.ctx.lineTo(prevR_cur.x + ex, prevR_cur.y + ey); this.ctx.lineTo(prev.x, prev.y); this.ctx.closePath(); this.ctx.fill();
      this.ctx.beginPath(); this.ctx.moveTo(prevL_prev.x - ex, prevL_prev.y - ey); this.ctx.lineTo(prevL_cur.x + ex, prevL_cur.y + ey); this.ctx.lineTo(prev.x, prev.y); this.ctx.closePath(); this.ctx.fill();
    }

    this.applyTransform();
    const prevL = { x: prev.x - nx * halfPrev, y: prev.y - ny * halfPrev };
    const prevR = { x: prev.x + nx * halfPrev, y: prev.y + ny * halfPrev };
    const curL  = { x: s.x    - nx * halfCur,  y: s.y    - ny * halfCur };
    const curR  = { x: s.x    + nx * halfCur,  y: s.y    + ny * halfCur };
    const ex = tx * this.bleedTangent, ey = ty * this.bleedTangent;
    this.ctx.beginPath();
    this.ctx.moveTo(prevL.x - ex, prevL.y - ey);
    this.ctx.lineTo(prevR.x - ex, prevR.y - ey);
    this.ctx.lineTo(curR.x + ex,  curR.y + ey);
    this.ctx.lineTo(curL.x + ex,  curL.y + ey);
    this.ctx.closePath(); this.ctx.fill();

    this.prevTx = tx; this.prevTy = ty; this.hasPrevDir = true; this.lastPt = s;
  }

  endStroke() {
    const last = this.mode === 'full' ? this.samples[this.samples.length - 1] : this.lastPt;
    if (last) { this.applyTransform(); this.ctx.beginPath(); this.ctx.arc(last.x, last.y, last.w / 2, 0, Math.PI * 2); this.ctx.fill(); }
    this.ctx.restore();
  }
}

// -------------------------------------------------------------
// CommitRenderer2D: usa o mesmo buildOutlinePath do modo 'full'
// e permite aplicar a mesma transformação de view
// -------------------------------------------------------------
export class CommitRenderer2D {
  constructor(private ctx: CanvasRenderingContext2D, private setTransform?: (ctx: CanvasRenderingContext2D) => void) {}

  private applyTransform() { if (this.setTransform) this.setTransform(this.ctx); }

  drawStroke(samples: StrokeSample[], params: StrokeParams) {
    if (samples.length === 0) return; const ctx = this.ctx;
    ctx.save(); this.applyTransform(); ctx.globalCompositeOperation = params.composite ?? 'source-over'; ctx.fillStyle = params.color;

    // cap inicial
    const s0 = samples[0]; ctx.beginPath(); ctx.arc(s0.x, s0.y, s0.w / 2, 0, Math.PI * 2); ctx.fill();

    const path = buildOutlinePath(samples); if (path) ctx.fill(path);

    // cap final
    const sl = samples[samples.length - 1]; ctx.beginPath(); ctx.arc(sl.x, sl.y, sl.w / 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}
