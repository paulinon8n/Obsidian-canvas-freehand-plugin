// =============================================
// src/ink/stroke-geometry.ts
// Unifica a geometria do traço (live == commit) com Canvas 2D
// - StrokeBuilder: resampling + EMA + função única de largura
// - LiveRenderer2D: trapezoides incrementais + caps (O(1) por sample)
// - CommitRenderer2D: polígono único a partir dos samples
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
  baseSize: number;           // espessura base
  color: string;              // ex: '#222'
  composite?: GlobalCompositeOperation; // 'source-over' | 'destination-out' etc.
};

export type WidthModel = {
  gamma: number;  // sensibilidade à pressão
  beta: number;   // sensibilidade à velocidade
  k: number;      // ganho de velocidade
  min?: number;   // largura mínima
};

export type StrokeSample = {
  x: number;
  y: number;
  t: number;
  v: number; // velocidade (px/ms) suavizada
  p: number; // pressão suavizada (0..1)
  w: number; // largura calculada
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

function widthFromPV(base: number, p: number, v: number, model: WidthModel) {
  const { gamma, beta, k } = model;
  const w = base * Math.pow(0.55 + 0.45 * p, gamma) * Math.pow(1 / (1 + k * v), beta);
  return model.min ? Math.max(model.min, w) : w;
}

export class StrokeBuilder {
  private last?: InputPoint;
  private vEma = new EMA(0.35);
  private pEma = new EMA(0.25);
  private samples: StrokeSample[] = [];
  private dsPrev = 1.0;

  constructor(private readonly baseSize: number, private readonly widthModel: WidthModel) {}

  reset() { this.last = undefined; this.samples = []; this.vEma.reset(); this.pEma.reset(); this.dsPrev = 1.0; }

  /** Adiciona um ponto bruto; retorna samples **novos** (0..N). */
  add(raw: InputPoint): StrokeSample[] {
    const out: StrokeSample[] = [];
    const prev = this.last; this.last = raw;
    if (!prev) {
      const p = raw.pressure ?? pressureFromVelocity(0);
      const pHat = this.pEma.next(p); const vHat = this.vEma.next(0);
      const w = widthFromPV(this.baseSize, pHat, vHat, this.widthModel);
      this.dsPrev = clamp(w * 0.35, 0.6, 2.0);
      const s: StrokeSample = { x: raw.x, y: raw.y, t: raw.t, v: vHat, p: pHat, w };
      this.samples.push(s); out.push(s); return out;
    }
    const dt = Math.max(1, raw.t - prev.t);
    const dist = distance(prev.x, prev.y, raw.x, raw.y);
    const v = dist / dt; const vHat = this.vEma.next(v);
    const p = raw.pressure ?? pressureFromVelocity(v); const pHat = this.pEma.next(p);
    const w = widthFromPV(this.baseSize, pHat, vHat, this.widthModel);
    const ds = clamp(w * 0.35, 0.6, 2.0);
    const need = dist >= Math.min(ds, this.dsPrev * 1.5);
    if (need) {
      const s: StrokeSample = { x: raw.x, y: raw.y, t: raw.t, v: vHat, p: pHat, w };
      this.samples.push(s); out.push(s); this.dsPrev = ds;
    }
    return out;
  }

  getAll(): StrokeSample[] { return this.samples; }
}

export class LiveRenderer2D {
  private lastPt?: StrokeSample;
  constructor(private ctx: CanvasRenderingContext2D, private color: string, private composite: GlobalCompositeOperation = 'source-over') {}
  beginStroke() { this.ctx.save(); this.ctx.globalCompositeOperation = this.composite; this.ctx.fillStyle = this.color; this.lastPt = undefined; }
  addSample(s: StrokeSample) {
    const prev = this.lastPt;
    if (!prev) { this.ctx.beginPath(); this.ctx.arc(s.x, s.y, s.w / 2, 0, Math.PI * 2); this.ctx.fill(); this.lastPt = s; return; }
    const { tx, ty } = unitTangent(prev.x, prev.y, s.x, s.y); const nx = -ty, ny = tx;
    const halfPrev = prev.w / 2, halfCur = s.w / 2;
    const prevL = { x: prev.x - nx * halfPrev, y: prev.y - ny * halfPrev };
    const prevR = { x: prev.x + nx * halfPrev, y: prev.y + ny * halfPrev };
    const curL  = { x: s.x    - nx * halfCur,  y: s.y    - ny * halfCur };
    const curR  = { x: s.x    + nx * halfCur,  y: s.y    + ny * halfCur };
    this.ctx.beginPath();
    this.ctx.moveTo(prevL.x, prevL.y); this.ctx.lineTo(prevR.x, prevR.y); this.ctx.lineTo(curR.x,  curR.y); this.ctx.lineTo(curL.x,  curL.y);
    this.ctx.closePath(); this.ctx.fill();
    this.ctx.beginPath(); this.ctx.arc(s.x, s.y, halfCur, 0, Math.PI * 2); this.ctx.fill();
    this.lastPt = s;
  }
  endStroke() { this.ctx.restore(); }
}

export class CommitRenderer2D {
  constructor(private ctx: CanvasRenderingContext2D) {}
  drawStroke(samples: StrokeSample[], params: StrokeParams) {
    if (samples.length === 0) return; const ctx = this.ctx;
    ctx.save(); ctx.globalCompositeOperation = params.composite ?? 'source-over'; ctx.fillStyle = params.color;
    // cap inicial
    const s0 = samples[0]; ctx.beginPath(); ctx.arc(s0.x, s0.y, s0.w / 2, 0, Math.PI * 2); ctx.fill();
    const left: Array<{ x: number; y: number }> = []; const right: Array<{ x: number; y: number }> = [];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i]; const dx = b.x - a.x, dy = b.y - a.y; const h = Math.hypot(dx, dy) || 1e-6;
      const nx = -dy / h, ny = dx / h; const halfA = a.w / 2, halfB = b.w / 2;
      left.push({ x: a.x - nx * halfA, y: a.y - ny * halfA }); right.push({ x: a.x + nx * halfA, y: a.y + ny * halfA });
      if (i === samples.length - 1) { left.push({ x: b.x - nx * halfB, y: b.y - ny * halfB }); right.push({ x: b.x + nx * halfB, y: b.y + ny * halfB }); }
    }
    if (left.length >= 2 && right.length >= 2) {
      ctx.beginPath(); ctx.moveTo(left[0].x, left[0].y); for (let i = 1; i < left.length; i++) ctx.lineTo(left[i].x, left[i].y);
      for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y); ctx.closePath(); ctx.fill();
    }
    const sl = samples[samples.length - 1]; ctx.beginPath(); ctx.arc(sl.x, sl.y, sl.w / 2, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
}
