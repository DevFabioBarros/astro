# Plano de execução — sandbox imersiva

Revisão solicitada pelo usuário em 2026-10-15. Referência: `../specs/2026-10-15-immersive-sandbox-design.md`. Coordenador mantém integração; nenhum arquivo tem escritores concorrentes.

## Onda 1 — implementação paralela

| Responsável | Arquivos exclusivos | Contrato / dependência |
|---|---|---|
| realistic_dynamics | simulation-time, worker, client, solar-system e testes correspondentes | Exporta DEFAULT_SIMULATION_SPEED, SIMULATION_SPEEDS, MAX_SIMULATION_SPEED; mantém protocolo existente e SI |
| immersive_scene | SimulationCanvas, scene-scale, camera-focus, body-texture e helpers/testes visuais novos | Consome estado SI e GLB; props opcionais showOrbits, viewMode, viewRequest; escala física sempre real; usa imagens do coordenador |
| astronomy_interface | page, globals.css, toolbar, inspector, SaveControls, conversões e testes próprios | Consome constantes de tempo e props da cena; não altera domínio SI |
| Coordenador | public/textures, atribuição, docs, E2E | Pesquisa fontes, integra contratos e valida resultado no Chrome |

## Onda 2 — revisões complementares

Revisor físico: precisão temporal, orçamento de passos, rollback e entradas inválidas. Revisor visual: proporções, câmera, órbitas, carregamento e recursos GPU. Coordenador revisa UI, conversões, responsividade e experiência real no navegador. Correções voltam ao escritor responsável, sem edição concorrente.

## Onda 3 — integração e aceite

- [x] Testes focados e correção dos achados relevantes.
- [x] pnpm check e Playwright no Chrome instalado.
- [x] Revisão visual desktop/mobile e movimento confirmado por estados sucessivos.
- [x] Docs de produto/arquitetura/design/setup atualizados; diff/status preservados.

Nenhum deploy, push, serviço pago ou configuração global faz parte desta execução.
