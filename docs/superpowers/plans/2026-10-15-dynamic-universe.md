# Plano: universo dinâmico

Status: D02 concluído. Comet reportou `pnpm check` aprovado (231/231 unitários, lint sem erros, typecheck, regras e build; 1 warning preexistente) e Playwright Chrome 24/24 em 145223 ms, ambos antes do micro ajuste final de scrollbar. Quill verificou o micro CSS em Chrome CLI a 320×740 e 480×844 e capturou/inspecionou explosão, colisão e close-up lunar; servidor local respondeu HTTP 200. BH em 10Rs não foi verificado visualmente. Não houve E2E ou check completo após o micro CSS.

## Retomada e ownership

- Checkout observado nesta retomada: `astro/web-foundation`, com alterações locais e arquivos não rastreados preexistentes. Preservar; sem commit, deploy, configuração global ou dependências novas.
- Coordenação: Codex. Implementação: Kepler (núcleo físico/Worker), Umbra (render/Canvas), Lyra (UI), Comet (E2E/assets), Vega (revisão independente), Quill (documentação; micro CSS final liberado após smoke). Quill não altera testes nem executa gates globais.
- Cada arquivo de código tem um escritor exclusivo. Quill é escritor exclusivo de `docs/**`, `PRODUCT.md`, `README.md` e `public/textures/ATTRIBUTION.md`.
- O coordenador informou que seis processos/agentes e FullAccess foram conferidos em sua sessão e que seis agentes estão conectados ao root. O `maestri list` desta sessão Quill mostrou somente Quill e Codex; despacho deve ocorrer no root conforme essa conexão.
- A pesquisa e os diagnósticos originais permanecem em [dynamic-universe-research.md](../specs/2026-10-15-dynamic-universe-research.md). Não refazer pesquisa histórica.

## D0 — diagnósticos concluídos conforme relato do coordenador

- Órbita: atraso de reconstrução/cache de 1.500 ms reproduzido no histórico; 19 verificações focadas relatadas nesse histórico. A órbita heliocêntrica da Lua órfã após remoção da Terra é a expectativa correta do modelo; não é bug da gravidade. Manter guias osculantes distintos da trajetória integrada N-body. Não declarar correção nem gates atuais concluídos.
- Física: P2 de recuperação confirmado no diagnóstico inicial. Kepler reporta correção por presets `1/60/600` e valor restaurado `60` após caminho de erro; fechamento ainda requer QA final.
- Design: Lyra reporta UI final com grid móvel de duas colunas, controles de 44 px, tipografia mínima de 11 px e áreas reservadas do rodapé. Patch curto remove `min-height: 640px`; em viewport `<=760px` e altura `<=600px`, limita a altura do rodapé e permite somente scroll vertical. Editor/catálogo usam topo em `64px` e base no rodapé real; avisos, erros e cena foram ajustados sem área negativa. Desktop e viewports 740/844 permanecem iguais, conforme relato. Quill confirmou scrollbar oculta e scroll/foco funcionais em 320×740 e 480×844; não repetiu E2E completo.
- Assets: Comet preparou três mapas lunares; detalhes e limites foram registrados nos créditos. Nenhum asset terrestre novo foi obtido.
- Esses relatos fecham D0 conforme o coordenador; não constituem aprovação global de QA nem resultado de gate nesta retomada.

## Contrato congelado

- Mutação: `WorldMutation` inclui `{ type: 'EXPLODE_BODY'; bodyId: string }`.
- Wrapper existente permanece `PendingWorldMutation = { revision; mutation }`; `client.mutateWorld` não muda.
- Snapshot: `SimulationSnapshot.events?: readonly SimulationEvent[]`.
- Evento exportado: `SimulationEvent = { id: number; type: 'collision' | 'explosion'; timeSeconds: number; positionM: Vector3; radiusM: number; energyJ: number; bodyIds: string[] }`.
- Os tipos de mutação/evento estão prontos. `SimulationEvent.id` é number. A física e o ciclo de eventos ainda estão em implementação.
- IDs numéricos crescem monotonamente durante a vida do Worker, inclusive em `SET_WORLD`; `SET_WORLD` limpa somente o buffer. Worker novo inicia IDs em 1. UI de import/reset define `seenEventId = -1`. Buffer mantém até 16 eventos. Emitir somente após mutação/integração válida; rollback não deixa evento fantasma. Eventos não entram no JSON v2.
- Render deduplica por ID e mostra efeito por 3 segundos reais; respeita `prefers-reduced-motion`.
- Explosão manual é fragmentação experimental de seis fragmentos simétricos, conservando massa e momento linear; energia adicionada vem de fonte externa e deve ser contabilizada. Não representa supernova. Anãs brancas, estrelas de nêutrons e buracos negros não explodem.
- Colisão usa esferas com detecção contínua aproximada pelo segmento dentro dos subpassos para reduzir tunneling. Fusão completamente inelástica conserva massa e momento linear; raio resultante conserva soma dos volumes. Não representa hidrodinâmica nem conserva spin.
- Preservar limite de 64 corpos, validação atômica e estado autoritativo atual do Worker, sem rewind. Sem relatividade geral, clima real ou alegação de precisão profissional.
- Fragmentos usam IDs `{sourceId}-fragment-{first-unused-generation}-{1..6}`; evento lista corpo fonte e seis fragmentos. Energia externa específica: `1e6 J/kg`.
- Fixture de colisão reportada: `impact-a` sobrevive a `impact-b` (massa maior; empate lexical), massa final `2e15 kg`, velocidade `0 m/s`, raio `∛2 × 1000 m`; evento lista `['impact-a', 'impact-b']`.
- Recovery reportado pelo Core: presets `1/60/600`; valor restaurado `60` após caminho de erro. Verificação elíptica reportada: passos `20/10/5` vs `2.5` em `400 s`, razão de erro `3.5–4.5`, deriva de energia `<1e-8` e deriva de momento linear/angular `<1e-12`.

## Ondas e tarefas

| Onda | ID / entrega e estado reportado | Files: | Depends-on: | Owner |
|---|---|---|---|---|
| 1 | K01 — Core implementado conforme relato Kepler; 90/90 Vitest em 5 arquivos e typecheck reportados | `src/simulation/types.ts`, `src/simulation/world-mutations.ts`, `src/simulation/world.ts`, `src/simulation/physics.ts`, `src/simulation/simulation.worker.ts`, `src/simulation/simulation-client.ts`, `src/simulation/save-file.ts`, `src/simulation/physics.test.ts`, `src/simulation/world.test.ts`, `src/simulation/simulation.worker.test.ts`, `src/simulation/simulation-client.test.ts`, `src/simulation/save-file.test.ts` | none; contrato congelado | Kepler |
| 1 | U01 — render e foco/câmera reportados; render 9/9, resize focus 5/5, ESLint 0; P3 BH ajustado a 10Rs, sem confirmação visual ainda | `src/features/simulation/SimulationCanvas.tsx`, `src/features/simulation/celestial-scene.ts`, `src/features/simulation/celestial-bodies.ts`, `src/features/simulation/body-texture.ts`, `src/features/simulation/camera-focus.ts`, `src/features/simulation/celestial-bodies.test.ts`, `src/features/simulation/body-texture.test.ts`, `src/features/simulation/camera-focus.test.ts` | none; contrato congelado | Umbra |
| 1 | L01 — UI final reportada; 9/9 focados + lint, Vega sem P1/P2; micro CSS da scrollbar validado em Chrome CLI a 320×740 e 480×844 | `src/app/page.tsx`, `src/app/globals.css`, `src/features/simulation/SimulationToolbar.tsx`, `src/features/simulation/ObjectInspector.tsx`, `src/features/simulation/BodyCatalog.tsx` | none; contrato congelado | Lyra; micro CSS Quill, liberado |
| 1 | D01 — registrar contrato como em andamento, créditos e fatos/limites documentais | `docs/superpowers/plans/2026-10-15-dynamic-universe.md`, `docs/superpowers/specs/2026-10-15-dynamic-universe-research.md`, `docs/architecture.md`, `docs/design.md`, `docs/physics.md`, `PRODUCT.md`, `README.md`, `public/textures/ATTRIBUTION.md` | none; contrato e relatório de Comet fornecidos | Quill, somente docs |
| 2 | C01 — `pnpm check` reportado aprovado: 231/231 unitários, lint 0 erros/1 warning preexistente, typecheck, regras e build; Playwright Chrome 24/24 em 145223 ms antes do micro CSS final | `e2e/simulation.spec.ts` | K01, U01, L01 | Comet |
| 2 | Q01 — smoke pós-micro CSS em 320×740 e 480×844; barra oculta, `overflow-x:auto`, rolagem e foco verificados. HTTP 200 no servidor local PID 28256. Três capturas inspecionadas; BH 10Rs não foi verificado | `src/app/globals.css`, `.playwright-cli/qa-explosion-1440x900.png`, `.playwright-cli/qa-collision-flash-1440x900.png`, `.playwright-cli/qa-moon-closeup-1440x900.png` | L01 e C01 | Quill; micro CSS liberado |
| 2 | V01 — revisões Core/render/UI sem P1/P2 após delta CSS/câmera. Capturas confirmam efeitos de explosão/colisão e mapa lunar; não equivalem a confirmação visual do BH 10Rs | arquivos produzidos por K01, U01, L01, C01 | K01, U01, L01, C01 | Revisões reportadas; evidência visual pontual Quill |
| 3 | D02 — docs finais atualizados com contagens, smoke e limitações; BH 10Rs segue não verificado visualmente | `docs/superpowers/plans/2026-10-15-dynamic-universe.md`, `docs/architecture.md`, `docs/design.md`, `docs/physics.md`, `docs/setup.md`, `docs/quality.md`, `PRODUCT.md` | K01, U01, L01, C01, Q01 e V01 | Quill, somente docs |

K01, U01 e L01 têm arquivos disjuntos. Implementadores não fazem commit. Comet reporta `pnpm check` completo e Playwright Chrome 24/24 antes do micro CSS final. Quill executou smoke em Chrome CLI pós-CSS nos viewports 320×740 e 480×844: `.planet-navigation` manteve `overflow-x:auto`, `scrollbar-width:none`, WebKit `display:none` e scroll. Tab alcançou o décimo botão (Netuno) e rolou o container até `scrollLeft=228`. Capturas de explosão experimental, fusão e Lua foram abertas e inspecionadas; mapa lunar 4K respondeu 200. O servidor dev em primeiro plano responde HTTP 200 na porta 3000, PID 28256. Não houve E2E/check completo após micro CSS. BH em 10Rs permanece sem verificação visual.

## Relatório de assets — Comet

Arquivos já preparados no checkout; não substituir nem editar os originais existentes:

| Saída local | Bytes; dimensão | Origem e transformação |
|---|---|---|
| `public/textures/moon-lroc-color-2k.jpg` | 457.942; 2048×1024 | NASA SVS `lroc_color_2k.jpg`; JPEG 24 bpp RGB decodificado por System.Drawing. |
| `public/textures/moon-lroc-color-4k.jpg` | 2.045.247; 4096×2048 | Derivado do TIFF `lroc_color_16bit_srgb_4k.tif` (61.891.324 bytes); conversão para JPEG 24 bpp RGB por System.Drawing. Cor otimizada para estética; não implica endosso NASA. |
| `public/textures/moon-lola-height-2k.jpg` | 497.496; 2048×1024 | Derivado de `ldem_4.tif` (4.153.352 bytes); escala relativa de 1.737,4 km, grayscale JPEG lossy, 24 bpp RGB por System.Drawing. Relevo ilustrativo somente; não é altimetria científica. |

Fontes: [NASA SVS Moon Kit](https://svs.gsfc.nasa.gov/4720/), [LROC 2K](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_2k.jpg), [LROC 16-bit sRGB 4K TIFF](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_16bit_srgb_4k.tif), [LOLA `ldem_4.tif`](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_4.tif), [diretrizes de mídia NASA](https://www.nasa.gov/nasa-brand-center/images-and-media/). Créditos: NASA SVS / Ernie Wright / Noah Petro. NASA não endossa Astro. Pedido de Earth normal map Solar System Scope retornou 403; nenhum asset terrestre novo foi baixado. Os ativos anteriores permanecem intactos.

## Limites de validação e fechamento

- Quill não executou gates globais. Comet reporta `pnpm check` aprovado (231/231 unitários; lint, typecheck, regras e build; 1 warning preexistente) e Playwright Chrome 24/24 em 145223 ms, antes do micro CSS final.
- Smoke Playwright CLI após micro CSS passou em 320×740 e 480×844. Capturas verificadas: `.playwright-cli/qa-explosion-1440x900.png`, `.playwright-cli/qa-collision-flash-1440x900.png` e `.playwright-cli/qa-moon-closeup-1440x900.png`. HTTP 200 na porta 3000; PID 28256, `node.exe`, Next `start-server.js`. BH em 10Rs não foi verificado visualmente. O servidor segue em primeiro plano nesta sessão.
- Registrar erro intermediário de seletores TypeScript como corrigido antes do check final; trace JS de lint ficou apenas nos artefatos. Artefatos foram movidos para `TempAstro-QA-data-2026-10-16-1e3c1deaeb4b42f69c7f8030321bbf85`; nenhuma regra/config ESLint foi alterada.
- Corrigir órbita só na camada visual/caching reproduzida. Não mudar o modelo orbital heliocêntrico correto da Lua órfã.
- Fechar documentação de produto somente após implementação, QA focada e revisão; manter simplificações e fontes externas visíveis.
