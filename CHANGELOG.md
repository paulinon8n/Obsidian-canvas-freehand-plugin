# CHANGELOG

> Histórico de versões testadas do plugin de escrita à mão para o Canvas do Obsidian. Objetivo: listar o que foi testado, o que funcionou e o que deu errado em cada versão.

## 0.3.18‑alpha.6 — 2025‑08‑10

Testado: predição de cabeçote (lead) no preview; integração com janela deslizante; iPad (Canvas 2D) e desktop (SVG); zoom/pan; paridade visual com commit.Funcionou: redução do gap ponta→traço; preview e commit idênticos; sem quebras observadas.Não funcionou: nenhum problema nos testes iniciais; observar possível overshoot em movimentos muito rápidos.

## 0.3.18‑alpha.5 — 2025‑08‑10

Testado: windowed preview (offscreen cache) com TAIL=384, OVERLAP=12, FREEZE_EVERY_MS=24; traços longos; resize/zoom.Funcionou: latência menor em traços longos; 60 FPS mais estáveis; paridade preview↔commit mantida.Não funcionou: cache é invalidado em resize/zoom (comportamento esperado); sem regressões.

## 0.3.18‑alpha.4 — 2025‑08‑10

Testado: preview no iPad desenhando o mesmo polígono do perfect-freehand do commit; SVG preenchido no desktop; ajuste de CSS inline.Funcionou: espessura/forma idênticas entre preview e commit.Não funcionou: latência em traços muito longos ainda perceptível (endereçada no alpha.5).

## 0.3.17.1 — 2025‑08‑09

Testado: simplificação do botão/menus; estabilidade de toggle; pointercancel.Funcionou: estabilidade no iPad; sem efeitos colaterais.Não funcionou: preview (stroke/lineWidth) ≠ commit (polígono) → espessuras diferentes (corrigido no alpha.4).

## v0.3.17 — Remoção do menu / caminho estável (iPad prioridade)

**Testes**: Desktop (SVG); iPad (Canvas 2D); toggle ON/OFF; trocar de arquivo `.canvas`; pan/zoom durante e após traço.
**Funcionou**: sem fantasmas ao desligar; desenhos persistem ao alternar canvases; latência baixa no iPad; pan/zoom congruentes; desktop estável.
**Falhou/Observado**: pequeno delay (≈1 frame) no re‑draw do buffer estático no iPad; leve diferença visual entre preview × final.

## v0.3.16 — Commit/cleanup no toggle OFF + `pointercancel`

**Testes**: iPad com traço em progresso; sair/trocar app (gera `pointercancel`); desligar ferramenta; duplicações.
**Funcionou**: commit do traço em andamento ao desligar; limpeza do preview e cancelamento de RAF; tratamento de `pointercancel` como `pointerup` seguro; reduziu fantasmas.
**Falhou/Observado**: resquícios de sumiço/estado inconsistente quando o submenu (v0.3.15) estava aberto — resolvido em v0.3.17 removendo o menu.

## v0.3.15 — Submenu de “Fidelidade pré‑commit” (UI)

**Testes**: abrir menu (hover/click), trocar opções; desenhar; alternar entre canvases; desligar ferramenta.
**Funcionou**: submenu abriu e salvou opção.
**Falhou/Regressões**: estados quebrados do toggle; às vezes sem traço/crosshair; fantasmas (parte estacionária/duplicada); no iPad, desenho podia sumir ao desligar após trocar de canvas; risco de incongruência em zoom.

## v0.3.8 — Listeners na superfície ativa + toggle confiável

**Testes**: habilitar/desabilitar desenho; cursor/crosshair; eventos em iPad/desktop.
**Funcionou**: eventos movidos para **svg/canvasLive**; cursor/traço aparecem de forma confiável; correção do “quadrado no canto” ao usar `getBoundingClientRect()` da superfície e matriz inversa.
**Falhou/Observado**: diferença visual preview × final ainda presente; micro‑delay no re‑draw do estático no iPad.

## v0.3.5 — Re‑render no pan/zoom (iPad)

**Testes**: pan/zoom/resize no Canvas; persistência por leaf; replay de traços.
**Funcionou**: `strokesByLeaf` + `scheduleRedraw()/redrawAllStrokes()`; pan/zoom passaram a re‑renderizar todos os traços; menos desaparecimentos.
**Falhou/Observado**: eventos ainda no host em algumas partes (podia atrapalhar toggle/crosshair); preview simples sem pressão em tempo real; sem `pointercancel`.

## v0.3.2 — Preview contínuo (iPad) + pressão real no commit

**Testes**: traço contínuo no iPad; commit com `perfect‑freehand` (PF); desktop mantido.
**Funcionou**: fim do efeito “tracejado” no preview; PF no commit com `simulatePressure:false`.
**Falhou/Observado**: sem re‑render no pan/zoom (traços podiam desaparecer ou desalinhação); cálculo de coords ainda pelo host (levava ao “quadrado” em cenários); diferença maior preview × final.

## v0.3.1 — Estado inicial instável (relato)

**Testes**: habilitar desenho; cursor/crosshair; pan/zoom básicos.
**Falhou**: não desenhava / crosshair ausente; ferramenta nativa permanecia ativa; causa provável: listeners no **host** com `pointer-events:none` + mapeamento de transform incorreto. Melhorias vieram nas versões seguintes (v0.3.2+ / v0.3.5+ / v0.3.8).
