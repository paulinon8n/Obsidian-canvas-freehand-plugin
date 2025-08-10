# Relatório técnico — v0.3.17

Este documento resume **o que implementamos**, **o que quebrou/por quê**, e **os planos de evolução** do plugin de escrita à mão no Canvas do Obsidian.

---
## 1) O que fizemos (linha do tempo curta)
- **v0.3.2 — Preview contínuo + pressão no commit**  
  iPad renderizando preview em `Canvas 2D` (linha contínua, sem “tracejado”); commit usando `perfect-freehand` (`simulatePressure:false`).
- **v0.3.5 — Re‑render no pan/zoom (iPad)**  
  Introduzida `strokesByLeaf` e `scheduleRedraw()` para repintar todos os traços com a nova `DOMMatrix` quando o Canvas nativo muda.
- **v0.3.8 — Listeners na superfície ativa + toggle confiável**  
  Eventos saíram do `host` (que tem `pointer-events:none`) para a **superfície real**: `svg` (desktop) ou `canvasLive` (iPad). Cursor/clicks confiáveis.
- **v0.3.15 — Submenu de fidelidade (UI)**  
  Adicionamos um menu de configuração (hover/click). **Efeitos colaterais**: estados quebrados do toggle/cleanup no iPad após navegar entre canvases.
- **v0.3.16 — Hotfix**  
  Toggle OFF faz **commit do traço em andamento** + **limpa** o preview; adicionamos **`pointercancel`** como `pointerup` seguro no iPad.
- **v0.3.17 — Simplificação para estabilidade/latência**  
  **Removemos o menu**; mantivemos o caminho de latência baixa no iPad; evitamos `wipe` indevido do buffer estático no toggle OFF.

---
## 2) Arquitetura atual (resumo)
- **Overlay host** posicionado sobre o `.canvas-wrapper` (z‑index alto; `pointer-events:none`).
- **Desktop**: camada **SVG** com `<g id="WORLD">` recebendo `transform` (via `DOMMatrix` do Canvas nativo). Traços são **paths PF**.
- **iPad**: duas camadas **Canvas 2D**:
  - `canvasLive` (preview) — linhas simples, espessura variando com pressão; atualizado por `rAF` com `getCoalescedEvents()`.
  - `canvasStatic` (commit) — rasteriza o contorno PF dos pontos armazenados.
- **Sincronização de transform**: `MutationObserver` lê `style.transform` do Canvas nativo → atualiza `worldMatrix` → aplica no `WORLD` (SVG) e em `ctx.transform(...)` (Canvas 2D).

---
## 3) O que quebrou (e por quê)
### 3.1 “Quadrado no canto” / offset do cursor
**Sintoma**: só desenhava num retângulo no canto; cursor e traço desalinhavam fora dele.  
**Causa**: cálculo de coordenadas usando `getBoundingClientRect()` do **elemento errado** (host) e/ou `viewBox`/`preserveAspectRatio` ausentes; além disso, inversão de matriz não aplicada em todos os caminhos.  
**Correção**: medir **na própria superfície ativa** (SVG/canvasLive), setar `viewBox` + `preserveAspectRatio:'none'` e usar **`DOMMatrix.inverse()`** para mapear (screen→world).

### 3.2 Fantasmas/duplicação ao desligar a ferramenta
**Sintoma**: parte do traço seguia o Canvas; outra ficava “estacionária”.  
**Causa**: preview (live) não era limpo em todos os fluxos de saída (`pointercancel` ausente); às vezes comitávamos uma parte e a outra ficava no buffer do preview.  
**Correção**: no toggle OFF e `pointercancel`, **sempre** comitar traço válido e **sempre** limpar o `canvasLive` + cancelar `rAF`.

### 3.3 Traços desaparecendo no iPad ao desligar (após mexer em menu e trocar de canvas)
**Sintoma**: desenhava, trocava de arquivo, voltava e ao desligar a caneta o traço sumia.  
**Causa raiz**: duas coisas combinadas:
1) `toggle OFF` chamando `scheduleRedraw()` em momentos em que `strokesByLeaf` ainda estava vazio → `redrawAllStrokes()` limpava o buffer e **não repintava nada** (porque a lista estava vazia).
2) O submenu introduziu caminhos de estado onde **o traço em progresso não era comitado** (faltava `pointercancel`/commit ao sair/reabrir UI), então **só existia no preview**.
  
**Correções** (v0.3.16/17):
- Toggle OFF **não** chama redraw imediato; só commit + cleanup do preview.
- `redrawAllStrokes()` retorna cedo se a lista estiver vazia (evitar wipe “a seco”).
- Removemos o submenu até termos uma UI que **não** interfira no ciclo de desenho.

### 3.4 Pequena diferença visual preview × final
**Sintoma**: espessura e forma não iguais entre preview (linha) e final (contorno PF).  
**Causa**: preview usa **line stroke** com `lineWidth` proporcional à pressão; PF gera **polígono** com `thinning/streamline/smoothing`. Áreas resultantes diferem.

### 3.5 Micro‑delay no pan/zoom
**Sintoma**: 1 frame de atraso entre o movimento do Canvas e o redesenho do buffer estático.  
**Causa**: `scheduleRedraw()` em `rAF` (uma fila) vs. aplicação instantânea do `transform` pelo Canvas nativo.  
**Workaround atual**: o preview acompanha instantâneo; o estático redesenha no quadro seguinte (aceitável, mas visível para olhos sensíveis).

---
## 4) Lições aprendidas (checklist)
- Eventos **sempre** na superfície onde medimos o `getBoundingClientRect()`.
- Em iPad, tratar **`pointercancel`** igual a `pointerup` (commit + cleanup).
- Evitar limpar `canvasStatic` quando não houver dados para repintar.
- Separar **preview baratíssimo** de **commit bonito** é a chave para latência.
- Submenus que alteram foco/gestos devem ser introduzidos **só** com harness de teste de estados.

---
## 5) Planos de implementação (próximas iterações)
> Mantemos a política de **uma melhoria por vez**.

### 5.1 Paridade visual preview × final (iPad)
- **Meta**: tornar o preview praticamente indistinguível do PF final.
- **Técnica**: ajustar `lineWidth = f(pressure)` para aproximar a **área** do contorno PF (curva não linear + leve suavização).  
- **Critério de aceite**: diferença de largura média < 10% em 3 velocidades.

### 5.2 Zero‑delay aparente no pan/zoom (iPad)
- Aplicar **transform imediata** no `canvasLive` no callback do `MutationObserver` (sem esperar `rAF`); adiar `redraw` do estático.
- **Aceite**: nenhum “salto” visível ao fazer pan/zoom logo após desenhar.

### 5.3 Tilt/velocidade opcionais no preview
- Usar `tiltX/tiltY` e velocidade local para modular levemente a largura/opacidade.  
- **Aceite**: modulação sutil, sem custo de FPS perceptível.

### 5.4 Persistência no `.canvas` (formato `x-ink`)
- Gravar por arquivo **lista de strokes** (`points` + `props`) em um campo custom (e.g., `x-ink`).
- Carregar no `onopen` e repintar em `canvasStatic`/SVG.
- **Aceite**: abrir/fechar o arquivo e os desenhos estarem lá, isolados por canvas.

### 5.5 Toolbar mínima (sem menus modais)
- Botões: **cor**, **espessura**, **borracha**; layout inline próximo ao botão “pencil”.  
- Pass‑through quando OFF; nada de hover/menus flutuantes por enquanto.

### 5.6 Undo/redo local dos traços
- Pilha simples por leaf (desfazer último stroke; refazer).  
- **Aceite**: Ctrl/Cmd+Z/Y no desktop; botões no iPad.

### 5.7 Clip por card / desenhar “dentro” do elemento
- Calcular bounding do card alvo + `save()/clip()/restore()` no Canvas 2D; no SVG, `clipPath` por grupo.
- **Aceite**: alternar modo “Canvas inteiro” ↔ “Somente card”.

### 5.8 Performance avançada (futuro)
- **OffscreenCanvas + Worker** quando disponível (WebKit permitiu parcialmente); fallback automático.
- Buffers tipados (`Float32Array`) para pontos; simplificação dinâmica por velocidade.

---
## 6) Matriz de testes (sempre rodar)
- **Desktop (SVG)**: desenhar/pan/zoom; trocar de canvas; fechar/abrir vault.
- **iPad (Canvas 2D)**: pressão; alternar ON/OFF; pan/zoom logo após traço; trocar de canvas; background/foreground do app (gera `pointercancel`).
- **Leaks**: desconectar `ResizeObserver`, `MutationObserver`, cancelar `rAF` no `removeDrawingUI()`.

---
## 7) Estado atual OK (pós v0.3.17)
- Desktop e iPad **desenhando**;
- **Sem fantasmas** ao desligar;
- Pan/zoom estabilizados; minúsculo atraso no estático (esperado);
- Diferença leve preview × final (planejada para 5.1).

> Próxima micro‑iteração sugerida: **5.1 Paridade visual no iPad**.

