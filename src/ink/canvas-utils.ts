// =============================================
// src/ink/canvas-utils.ts
// Helpers para Canvas 2D (DPR, tamanho, coalesced)
// =============================================

export function resizeCanvasToDPR(canvas: HTMLCanvasElement, dprCap = Infinity) {
  const dpr = Math.min(dprCap, Math.max(1, window.devicePixelRatio || 1));
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function getCoalesced(ev: PointerEvent): PointerEvent[] {
  return (ev.getCoalescedEvents?.() ?? [ev]) as PointerEvent[];
}
