// main.ts
import { Plugin, WorkspaceLeaf, ItemView } from 'obsidian';
import { getStroke } from 'perfect-freehand';

// Definição de uma interface para os nossos traços
interface Stroke {
    points: number[][];
    color: string;
    thickness: number;
    // Adicionamos uma referência ao elemento SVG para atualizações em tempo real
    element?: SVGPathElement; 
}

export default class CanvasFreehandPlugin extends Plugin {
    private isDrawingEnabled: boolean = false;
    private isDrawing: boolean = false;
    private currentStroke: Stroke | null = null;
    private strokes: Stroke[] = [];

    // Mapeia para guardar a camada de desenho SVG de cada aba
    private drawingLayers: Map<WorkspaceLeaf, SVGSVGElement> = new Map();
    private resizeObservers: Map<WorkspaceLeaf, ResizeObserver> = new Map();
    private actionButtons: Map<WorkspaceLeaf, HTMLElement> = new Map();
    private mutationObservers: Map<WorkspaceLeaf, MutationObserver> = new Map();

    async onload() {
        console.log('Loading Canvas Freehand Plugin');
        this.app.workspace.onLayoutReady(() => {
            this.handleLayoutChange();
        });
        this.registerEvent(this.app.workspace.on('layout-change', this.handleLayoutChange.bind(this)));
        this.registerEvent(this.app.workspace.on('active-leaf-change', this.handleActiveLeafChange.bind(this)));
    }

    onunload() {
        console.log('Unloading Canvas Freehand Plugin');
        this.drawingLayers.forEach((_, leaf) => this.removeDrawingUI(leaf));
    }

    private handleLayoutChange() {
        this.app.workspace.getLeavesOfType('canvas').forEach(leaf => {
            if (!this.drawingLayers.has(leaf)) {
                this.setupDrawingUI(leaf);
            }
        });
    }
    
    private handleActiveLeafChange(leaf: WorkspaceLeaf | null) {
        if (leaf && leaf.view.getViewType() === 'canvas') {
            if (!this.drawingLayers.has(leaf)) {
                this.setupDrawingUI(leaf);
            }
            // TODO: Carregar os desenhos específicos deste canvas aqui
        }
    }

    private setupDrawingUI(leaf: WorkspaceLeaf) {
        const viewContainer = leaf.view.containerEl;
        const canvasWrapper = viewContainer.querySelector('.canvas-wrapper') as HTMLElement;
        if (!canvasWrapper) return;

        // 1. CRIAÇÃO DA CAMADA DE DESENHO SVG
        const drawingLayer = canvasWrapper.createSvg('svg', { cls: 'canvas-freehand-drawing-layer' });
        this.drawingLayers.set(leaf, drawingLayer);
        
        // 2. BOTÃO DE AÇÃO
        const button = (leaf.view as ItemView).addAction('pencil', 'Toggle Drawing', () => this.toggleDrawingMode(leaf, button));
        this.actionButtons.set(leaf, button);

        // 3. EVENTOS DE DESENHO
        this.registerDomEvent(canvasWrapper, 'pointerdown', (evt) => this.handlePointerDown(evt, leaf));
        this.registerDomEvent(canvasWrapper, 'pointermove', (evt) => this.handlePointerMove(evt, leaf));
        this.registerDomEvent(window, 'pointerup', () => this.handlePointerUp(leaf));

        // 4. SINCRONIZAÇÃO VIA ESPELHAMENTO DE TRANSFORMAÇÃO
        const nativeCanvas = canvasWrapper.querySelector('.canvas') as HTMLElement;
        if (nativeCanvas) {
            const observer = new MutationObserver(() => {
                drawingLayer.style.transform = nativeCanvas.style.transform;
                drawingLayer.style.transformOrigin = nativeCanvas.style.transformOrigin;
            });
            observer.observe(nativeCanvas, { attributes: true, attributeFilter: ['style'] });
            this.mutationObservers.set(leaf, observer);
            drawingLayer.style.transform = nativeCanvas.style.transform;
            drawingLayer.style.transformOrigin = nativeCanvas.style.transformOrigin;
        }
    }

    private toggleDrawingMode(leaf: WorkspaceLeaf, button: HTMLElement) {
        this.isDrawingEnabled = !this.isDrawingEnabled;
        const canvasWrapper = leaf.view.containerEl.querySelector('.canvas-wrapper');
        if (canvasWrapper) {
            canvasWrapper.classList.toggle('is-drawing-active', this.isDrawingEnabled);
            button.classList.toggle('is-active', this.isDrawingEnabled);
        }
    }
    
    private handlePointerDown(evt: PointerEvent, leaf: WorkspaceLeaf) {
        if (!this.isDrawingEnabled) return; 
        evt.preventDefault();
        evt.stopPropagation();
        this.isDrawing = true;
        
        this.currentStroke = {
            points: [[evt.offsetX, evt.offsetY, evt.pressure]],
            color: '#000000', 
            thickness: 8,
            element: this.createStrokeElement(leaf)
        };
    }

    private handlePointerMove(evt: PointerEvent, leaf: WorkspaceLeaf) {
        if (!this.isDrawingEnabled || !this.isDrawing || !this.currentStroke) return;
        evt.preventDefault();
        evt.stopPropagation();
        this.currentStroke.points.push([evt.offsetX, evt.offsetY, evt.pressure]);
        this.drawStroke(this.currentStroke);
    }

    private handlePointerUp(leaf: WorkspaceLeaf) {
        if (!this.isDrawing || !this.currentStroke) return;
        this.isDrawing = false;
        
        if (this.currentStroke.points.length > 1) {
            this.strokes.push(this.currentStroke);
        } else {
            // Se o traço for muito pequeno (apenas um clique), remove o elemento SVG criado
            this.currentStroke.element?.remove();
        }
        
        this.currentStroke = null;
        // TODO: Chamar a função de salvamento
    }

    private createStrokeElement(leaf: WorkspaceLeaf): SVGPathElement {
        const drawingLayer = this.drawingLayers.get(leaf);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        drawingLayer?.appendChild(path);
        return path;
    }

    private drawStroke(stroke: Stroke) {
        if (!stroke.element) return;

        const strokePoints = getStroke(stroke.points, {
            size: stroke.thickness,
            thinning: 0.5,
            smoothing: 0.5,
            streamline: 0.5,
        });

        if (!strokePoints.length) return;

        const pathData = strokePoints.reduce(
            (acc, [x0, y0], i, arr) => {
                const [x1, y1] = arr[(i + 1) % arr.length];
                acc.push(`M ${x0} ${y0} L ${x1} ${y1}`);
                return acc;
            },
            [] as string[]
        ).join(' ');

        stroke.element.setAttribute('d', pathData);
        stroke.element.setAttribute('fill', stroke.color);
    }

    private removeDrawingUI(leaf: WorkspaceLeaf) {
        this.resizeObservers.get(leaf)?.disconnect();
        this.resizeObservers.delete(leaf);
        this.drawingLayers.get(leaf)?.remove();
        this.drawingLayers.delete(leaf);
        this.actionButtons.get(leaf)?.remove();
        this.actionButtons.delete(leaf);
        this.mutationObservers.get(leaf)?.disconnect();
        this.mutationObservers.delete(leaf);
    }
}