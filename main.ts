// main.ts — v0.3.17
// UMA ÚNICA MELHORIA: remover completamente o botão/menus de configurações
// para eliminar efeitos colaterais no iPad. Mantém latência mínima e a
// estabilidade do toggle (commit/cleanup + pointercancel). Nada de submenu.

import { Plugin, WorkspaceLeaf, ItemView } from 'obsidian';
import { getStroke } from 'perfect-freehand';

interface StrokePoint { x: number; y: number; pressure: number; tiltX?: number; tiltY?: number; twist?: number; t?: number }
interface Stroke { points: StrokePoint[]; color: string; thickness: number; element?: SVGPathElement; }

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
      if (!this.isDrawing) this.clearLiveCanvas(leaf);
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
    };
    const ro = new ResizeObserver(updateViewport); ro.observe(host); this.resizeObservers.set(leaf, ro);

    if (isAppleTouchDevice()) { this.setupCanvas2D(leaf, host); } else { this.setupSVG(leaf, host); }

    const drawBtn = (leaf.view as ItemView).addAction('pencil', 'Toggle Drawing', () => this.toggleDrawingMode(leaf));
    this.actionButtons.set(leaf, drawBtn);

    if (!this.strokesByLeaf.has(leaf)) this.strokesByLeaf.set(leaf, []);
  }

  // ===== Helpers de superfície ativa =====
  private getActiveSurface(leaf: WorkspaceLeaf): HTMLElement | null {
    return (this.drawingLayers.get(leaf) as unknown as HTMLElement) || this.canvasLive.get(leaf) || null;
  }
  private setSurfaceActive(leaf: WorkspaceLeaf, active: boolean) {
    const target = this.getActiveSurface(leaf); if (!target) return;
    target.style.pointerEvents = active ? 'auto' : 'none';
    target.style.cursor = active ? 'crosshair' : 'default';
    (target.style as any).touchAction = active ? 'none' : 'auto'; // iPad: suprime gestos do SO quando desenhando
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
      this.isDrawing = false; this.currentStroke = null; this.lastLivePoint.set(leaf, null);
      // não chamar scheduleRedraw aqui para evitar wipe inesperado após navegação
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

    if (this.canvasLive.has(leaf)) this.clearLiveCanvas(leaf);
    this.lastLivePoint.set(leaf, null); this.currentStroke = null;
  }

  private handlePointerCancel(leaf: WorkspaceLeaf) {
    if (!this.currentStroke) { this.clearLiveCanvas(leaf); return; }
    const stroke = this.currentStroke; this.isDrawing = false;
    if (stroke.points.length > 1) {
      if (this.canvasStatic.has(leaf)) {
        this.commitCanvas2D(leaf, stroke);
        const arr = this.strokesByLeaf.get(leaf) ?? []; arr.push(stroke); this.strokesByLeaf.set(leaf, arr);
      }
      this.strokes.push(stroke);
    }
    this.clearLiveCanvas(leaf); this.lastLivePoint.set(leaf, null); this.currentStroke = null;
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
    stroke.element.setAttribute('d', d); stroke.element.setAttribute('fill', stroke.color); stroke.element.setAttribute('stroke', 'none');
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

  private flushLiveCanvas(leaf: WorkspaceLeaf) {
    const can = this.canvasLive.get(leaf); if (!can) return; const ctx = can.getContext('2d'); if (!ctx) return;
    const q = this.liveQueue.get(leaf); if (!q || q.length === 0) return;

    const dpr = window.devicePixelRatio || 1; const m = this.worldMatrix.get(leaf) ?? new DOMMatrix();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);

    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#000000';

    let prev = this.lastLivePoint.get(leaf) || q[0];
    const pts = q.splice(0, q.length);

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const base = this.currentStroke?.thickness ?? 8;
      const w = Math.max(0.5, base * (0.2 + 0.8 * (p.pressure || 0.5)));
      ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      prev = p;
    }

    this.lastLivePoint.set(leaf, prev);
  }

  private scheduleRedraw(leaf: WorkspaceLeaf) {
    if (this.redrawPending.get(leaf)) return;
    const id = requestAnimationFrame(() => { this.redrawPending.set(leaf, null); this.redrawAllStrokes(leaf); });
    this.redrawPending.set(leaf, id);
  }

  private redrawAllStrokes(leaf: WorkspaceLeaf) {
    const can = this.canvasStatic.get(leaf); if (!can) return; const ctx = can.getContext('2d'); if (!ctx) return;
    const strokes = this.strokesByLeaf.get(leaf) ?? [];
    // Evitar apagar o buffer se não temos nada para redesenhar (cenário após navegação)
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
  }
}