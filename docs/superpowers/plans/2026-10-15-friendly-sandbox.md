# Plano de continuidade — sandbox acessível

Escopo: [especificação](../specs/2026-10-15-friendly-sandbox-design.md). Planos aprovados anteriores preservados. Um escritor por arquivo; coordenador integra e encaminha achados aos responsáveis. Implementadores não fazem commit.

## Tarefas e propriedade

| ID | Tarefa | Files | Depends-on | Owner |
|---|---|---|---|---|
| T01 | Catálogo, experimentos, validação, codec e protocolo autoritativo | `src/simulation/**` | nenhuma | `sandbox_physics` |
| T02 | Materiais compactos, primários orbitais e envio da fila ao Worker | `src/features/simulation/SimulationCanvas.tsx`, `celestial-scene.ts`, `celestial-bodies.ts`, `celestial-bodies.test.ts`, `body-appearance.ts`, `body-appearance.test.ts`, `orbit-paths.ts`, `orbit-paths.test.ts`, `simulation-world-sync.ts`, `simulation-world-sync.test.ts` | contrato de T01 | `sandbox_render` |
| T03 | Sliders, catálogo, remover/reiniciar e fila de ações na página | `src/app/page.tsx`, `src/app/globals.css`, `src/features/simulation/ObjectInspector.tsx`, `SimulationToolbar.tsx`, `SaveControls.tsx`, `BodyCatalog.tsx`, `astronomy-units.ts`, `astronomy-units.test.ts`, `next-planet.ts`, `next-planet.test.ts` | contrato de T01 | `sandbox_interface` |
| T04 | Pesquisa NASA, docs e registro do recorte | `PRODUCT.md`, `README.md`, `docs/architecture.md`, `docs/design.md`, `docs/onboarding.md`, `docs/quality.md`, `docs/setup.md`, `docs/physics.md`, este plano e spec correspondente | implementação para descrição final; T05 para evidências | `sandbox_science_docs` |
| T05 | E2E, gates e inspeção Chrome desktop/celular | `e2e/simulation.spec.ts`, `playwright.config.ts` se necessário, artefatos de navegador | T01, T02, T03 estabilizados | `sandbox_qa` |
| T06 | Revisão física e continuidade temporal, somente leitura | nenhum | T01 | `review_world_revision` |
| T07 | Revisão UI, fila de ações e fluxos, somente leitura | nenhum | T03 | `interface_review` |
| T08 | Revisão cena, recursos e sincronização, somente leitura | nenhum | T02 | `review_glb_texture` |

Nos caminhos abreviados de T02/T03, o diretório é `src/features/simulation/`. Nenhuma tarefa reserva arquivos de outra. Qualquer ampliação de escopo exige coordenação antes da escrita.

## Ondas

| Onda | Tarefas | Dependência / execução |
|---|---|---|
| 1 | T01 | Define tipos e API; pesquisa de T04 pode ocorrer em paralelo, sem afirmar implementação ainda ausente. |
| 2 | T02, T03 | Trabalham sobre contrato estabilizado de T01; arquivos disjuntos. |
| 3 | Correções T01/T02/T03 e revisões T06/T07/T08 | Escritores conservam propriedade; revisão é somente leitura. Correção altera apenas contrato acordado e tem nova revisão. |
| 4 | T04, T05 | Docs de comportamento podem avançar; evidência final de T04 depende do relatório de T05. |
| 5 | Fechamento T04 | Registra resultados reais, pendências e limites após QA/revisões. |

O host permite quatro agentes ativos incluindo o coordenador. Lotes respeitam esse teto sem limitar o elenco total a três. Codex subagents são o mecanismo disponível fora de terminal Maestri com `MAESTRI_PIPE`. Não há execução solo do coordenador nesta continuação: pesquisa, escrita, validação e revisão são delegadas.

## Situação

Implementação entregue pelos responsáveis. `pnpm check` passou após CSS final: 206 testes unitários em 23 arquivos, build, lint, tipos e regras locais; permanece um warning legado. Chrome E2E passou 18/18 antes do CSS final; após CSS, os 2/2 checks focados de inicialização/console e geometria, foco e arraste móvel em 320 px passaram. Não houve nova rodada 18/18 pós-CSS. Imagens 320×740 e 480×844 foram inspecionadas sem overflow/sobreposição; navegação oculta com editor aberto e retorna ao fechar; desktop 1440 px está correto. Sobreposição móvel está resolvida. Limites restantes: aparelho físico não testado; modelo Newtoniano sem relatividade geral, colisões ou evolução estelar; achado P3 no enquadramento do disco de buraco negro. Evidências e comandos finais estão em [setup.md](../../setup.md). Nenhum commit, push ou deploy foi solicitado neste recorte.
