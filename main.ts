// main.ts — v0.3.18-alpha.6
// Preview = perfect-freehand (paridade com commit) + Janela deslizante + Predictive head (lead)
// - Visual idêntico ao commit
// - Custo por frame limitado por TAIL (últimos pontos)
// - Predição de 1 ponto à frente no preview para reduzir gap caneta→traço

import { Plugin, WorkspaceLeaf, ItemView } from 'obsidian';
import { getStroke } from 'perfect-freehand';

interface StrokePoint { x: number; y: number; pressure: number; tiltX?: number; tiltY?: number; twist?: number; t?: number }
interface Stroke { points: StrokePoint[]; color: string; thickness: number; element?: SVGPathElement; }

type OffscreenType = OffscreenCanvas | HTMLCanvasElement;

const isAppleTouchDevice = () => {
  const isMacLike = navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1;
  const appleVendor = /Apple/i.test(navigator.vendor || '');
  const hasTouch = 'ontouchstart' in window;
  return (isMacLike || (appleVendor && hasTouch));
};

const DOM_ID = {
  HOST: 'canvas-freehand-overlay-host',
  SVG: 'canvas-freehand-drawing-layer',
  WORLD: 'canvas-freehand-world',
  CAN_STATIC: 'canvas-freehand-static',
  CAN_LIVE: 'canvas-freehand-live',
};

export default class CanvasFreehandPlugin extends Plugin {
  private isDrawingEnabled = false;
  private isDrawing = false;
  private currentStroke: Stroke | null = null;
  private strokes: Stroke[] = [];

  private overlayHosts: Map<WorkspaceLeaf, HTMLDivElement> = new Map();
  private actionButtons: Map<WorkspaceLeaf, HTMLElement> = new Map();
  private resizeObservers: Map<WorkspaceLeaf, ResizeObserver> = new Map();
  private transformObservers: Map<WorkspaceLeaf, MutationObserver> = new Map();

  // SVG (desktop)
  private drawingLayers: Map<WorkspaceLeaf, SVGSVGElement> = new Map();
  private worldGroups: Map<WorkspaceLeaf, SVGGElement> = new Map();

  // Canvas 2D (iPad)
  private canvasStatic: Map<WorkspaceLeaf, HTMLCanvasElement> = new Map();
  private canvasLive: Map<WorkspaceLeaf, HTMLCanvasElement> = new Map();
  private liveQueue: Map<WorkspaceLeaf, StrokePoint[]> = new Map();
  private lastLivePoint: Map<WorkspaceLeaf, StrokePoint | null> = new Map();
  private rafHandle: Map<WorkspaceLeaf, number | null> = new Map();
  private worldMatrix: Map<WorkspaceLeaf, DOMMatrix> = new Map();
  private strokesByLeaf: Map<WorkspaceLeaf, Stroke[]> = new Map();
  private redrawPending: Map<WorkspaceLeaf, number | null> = new Map();

  // Windowed preview
  private offscreenByLeaf: Map<WorkspaceLeaf, OffscreenType> = new Map();
  private frozenUntilByLeaf: Map<WorkspaceLeaf, number> = new Map();
  private lastFreezeTs: Map<WorkspaceLeaf, number> = new Map();
  private readonly TAIL = 384;         // nº de pontos na cauda
  private readonly OVERLAP = 12;       // overlap entre cache e cauda
  private readonly FREEZE_EVERY_MS = 24;// freq. máx. de congelamento

  // Predictive head (lead)
  private readonly LEAD_MS = 12;       // quanto "à frente" prever (ms)
  private readonly LEAD_MAX_SCR = 24;  // limite do avanço em pixels de tela

  async onload() {
    this.app.workspace.onLayoutReady(() => this.handleLayoutChange());
    this.registerEvent(this.app.workspace.on('layout-change', this.handleLayoutChange.bind(this)));
    this.registerEvent(this.app.workspace.on('active-leaf-change', this.handleActiveLeafChange.bind(this)));
  }
  onunload() { Array.from(this.overlayHosts.keys()).forEach((leaf) => this.removeDrawingUI(leaf)); }

  private handleLayoutChange() {
    this.app.workspace.getLeavesOfType('canvas').forEach((leaf) => { if (!this.overlayHosts.has(leaf)) this.setupDrawingUI(leaf); });
  }
  private handleActiveLeafChange(leaf: WorkspaceLeaf | null) {
    if (leaf && leaf.view.getViewType() === 'canvas') { if (!this.overlayHosts.has(leaf)) this.setupDrawingUI(leaf); }
  }

  private setupDrawingUI(leaf: WorkspaceLeaf) {
    const viewContainer = leaf.view.containerEl;
    const wrapper = viewContainer.querySelector('.canvas-wrapper') as HTMLElement | null;
    const canvasEl = viewContainer.querySelector('.canvas') as HTMLElement | null;
    if (!wrapper || !canvasEl) return;

    const host = document.createElement('div'); host.id = DOM_ID.HOST;
    const cs = getComputedStyle(wrapper);
    if (!['relative', 'absolute', 'fixed'].includes(cs.position)) wrapper.style.position = 'relative';
    Object.assign(host.style, { position: 'absolute', inset: '0', zIndex: '9999', pointerEvents: 'none', touchAction: 'none' } as any);
    wrapper.appendChild(host);
    this.overlayHosts.set(leaf, host);

    const syncMatrix = () => {
      const t = canvasEl.style.transform; let m = new DOMMatrix();
      try { m = t && t !== 'none' ? new DOMMatrix(t) : new DOMMatrix(); } catch {}
      this.worldMatrix.set(leaf, m);
      const g = this.worldGroups.get(leaf); if (g) g.setAttribute('transform', `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);
      if (this.canvasStatic.has(leaf)) this.scheduleRedraw(leaf);
      if (!this.isDrawing) { this.clearLiveCanvas(leaf); this.clearOffscreen(leaf); }
    };
    syncMatrix();
    const mo = new MutationObserver(syncMatrix);
    mo.observe(canvasEl, { attributes: true, attributeFilter: ['style'] });
    this.transformObservers.set(leaf, mo);

    const updateViewport = () => {
      const w = host.clientWidth, h = host.clientHeight;
      const svg = this.drawingLayers.get(leaf);
      if (svg) { svg.setAttribute('width', String(w)); svg.setAttribute('height', String(h)); svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('preserveAspectRatio', 'none'); }
      const dpr = window.devicePixelRatio || 1;
      const canS = this.canvasStatic.get(leaf), canL = this.canvasLive.get(leaf);
      for (const can of [canS, canL]) if (can) { can.style.width = `${w}px`; can.style.height = `${h}px`; can.width = Math.max(1, Math.floor(w * dpr)); can.height = Math.max(1, Math.floor(h * dpr)); }
      if (this.canvasStatic.has(leaf)) this.scheduleRedraw(leaf);
      this.clearOffscreen(leaf); // invalida cache ao mudar viewport
    };
    const ro = new ResizeObserver(updateViewport); ro.observe(host); this.resizeObservers.set(leaf, ro);

    if (isAppleTouchDevice()) { this.setupCanvas2D(leaf, host); } else { this.setupSVG(leaf, host); }

    const drawBtn = (leaf.view as ItemView).addAction('pencil', 'Toggle Drawing', () => this.toggleDrawingMode(leaf));
    this.actionButtons.set(leaf, drawBtn);

    if (!this.strokesByLeaf.has(leaf)) this.strokesByLeaf.set(leaf, []);
  }

  // ===== Helpers =====
  private getActiveSurface(leaf: WorkspaceLeaf): HTMLElement | null {
    return (this.drawingLayers.get(leaf) as unknown as HTMLElement) || this.canvasLive.get(leaf) || null;
  }
  private setSurfaceActive(leaf: WorkspaceLeaf, active: boolean) {
    const target = this.getActiveSurface(leaf); if (!target) return;
    target.style.pointerEvents = active ? 'auto' : 'none';
    target.style.cursor = active ? 'crosshair' : 'default';
    (target.style as any).touchAction = active ? 'none' : 'auto'; // iPad: suprime gestos do SO quando desenhando
  }
  private getViewScale(leaf: WorkspaceLeaf): number {
    const m = this.worldMatrix.get(leaf) ?? new DOMMatrix();
    const sx = Math.hypot(m.a, m.b) || 1; // px por unidade de mundo (assumindo escala uniforme)
    return sx;
  }

  // ===== SVG (desktop) =====
  private setupSVG(leaf: WorkspaceLeaf, host: HTMLElement) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add(DOM_ID.SVG);
    svg.setAttribute('preserveAspectRatio', 'none');
    Object.assign(svg.style, { position: 'absolute', inset: '0', pointerEvents: 'none', cursor: 'default' } as any);
    host.appendChild(svg); this.drawingLayers.set(leaf, svg);

    const world = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    world.id = DOM_ID.WORLD; svg.appendChild(world); this.worldGroups.set(leaf, world);

    this.registerDomEvent(svg, 'pointerdown', (evt) => this.handlePointerDown(evt, leaf, svg));
    this.registerDomEvent(svg, 'pointermove', (evt) => this.handlePointerMove(evt, leaf, svg));
    this.registerDomEvent(window, 'pointerup', () => this.handlePointerUp(leaf));
    this.registerDomEvent(window, 'pointercancel', () => this.handlePointerCancel(leaf));
  }

  // ===== Canvas 2D (iPad) =====
  private setupCanvas2D(leaf: WorkspaceLeaf, host: HTMLElement) {
    const canStatic = document.createElement('canvas'); canStatic.id = DOM_ID.CAN_STATIC; Object.assign(canStatic.style, { position: 'absolute', inset: '0' });
    const canLive = document.createElement('canvas');   canLive.id   = DOM_ID.CAN_LIVE;   Object.assign(canLive.style,   { position: 'absolute', inset: '0', pointerEvents: 'none', cursor: 'default' } as any);
    host.appendChild(canStatic); host.appendChild(canLive);
    this.canvasStatic.set(leaf, canStatic); this.canvasLive.set(leaf, canLive);

    this.registerDomEvent(canLive, 'pointerdown', (evt) => this.handlePointerDown(evt, leaf, canLive));
    this.registerDomEvent(canLive, 'pointermove', (evt) => this.handlePointerMove(evt, leaf, canLive));
    this.registerDomEvent(window, 'pointerup', () => this.handlePointerUp(leaf));
    this.registerDomEvent(window, 'pointercancel', () => this.handlePointerCancel(leaf));

    this.liveQueue.set(leaf, []); this.rafHandle.set(leaf, null); this.lastLivePoint.set(leaf, null);
    const ev = new Event('resize'); window.dispatchEvent(ev);
  }

  private toggleDrawingMode(leaf: WorkspaceLeaf) {
    const wasEnabled = this.isDrawingEnabled;
    this.isDrawingEnabled = !this.isDrawingEnabled;
    this.setSurfaceActive(leaf, this.isDrawingEnabled);
    const btn = this.actionButtons.get(leaf); btn?.classList.toggle('is-active', this.isDrawingEnabled);

    // Ao desligar: commit seguro do traço atual + limpeza do preview; não toca no buffer estático
    if (wasEnabled && !this.isDrawingEnabled) {
      if (this.currentStroke && this.currentStroke.points.length > 1) {
        if (this.canvasStatic.has(leaf)) {
          this.commitCanvas2D(leaf, this.currentStroke);
          const arr = this.strokesByLeaf.get(leaf) ?? []; arr.push(this.currentStroke); this.strokesByLeaf.set(leaf, arr);
        }
        this.strokes.push(this.currentStroke);
      }
      this.clearLiveCanvas(leaf);
      this.clearOffscreen(leaf);
      this.isDrawing = false; this.currentStroke = null; this.lastLivePoint.set(leaf, null);
      this.frozenUntilByLeaf.set(leaf, 0); this.lastFreezeTs.set(leaf, 0);
    }
  }

  private getWorldPoint(evt: PointerEvent, leaf: WorkspaceLeaf, surface: HTMLElement): StrokePoint {
    const rect = surface.getBoundingClientRect();
    const sx = evt.clientX - rect.left; const sy = evt.clientY - rect.top;
    const m = this.worldMatrix.get(leaf) ?? new DOMMatrix(); let inv = new DOMMatrix(); try { inv = m.inverse(); } catch {}
    const p = new DOMPoint(sx, sy).matrixTransform(inv);
    return { x: p.x, y: p.y, pressure: evt.pressure ?? 0.5, tiltX: evt.tiltX, tiltY: evt.tiltY, twist: (evt as any).twist, t: evt.timeStamp };
  }

  private handlePointerDown(evt: PointerEvent, leaf: WorkspaceLeaf, surface: HTMLElement) {
    if (!this.isDrawingEnabled) return;
    const isPen = evt.pointerType === 'pen' || (isAppleTouchDevice() && evt.pointerType === 'touch');
    if (!isPen && evt.pointerType !== 'mouse') return;

    surface.setPointerCapture?.(evt.pointerId);
    evt.preventDefault(); evt.stopPropagation();
    this.isDrawing = true;

    const p = this.getWorldPoint(evt, leaf, surface);
    this.currentStroke = { points: [p], color: '#000000', thickness: 8 };

    // reset janela
    this.frozenUntilByLeaf.set(leaf, 0);
    this.lastFreezeTs.set(leaf, performance.now());
    this.clearOffscreen(leaf);

    if (this.canvasLive.has(leaf)) this.ensureRAF(leaf);
    this.lastLivePoint.set(leaf, p);
  }

  private handlePointerMove(evt: PointerEvent, leaf: WorkspaceLeaf, surface: HTMLElement) {
    if (!this.isDrawingEnabled || !this.isDrawing || !this.currentStroke) return;
    evt.preventDefault(); evt.stopPropagation();

    const q = this.liveQueue.get(leaf);
    const pushPoint = (e: PointerEvent) => { const wp = this.getWorldPoint(e, leaf, surface); this.currentStroke!.points.push(wp); if (q) q.push(wp); };
    const list = (evt as any).getCoalescedEvents?.() as PointerEvent[] | undefined;
    if (list && list.length > 0) list.forEach(pushPoint); else pushPoint(evt);

    if (!this.canvasLive.has(leaf)) this.drawSVGStroke(this.currentStroke);
  }

  private handlePointerUp(leaf: WorkspaceLeaf) {
    if (!this.isDrawing || !this.currentStroke) return;
    this.isDrawing = false;

    if (this.currentStroke.points.length > 1) {
      if (this.canvasStatic.has(leaf)) {
        this.commitCanvas2D(leaf, this.currentStroke);
        const arr = this.strokesByLeaf.get(leaf) ?? []; arr.push(this.currentStroke); this.strokesByLeaf.set(leaf, arr);
      }
      this.strokes.push(this.currentStroke);
    }

    this.clearLiveCanvas(leaf);
    this.clearOffscreen(leaf);
    this.lastLivePoint.set(leaf, null); this.currentStroke = null;
    this.frozenUntilByLeaf.set(leaf, 0); this.lastFreezeTs.set(leaf, 0);
  }

  private handlePointerCancel(leaf: WorkspaceLeaf) {
    if (!this.currentStroke) { this.clearLiveCanvas(leaf); this.clearOffscreen(leaf); return; }
    const stroke = this.currentStroke; this.isDrawing = false;
    if (stroke.points.length > 1) {
      if (this.canvasStatic.has(leaf)) {
        this.commitCanvas2D(leaf, stroke);
        const arr = this.strokesByLeaf.get(leaf) ?? []; arr.push(stroke); this.strokesByLeaf.set(leaf, arr);
      }
      this.strokes.push(stroke);
    }
    this.clearLiveCanvas(leaf); this.clearOffscreen(leaf);
    this.lastLivePoint.set(leaf, null); this.currentStroke = null;
    this.frozenUntilByLeaf.set(leaf, 0); this.lastFreezeTs.set(leaf, 0);
  }

  // ===== Desktop (SVG) =====
  private drawSVGStroke(stroke: Stroke) {
    const leaf = this.findLeafByStroke(stroke); if (!leaf) return; const g = this.worldGroups.get(leaf); if (!g) return;
    if (!stroke.element) { stroke.element = document.createElementNS('http://www.w3.org/2000/svg', 'path'); g.appendChild(stroke.element); }
    const pts = getStroke(stroke.points.map(p => [p.x, p.y, p.pressure] as number[]), {
      size: stroke.thickness, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false,
    });
    if (!pts.length) return;
    const d = pts.map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(' ') + ' Z';
    stroke.element.setAttribute('d', d);
    // Inline style para não brigar com CSS externo
    stroke.element.style.fill = stroke.color;
    stroke.element.style.stroke = 'none';
  }

  private findLeafByStroke(stroke: Stroke): WorkspaceLeaf | null {
    for (const [leaf, g] of this.worldGroups.entries()) { if (stroke.element && g.contains(stroke.element)) return leaf; }
    for (const [leaf] of this.overlayHosts.entries()) return leaf; return null;
  }

  // ===== iPad (Canvas 2D) =====
  private ensureRAF(leaf: WorkspaceLeaf) {
    if (this.rafHandle.get(leaf)) return;
    const tick = () => { const id = requestAnimationFrame(tick); this.rafHandle.set(leaf, id); this.flushLiveCanvas(leaf); };
    this.rafHandle.set(leaf, requestAnimationFrame(tick));
  }

  private clearLiveCanvas(leaf: WorkspaceLeaf) {
    const can = this.canvasLive.get(leaf); if (!can) return; const ctx = can.getContext('2d'); if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, can.width, can.height);
    const rafId = this.rafHandle.get(leaf); if (rafId) cancelAnimationFrame(rafId); this.rafHandle.set(leaf, null);
    this.liveQueue.set(leaf, []);
  }

  private getOffscreen(leaf: WorkspaceLeaf): OffscreenType | null {
    const live = this.canvasLive.get(leaf); if (!live) return null;
    let off = this.offscreenByLeaf.get(leaf) ?? null;
    const needW = live.width, needH = live.height;
    const make = () => {
      try { return new (window as any).OffscreenCanvas(needW, needH) as OffscreenCanvas; } catch { const c = document.createElement('canvas'); c.width = needW; c.height = needH; return c; }
    };
    if (!off) { off = make(); this.offscreenByLeaf.set(leaf, off); }
    // resize se necessário
    if ((off as any).width !== needW || (off as any).height !== needH) {
      (off as any).width = needW; (off as any).height = needH;
      const ctx = (off as any).getContext('2d'); ctx?.setTransform(1,0,0,1,0,0); ctx?.clearRect(0,0,needW,needH);
    }
    return off;
  }

  private clearOffscreen(leaf: WorkspaceLeaf) {
    const off = this.offscreenByLeaf.get(leaf); if (!off) return;
    const ctx = (off as any).getContext('2d'); if (!ctx) return;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,(off as any).width,(off as any).height);
    this.frozenUntilByLeaf.set(leaf, 0);
  }

  private flushLiveCanvas(leaf: WorkspaceLeaf) {
    const can = this.canvasLive.get(leaf); if (!can) return;
    const ctx = can.getContext('2d'); if (!ctx) return;
    const q = this.liveQueue.get(leaf); if (!q || q.length === 0) return;
    if (!this.currentStroke) { q.splice(0, q.length); return; }

    const ptsAll = this.currentStroke.points;
    const n = ptsAll.length;
    let frozenUntil = this.frozenUntilByLeaf.get(leaf) ?? 0;

    // 0) Freeze (se necessário): envia bloco antigo para offscreen
    const now = performance.now();
    if (n - frozenUntil > this.TAIL && now - (this.lastFreezeTs.get(leaf) ?? 0) >= this.FREEZE_EVERY_MS) {
      const end = n - this.TAIL + this.OVERLAP; // mantemos overlap
      const chunk = ptsAll.slice(frozenUntil, Math.max(frozenUntil + 1, end));
      const off = this.getOffscreen(leaf);
      if (off) {
        const octx = (off as any).getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (octx && chunk.length > 1) {
          // desenha o polígono do chunk no offscreen, já em espaço de tela
          const dpr = window.devicePixelRatio || 1; const m = this.worldMatrix.get(leaf) ?? new DOMMatrix();
          // acumulativo: não limpamos o offscreen; apenas setamos a transform atual e pintamos por cima
          octx.setTransform(dpr, 0, 0, dpr, 0, 0); (octx as any).transform(m.a, m.b, m.c, m.d, m.e, m.f);
          const input = chunk.map(p => [p.x, p.y, Math.max(0, Math.min(1, p.pressure ?? 0.5))] as number[]);
          const poly = getStroke(input, { size: this.currentStroke!.thickness, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false });
          if (poly.length > 0) {
            octx.beginPath(); octx.moveTo(poly[0][0], poly[0][1]); for (let i = 1; i < poly.length; i++) octx.lineTo(poly[i][0], poly[i][1]); octx.closePath();
            (octx as any).fillStyle = this.currentStroke!.color; (octx as any).fill();
          }
          this.lastFreezeTs.set(leaf, now);
          frozenUntil = Math.max(frozenUntil, end - this.OVERLAP); // mantém overlap
          this.frozenUntilByLeaf.set(leaf, frozenUntil);
        }
      }
    }

    // 1) Limpa overlay
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, can.width, can.height);

    // 2) Desenha o offscreen já pronto (pixels de tela)
    const off = this.offscreenByLeaf.get(leaf);
    if (off) ctx.drawImage(off as any, 0, 0);

    // 3) Cauda: últimos TAIL pontos (a partir de frozenUntil)
    const startTail = Math.max(frozenUntil, n - this.TAIL);
    const tail = ptsAll.slice(startTail, n);

    // 3.1) Predictive head — adiciona 1 ponto previsto SÓ no preview
    let tailWithPrediction = tail;
    if (tail.length >= 2) {
      const p1 = tail[tail.length - 2];
      const p2 = tail[tail.length - 1];
      const dt = Math.max(1, (p2.t ?? now) - (p1.t ?? (now - 16)));
      const dx = p2.x - p1.x, dy = p2.y - p1.y; // mundo
      const v_world = Math.hypot(dx, dy) / dt;  // mundo/ms
      const scale = this.getViewScale(leaf);    // px por mundo
      const v_px = v_world * scale;             // px/ms
      const lead_px = Math.min(this.LEAD_MAX_SCR, v_px * this.LEAD_MS);
      if (lead_px > 0.1) {
        const h = Math.hypot(dx, dy) || 1e-6; const ux = dx / h, uy = dy / h;
        const lead_world = lead_px / Math.max(1e-6, scale);
        const pPred: StrokePoint = { x: p2.x + ux * lead_world, y: p2.y + uy * lead_world, pressure: p2.pressure, t: (p2.t ?? now) + this.LEAD_MS };
        tailWithPrediction = tail.concat(pPred);
      }
    }

    // 4) Desenha cauda (+ previsão) com a MESMA transform do commit
    const dpr = window.devicePixelRatio || 1; const m = this.worldMatrix.get(leaf) ?? new DOMMatrix();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);

    if (tailWithPrediction.length > 1) {
      const input = tailWithPrediction.map(p => [p.x, p.y, Math.max(0, Math.min(1, (p as any).pressure ?? 0.5))] as number[]);
      const poly = getStroke(input, { size: this.currentStroke!.thickness, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false });
      if (poly.length > 0) { ctx.beginPath(); ctx.moveTo(poly[0][0], poly[0][1]); for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]); ctx.closePath(); ctx.fillStyle = this.currentStroke!.color; ctx.fill(); }
    }

    // 5) Consome fila e mantém RAF viva
    const pts = q.splice(0, q.length);
    const last = this.currentStroke.points[this.currentStroke.points.length - 1] || this.lastLivePoint.get(leaf) || pts[pts.length - 1];
    if (last) this.lastLivePoint.set(leaf, last);
  }

  private scheduleRedraw(leaf: WorkspaceLeaf) {
    if (this.redrawPending.get(leaf)) return;
    const id = requestAnimationFrame(() => { this.redrawPending.set(leaf, null); this.redrawAllStrokes(leaf); });
    this.redrawPending.set(leaf, id);
  }

  private redrawAllStrokes(leaf: WorkspaceLeaf) {
    const can = this.canvasStatic.get(leaf); if (!can) return; const ctx = can.getContext('2d'); if (!ctx) return;
    const strokes = this.strokesByLeaf.get(leaf) ?? [];
    if (strokes.length === 0) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, can.width, can.height);

    const dpr = window.devicePixelRatio || 1; const m = this.worldMatrix.get(leaf) ?? new DOMMatrix();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);

    for (const s of strokes) this.paintStroke(ctx, s);
  }

  private paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
    const pts = getStroke(stroke.points.map(p => [p.x, p.y, p.pressure] as number[]), {
      size: stroke.thickness, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false,
    });
    if (pts.length === 0) return;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath(); ctx.fillStyle = '#000000'; ctx.fill();
  }

  private commitCanvas2D(leaf: WorkspaceLeaf, stroke: Stroke) {
    const can = this.canvasStatic.get(leaf); if (!can) return; const ctx = can.getContext('2d'); if (!ctx) return;
    const dpr = window.devicePixelRatio || 1; const m = this.worldMatrix.get(leaf) ?? new DOMMatrix();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);

    const pts = getStroke(stroke.points.map(p => [p.x, p.y, p.pressure] as number[]), {
      size: stroke.thickness, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: false,
    });
    if (pts.length === 0) return;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath(); ctx.fillStyle = '#000000'; ctx.fill();
  }

  private removeDrawingUI(leaf: WorkspaceLeaf) {
    this.resizeObservers.get(leaf)?.disconnect(); this.resizeObservers.delete(leaf);
    this.transformObservers.get(leaf)?.disconnect(); this.transformObservers.delete(leaf);
    this.drawingLayers.get(leaf)?.remove(); this.drawingLayers.delete(leaf);
    this.worldGroups.get(leaf)?.remove(); this.worldGroups.delete(leaf);
    this.canvasLive.get(leaf)?.remove(); this.canvasLive.delete(leaf);
    this.canvasStatic.get(leaf)?.remove(); this.canvasStatic.delete(leaf);
    this.overlayHosts.get(leaf)?.remove(); this.overlayHosts.delete(leaf);
    this.actionButtons.get(leaf)?.remove(); this.actionButtons.delete(leaf);
    this.worldMatrix.delete(leaf); this.liveQueue.delete(leaf); this.lastLivePoint.delete(leaf);
    this.strokesByLeaf.delete(leaf);
    const rafId = this.rafHandle.get(leaf); if (rafId) cancelAnimationFrame(rafId); this.rafHandle.set(leaf, null);
    const rId = this.redrawPending.get(leaf); if (rId) cancelAnimationFrame(rId); this.redrawPending.set(leaf, null);
    this.offscreenByLeaf.delete(leaf); this.frozenUntilByLeaf.delete(leaf); this.lastFreezeTs.delete(leaf);
  }
}