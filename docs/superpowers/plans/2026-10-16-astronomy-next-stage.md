# Próxima etapa — órbitas e astronomia

## Retomada de auditoria em 16/10/2026

O estado real e as decisões posteriores estão em [auditoria técnica](../../audit-2026-10-16.md). Binárias e trilhas já existiam; foram preservadas. Novos deltas: periastro parabólico sem `NaN`, guias ocultas sem recálculo, enquadramento sem reservar espaço para painéis fechados, informação correta de colisão, exclusão de gerados do Graphify e ensaios científicos/de contato. Não há novo cenário ou redesenho. A proposta de medições derivadas no inspetor aguarda resposta do usuário, separada das correções autorizadas.

Data: 16/10/2026. Status: binário e trilha entregues; QA final reportado por Prisma. Não há P1/P2 confirmados; oportunidades visuais mobile/contraste não têm alvos medidos nem quebra funcional demonstrada.

## Escopo e ownership

- Codex coordena contratos/ondas. Aster: `src/features/simulation/orbit-trails.ts` + teste, `src/features/simulation/celestial-scene.ts` + teste, `src/features/simulation/orbit-paths.ts` + teste e `src/features/simulation/SimulationCanvas.tsx` para snapshot/legenda. Prisma: QA Chrome read-only, sem editar nem criar E2E. Quill: docs/nota e ownership temporário exclusivo de `src/simulation/binary-star.ts`, `src/simulation/binary-star.test.ts` e `src/features/simulation/SaveControls.tsx`. Um escritor por arquivo.
- Quill confirmou checkout `astro/web-foundation`, com mudanças locais e arquivos não rastreados preexistentes. Tudo foi preservado. Next dev permanece em primeiro plano na porta 3000, PID 4000; não interromper sem coordenação.
- Gates finais reportados por Prisma: `pnpm check` PASS (240 testes/29 arquivos; lint 0 erros/1 warning legado; typecheck, regras e build verdes) e Playwright Chrome 24/24 em 181079 ms. Smoke visual pós-release concluído; veja evidências abaixo.

## Correções existentes autorizadas

1. **Guia orbital desalinhada/atrasada.** Histórico registra atraso reproduzido em 1.500 ms e 19 verificações focadas. Em investigação atual, Aster informa que causa geométrica não foi reproduzida, baseline passou 6/6 e FP foi coerente; não alegar bug corrigido. A trilha histórica é feature distinta: somente snapshots Worker aceitos, `{ bodies, timeSeconds, revision, generation }` atômico; geração muda com revisão e limpa amostras/interpolação, inclusive `SET_WORLD` na mesma instância com IDs iguais. Props otimistas não entram no buffer. Até 256 amostras reais por corpo, espaçadas por 86.400 s simulados, mais ponta atual apenas se coincidir com posição autoritativa. Curva osculante segue tracejada e estimada.
2. **Recuperação de simulação.** P2 anterior foi corrigido e teve verificações focadas reportadas na etapa anterior. Não reabrir sem evidência de regressão atual.
3. **Órbita da Lua após remoção da Terra.** Comportamento heliocêntrico é esperado ao manter estado cinemático e remover força da Terra. Não é correção autorizada nem defeito.

## Comparação curta de cenários

Impacto = utilidade didática/visual; esforço = trabalho de produto provável; custo = carga adicional sobre simulação/render. Estimativas qualitativas para decidir investigação, não medições.

| Cenário | O que a infraestrutura atual suporta | O que não suporta | Impacto | Esforço | Custo | Parecer |
|---|---|---|---:|---:|---:|---|
| Estrelas binárias | Catálogo já cria estrelas e define velocidade circular em torno de um corpo escolhido; gravidade N-body aplica forças entre todos os corpos. Um par isolado pode orbitar em torno do baricentro sem nova lei de força. | Não há tratamento de evolução estelar; iluminação da cena escolhe uma fonte dominante, então duas estrelas não dão iluminação física completa. | Alto | Baixo/médio | Baixo | Cabe como cenário demonstrativo reutilizando catálogo; validar estado inicial e baricentro. |
| Encontro/impacto de asteroides | Catálogo cria asteroides; gravidade Newtoniana permite encontro; colisão existente detecta contato e funde esferas conservando massa/momento linear/volume. Evento mostra impacto. | Sem fragmentação/ejecta de colisão, cratera, deformação ou hidrodinâmica. A ação manual Explodir é fragmentação experimental com energia externa, não DART. | Alto | Médio | Baixo/médio | Cabe somente como encontro ou fusão idealizada, com rótulo explícito. DART realista não cabe sem outro modelo. |
| Lua e anéis de Saturno | Preset já contém Saturno e render mostra anéis; catálogo pode criar Lua em torno de Saturno; N-body calcula atração entre corpos puntuais. | Anéis são geometria visual estática, sem partículas/massa; nenhuma dinâmica de anéis, ressonância Lua-anel, colisão entre grãos ou migração orbital. | Médio/alto | Baixo | Baixo | Cabe como Lua orbitando Saturno com anel ilustrativo; não prometer interação Lua-anel. |

## Cenário binário selecionável

Status: implementação local concluída em `src/simulation/binary-star.ts` e `src/features/simulation/SaveControls.tsx`; Vitest focado 3/3 e ESLint focado sem problemas. Smoke Prisma reporta duas estrelas e movimento a 1 mês/s (~80,54 dias); UI informa iluminação pela estrela dominante.

### Escopo e arquivos

- `src/simulation/binary-star.ts`: fábrica isolada `createBinaryStarSystem()`, baseada nos templates existentes em `body-catalog.ts`, retornando corpos e configurações naturais. Não altera `createSolarSystem()` nem o reset padrão. Quill, ownership adicional temporário.
- `src/simulation/binary-star.test.ts`: teste focado de valores, estado barycêntrico, estabilidade orbital e schema v2. Quill, mesmo ownership.
- `src/features/simulation/SaveControls.tsx`: botão acessível junto a Importar/Exportar; usa `onImport` existente, anuncia a substituição e o limite de iluminação. Quill, ownership adicional temporário.
- Prisma revisa visualmente no Chrome, read-only; não edita nem adiciona E2E. A automação E2E fica fora do ownership deste slice.
- Quill atualizou docs de física, design, arquitetura, produto, setup, qualidade e este plano após QA final.
- Sem mudanças em `src/app/page.tsx`, `SimulationToolbar.tsx`, `celestial-scene.ts`, `celestial-bodies.ts` ou `orbit-paths.ts`. `SaveControls` já está no transporte, e render/guia existentes desenham os corpos e a órbita relativa do secundário. Aster não tocou nos arquivos de propriedade Quill.

### Contrato e parâmetros

- Dois astros `star` idênticos, reaproveitando template atual: massa `1.9884e30 kg`, raio `695700000 m`, temperatura `5772 K`; `G = 6.6743e-11 m³ kg⁻¹ s⁻²` da constante atual.
- Separação relativa `r = 149597870700 m` (1 AU; mesma distância mínima do catálogo). Posições barycêntricas `±r/2` no eixo X. Velocidades `±v/2` no eixo Y, com `v = √(G × (m1 + m2) / r) ≈ 42121.8 m/s`; cada estrela começa a `≈21060.9 m/s` em torno do baricentro. Período relativo previsto `≈258.28 dias`.
- Fonte dos parâmetros solares: template/preset local derivado JPL/NASA, com referência JPL [Horizons](https://ssd.jpl.nasa.gov/horizons/manual.html) e parâmetros físicos [JPL Solar System Dynamics](https://ssd.jpl.nasa.gov/planets/phys_par.html). `1 AU = 149597870.700 km` conforme conversão do manual Horizons. Não é um sistema observado específico.
- Mantém `G` natural, modelo N-body Newtoniano e formato de mundo atual. Sem novas forças, tipos, dependências, protocolo Worker ou formato JSON. Iluminação mostra somente fonte dominante hoje; a cena não promete iluminação binária física.
- UI mínima: ação única dentro de Importar/Exportar existente; foco/teclado e `role=status` preservados. O rótulo informa que o mundo será substituído. Nenhum seletor novo ou redesenho.

### Verificação executada e pendente

- Unitário: dois corpos válidos; massas iguais; baricentro inicial/final `<1e-3 m`; momento linear inicial/final `<1e15 kg·m/s`; separação final dentro de ±1%; energia orbital negativa; deriva relativa de energia `<1e-3` após cinco períodos. Com `dt/T≈0.0039`, essa tolerância excede em mais de 60× a escala de erro de segunda ordem `(dt/T)^2`.
- Executado por Quill: `pnpm exec vitest run src/simulation/binary-star.test.ts` passou 3/3; cinco períodos levaram ~21 ms no arquivo Vitest. `pnpm exec eslint src/simulation/binary-star.ts src/simulation/binary-star.test.ts src/features/simulation/SaveControls.tsx` passou sem problemas.
- Prisma reporta smoke visual da binária: duas estrelas carregadas e movimento a 1 mês/s (~80,54 dias); UI indica iluminação dominante. E2E e gates globais finais estão registrados abaixo.

## Trilha histórica — entrega Aster

- Ownership: `orbit-trails.ts`/teste, `celestial-scene.ts`/teste, `orbit-paths.ts`/teste e `SimulationCanvas.tsx` para snapshot/legenda. Aster reporta 12/12 focados em três arquivos, ESLint nos sete arquivos e typecheck aprovados. Quill revisou o delta somente por leitura: snapshot autoritativo atômico remove a mistura otimista identificada; reseed de geração limpa interpolação; descarte da linha/geometria/material está presente. Sem P1/P2 encontrados nesta revisão estática. Nenhum teste, browser ou gate foi executado por Quill.
- Representação: trilha sólida de snapshots aceitos, máximo 256 por corpo, intervalo mínimo de um dia simulado. Tip móvel é habilitado quando a pose do corpo coincide com snapshot aceito e acompanha interpolação visual. Guia tracejada é cônica/osculante estimada, não trajetória física N-body contínua.
- Verificação geométrica continua sem causa reproduzida: histórico 1.500 ms/19 focados não prova bug atual; baseline atual reportado 6/6 e FP coerente. Não registrar correção de defeito orbital.
- Prisma reporta QA visual final; a trilha foi visível em movimento, com ocultação natural pela esfera e sem desalinhamento geométrico reproduzido. Não há P1/P2 confirmados.

## QA atual — relato Prisma

- `pnpm check`: PASS reportado; 240 testes em 29 arquivos, ESLint 0 erros e 1 warning legado, typecheck, regras e build Next.js 16.4.1 aprovados. Quill não reexecutou.
- E2E inicial: runner encerrou com código 1 antes de iniciar testes (0/0) por lock Next confirmado no mesmo checkout. Quill pausou somente seu processo 3000 após identificar PID 28256 e sessão própria.
- E2E final reportado por Prisma: Playwright Chrome 24 passed/0 failed, 181079 ms, em 3101 após liberação da porta 3000.
- Quill restaurou Next 16.4.1 em foreground; HTTP 200 em `127.0.0.1:3000`, listener PID 4000 (`node.exe`, `start-server.js`). Estado final no Chrome: 10 astros, Terra selecionada, 1 dia/s, pausado.
- Smoke Prisma: Lua mostra crateras/maria sem seam óbvia; não houve comparação pixel-centro concluída nem defeito claro. Captura da explosão mostra seis fragmentos e aviso; imagem estática não determina efeito efêmero ou pluma. Trilha visível em movimento; ocultação pela esfera, sem desalinhamento geométrico reproduzido. Mobile 390×844 corta trilho após Jupiter parcial, sem overflow do documento; oportunidade visual/risco UX, sem defeito funcional demonstrado. Contraste da trilha também é oportunidade não medida, não P2 confirmado.
- Capturas: `.playwright-cli/postrelease-trail-system.png`, `.playwright-cli/postrelease-binary-moving.png`, `.playwright-cli/final-state-10-paused.png`, `.playwright-cli/moon-texture-inspection.png`, `.playwright-cli/explosion-visual.png`, `.playwright-cli/mobile-trail-smoke.png`.

### Prioridade e limites

**Único cenário recomendado:** binária. Usa templates, gravidade e render atuais; apresenta movimento mútuo simples com valor visual alto e custo de runtime de dois corpos. Catálogo atual já calcula velocidade orbital circular, mas não corrige automaticamente a velocidade do primário para deixar baricentro estacionário; a fábrica isolada define os vetores simétricos acima.

Não priorizar elementos osculantes técnicos na UI. KOI-134, DART e interação Lua-anel permanecem ideias posteriores, não fazem parte deste slice. Não implementar nesta pesquisa.

## Fontes oficiais atuais

- JPL, [Horizons manual — reference frames, ecliptic e osculating elements](https://ssd.jpl.nasa.gov/horizons/manual.html): especifica quadros e cautela ao usar elementos osculantes.
- NASA Science, [KOI-134 planetary carousel](https://science.nasa.gov/universe/exoplanets/discovery-alert-scientists-spot-a-planetary-carousel/), 03/07/2025: relata inclinação mútua perto de 15°, ressonância 2:1 e inclinações variáveis por interação gravitacional.
- NASA Science, [DART planetary defense](https://science.nasa.gov/planetary-defense-dart/): o resultado observado inclui recoil de ejecta; NASA ressalta dependência das propriedades do asteroide.
- NASA, [Gravity & Mechanics — barycenter](https://science.nasa.gov/learn/basics-of-space-flight/chapter3-3/): ambas as estrelas orbitam o centro de massa comum; gravidade decai com o quadrado da distância.
- NASA Cassini, [Saturn rings](https://science.nasa.gov/mission/cassini/science/rings/): anéis têm partículas e interações dinâmicas; isto excede a geometria estática do Astro.
- NASA SVS, [CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/), atualizado em 09/01/2026: mapas de cor/elevacão usam dados LROC/LOLA; cor é otimizada para estética, e a elevação é relativa ao raio de 1.737,4 km.
- NASA Science, [Orbits and Kepler’s Laws](https://science.nasa.gov/solar-system/orbits-and-keplers-laws/), 02/05/2024: órbitas planetárias solares são aproximadamente alinhadas ao plano eclíptico; bom contraste para cenários inclinados raros.
- NASA SVS, [Supernova explosion animation](https://svs.gsfc.nasa.gov/20413/), 20/05/2026: mostra supernova de estrela massiva e remanescente; não valida a ação experimental de seis fragmentos do Astro.

## Melhorias futuras priorizadas — pesquisa fechada, sem implementação

Priorização considera utilidade didática, risco científico e reaproveitamento atual. Smoke final reportado por Prisma: sem defeito claro na textura lunar; captura de explosão mostra fragmentos/aviso, mas não resolve efeito efêmero ou pluma. Trilho mobile e contraste ficam como oportunidades visuais sem medição de alvo ou falha funcional.

1. **Astronomia amigável — prioridade alta, baixo custo.** Comparar Sistema Solar e binária usando presets/import atuais: “ambas as estrelas orbitam um baricentro comum”, com aviso de que iluminação usa somente a fonte dominante. Sem painel técnico de elementos osculantes e sem nova física. NASA descreve o movimento mútuo em torno do centro de massa [NASA — Gravity & Mechanics](https://science.nasa.gov/learn/basics-of-space-flight/chapter3-3/). Critério futuro: pessoa inicia a binária e identifica o baricentro e o limite de iluminação sem editar parâmetros.
2. **Texturas lunares com proveniência explícita — prioridade média, baixo/médio custo.** Manter mapa de cor como visualização e relevo JPEG como ilustrativo; separar essa apresentação de altimetria científica. Smoke não encontrou defeito claro, mas não houve comparação pixel-centro. Se precisão do relevo virar requisito, avaliar pipeline lossless de dados numéricos NASA (TIFF float/16-bit) e medir custo antes de adicionar resolução ou deslocamento real de geometria. NASA informa que o mapa de cor é otimizado para estética e documenta DEM LOLA em unidades relativas a raio `1737,4 km`; aplicação científica deve usar dados de origem [NASA SVS — CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/). Arquivos de origem usados: [lroc_color_2k.jpg](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_2k.jpg), [lroc_color_16bit_srgb_4k.tif](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_16bit_srgb_4k.tif) e [ldem_4.tif](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_4.tif). Altimetria local JPEG é lossy e apenas ilustrativa.
3. **Impacto/explosão com contabilidade honesta — prioridade posterior, alto risco de escopo.** Preservar fusão ideal e ação manual como conceitos distintos; UI futura deve explicar que fragmentação adiciona `1e6 J/kg` de energia externa e não é supernova. Captura final mostra seis fragmentos e aviso, mas não permite inferir duração/visibilidade de efeito efêmero nem plume. Um cenário tipo DART exige modelo de ejecta e dependência das propriedades do alvo: NASA reporta que o recuo de material ejetado contribuiu significativamente para a mudança de momento [NASA — DART Data Validates Kinetic Impact](https://www.nasa.gov/centers-and-facilities/marshall/dart-data-validates-kinetic-impact-as-planetary-defense-method/). Sem esses contratos, não representar explosão manual como impacto realista.

Estas recomendações não ampliam autorização de produto. Smoke final e contagens são relatos de Prisma; os arquivos PNG listados acima registram a evidência disponível.
