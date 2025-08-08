import { Plugin, WorkspaceLeaf, setIcon, ItemView } from 'obsidian';

interface CanvasFreehandSettings {}
const DEFAULT_SETTINGS: CanvasFreehandSettings = {};

export default class CanvasFreehandPlugin extends Plugin {
	settings: CanvasFreehandSettings;
	
	// Map para guardar a camada de captura de cada aba
	private eventCatchers: Map<WorkspaceLeaf, HTMLDivElement> = new Map();
	// Map para guardar a camada de desenho de cada aba
	private drawingLayers: Map<WorkspaceLeaf, HTMLCanvasElement> = new Map();
	private resizeObservers: Map<WorkspaceLeaf, ResizeObserver> = new Map();
	// Map para guardar uma referência ao botão de ação de cada aba, para o podermos remover
	private actionButtons: Map<WorkspaceLeaf, HTMLElement> = new Map();

	private currentStrokePoints: number[][] = [];
	private isCurrentlyDrawing: boolean = false;

	async onload() {
		console.log('Loading Canvas Freehand Plugin');
		await this.loadSettings();

		// Espera o layout do Obsidian estar pronto antes de fazer a primeira verificação.
		this.app.workspace.onLayoutReady(() => {
			this.onLayoutChange();
		});

		// O 'layout-change' continua a ser usado para detetar novas abas de Canvas abertas.
		this.registerEvent(
			this.app.workspace.on('layout-change', this.onLayoutChange.bind(this))
		);
		
		this.registerDomEvent(window, 'pointerup', this.handlePointerUp.bind(this));
	}

	onunload() {
		console.log('Unloading Canvas Freehand Plugin');
		this.removeDrawingUIFromAllCanvas();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private onLayoutChange() {
		this.app.workspace.getLeavesOfType('canvas').forEach((leaf: WorkspaceLeaf) => {
			this.addDrawingUIToCanvas(leaf);
		});
	}

	/**
	 * Função unificada para adicionar toda a nossa UI a um Canvas.
	 */
	private addDrawingUIToCanvas(leaf: WorkspaceLeaf) {
		if (this.eventCatchers.has(leaf)) {
			return;
		}

		const canvasContainer = leaf.view.containerEl.querySelector('.canvas-container');
		
		if (canvasContainer) {
			// --- CRIAÇÃO DAS CAMADAS ---
			const eventCatcher = canvasContainer.createEl('div', {
				cls: 'canvas-freehand-event-catcher'
			});
			this.eventCatchers.set(leaf, eventCatcher);

			const drawingLayer = eventCatcher.createEl('canvas', {
				cls: 'canvas-freehand-drawing-layer'
			});
			this.drawingLayers.set(leaf, drawingLayer);
			
			// --- LÓGICA DE REDIMENSIONAMENTO ---
			const resizeCanvas = () => {
				drawingLayer.width = canvasContainer.clientWidth;
				drawingLayer.height = canvasContainer.clientHeight;
			};
			const observer = new ResizeObserver(resizeCanvas);
			observer.observe(canvasContainer);
			this.resizeObservers.set(leaf, observer);
			resizeCanvas();

			// --- "ESCUTADORES" DE EVENTOS ---
			this.registerDomEvent(eventCatcher, 'pointerdown', this.handlePointerDown.bind(this));
			this.registerDomEvent(eventCatcher, 'pointermove', this.handlePointerMove.bind(this));
			
			// --- NOVA ABORDAGEM PARA O BOTÃO ---
			// Usamos o método oficial da API para adicionar um botão de ação à vista.
			const button = (leaf.view as ItemView).addAction(
				'lucide-pencil', // Ícone
				'Desenhar', // Tooltip
				() => { // Callback do clique
					const isActive = button.classList.toggle('is-active');
					eventCatcher.classList.toggle('is-active', isActive);
					console.log(`Modo de desenho: ${isActive ? 'Ativado' : 'Desativado'}`);
				}
			);
			this.actionButtons.set(leaf, button);
		}
	}

	private handlePointerDown(e: PointerEvent) {
		this.isCurrentlyDrawing = true;
		this.currentStrokePoints = [[e.offsetX, e.offsetY, e.pressure]];
		console.log('Iniciando traço...');
	}

	private handlePointerMove(e: PointerEvent) {
		if (!this.isCurrentlyDrawing) return;
		this.currentStrokePoints.push([e.offsetX, e.offsetY, e.pressure]);
	}

	private handlePointerUp(e: PointerEvent) {
		if (!this.isCurrentlyDrawing) return;
		this.isCurrentlyDrawing = false;
		console.log('Traço finalizado com', this.currentStrokePoints.length, 'pontos.');
		this.currentStrokePoints = [];
	}

	private removeDrawingUIFromAllCanvas() {
		this.resizeObservers.forEach(observer => observer.disconnect());
		this.resizeObservers.clear();

		this.eventCatchers.forEach(catcher => catcher.remove());
		this.eventCatchers.clear();
		
		this.actionButtons.forEach(button => button.remove());
		this.actionButtons.clear();

		this.drawingLayers.clear();
	}
}
