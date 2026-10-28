# Relatório Prumo — evolução solar

**Estado:** QA focado concluído após congelamento C2. Nenhum arquivo de produto foi editado por Prumo.

## Escopo preparado

`solar-evolution.spec.ts` cobre início do modelo, avanço aceito até marco MIST, alteração de diâmetro/estágio, exclusividade dos relógios, export/import v3, edição manual de massa e raio com velocidade preservada, leitura de diâmetro/densidade/gravidade/escape, fatores físicos de escala, G natural e G=0, limites de exibição para buraco negro, importação v1/v2 e Reset Solar integral.

`pnpm check` passou após o ajuste do baseline de tempo pós-import: lint sem erros (um warning legado), typecheck, lint:rules, 311 testes em 36 arquivos e build de produção. `pnpm exec playwright test e2e/solar-evolution.spec.ts` passou 3/3 no Chrome. Inclui clocks exclusivos/ACK, edição manual, medidas e fatores físicos, G configurado/zero, BH, v3 round-trip, fixtures v1/v2 e Reset Solar. A suíte E2E legada de 24 casos não foi repetida nesta rodada. Nenhuma ferramenta foi instalada. Não há medição de desempenho Iris Xe neste ambiente.

O build de produção fresco serviu CSS com `.solar-milestones`, grid de duas colunas e `min-height:44px`. Capturas 1440×900 e 390×844 foram abertas; marcos estavam legíveis em duas colunas. Servidor local mantido para revisão em `127.0.0.1:3101`, PID 32640, HTTP 200.

## Revisão estática independente

Sem achados concretos nos focos solicitados:

- Worker mantém evolução e N-body exclusivos. Testes cobrem bloqueio de retomada orbital e rollback de `SET_BODIES` inválido durante evolução em `src/simulation/simulation.worker.test.ts`.
- Mutações de massa validam o candidato e preservam vetores de velocidade em `src/simulation/body-edits.ts`; teste cobre efeito gravitacional em `src/simulation/body-edits.test.ts`.
- Evolução MIST verifica domínio, transição, absorção Terra–Lua e ledger de vento/momento em `src/simulation/stellar-evolution.test.ts`.
- Render suaviza propriedades com alpha exponencial por delta de frame. Bounds invalida cache quando corpos mudam ou a aparência ainda converge; câmera de foco usa o raio visual suavizado. Cobertura está em `src/features/simulation/celestial-scene.test.ts`, `src/features/simulation/scene-scale.test.ts` e `src/features/simulation/camera-focus.test.ts`.
- Inspetor deriva gravidade e escape de `settings.gravitationalConstant`; mantém diâmetro visível e omite gravidade/escape de buraco negro com limite explícito de ausência de relatividade geral em `src/features/simulation/ObjectInspector.tsx`.

## Limites

Revisão estática independente não encontrou P1/P2 nos focos acima. Limites: não é revisão global de todos os gates da Fase D; E2E não cobre teclado/acessibilidade, fluxo W/m² nem ledger físico completo/absorção; auditoria de proveniência/licença científica não foi concluída. Os 24 E2E legados tinham passado em rodadas anteriores, mas não foram reexecutados nesta etapa.
