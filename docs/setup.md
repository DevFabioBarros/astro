# Setup e evidências

A [auditoria técnica de 16/10/2026](audit-2026-10-16.md) contém o inventário revalidado, a comparação atual com o toolkit e as medições no i5-1235U/Iris Xe. As entradas abaixo preservam o histórico; ausência de colisões/cena e pendências de integração descritas nas etapas antigas foram superadas pelo código posterior. Nenhuma ferramenta ou configuração global foi instalada nesta retomada.

`ASTRO_NEXT_DIST_DIR` pode apontar Next para uma pasta de saída dedicada dentro do checkout quando um `next start` existente precisa continuar usando `.next`. Sem essa variável, dev/build usam o padrão `.next`. Next controla e pode apagar o conteúdo da pasta configurada; use somente diretório dedicado.

## Benchmark do núcleo de simulação

Execute `pnpm bench:simulation` para medir `advanceSimulationInterval`/core em cenários sintéticos esparsos com 20, 32 e 64 corpos. O harness usa 30 warmups e 100 amostras por tamanho, com intervalo de 2.160 s simulados, e emite mediana e p95. Worker e render ficam fora da medição. Os resultados de [audit-2026-10-16.md](audit-2026-10-16.md) não são diretamente comparáveis: os cenários usados lá diferem.

## Sandbox acessível e experimentos — 2026-10-15

Continuação delegada pelo coordenador, com um escritor por arquivo e revisores independentes. `sandbox_physics` mantém `src/simulation/**`; `sandbox_render` mantém cena/sincronização; `sandbox_interface` mantém página, controles e catálogo; `sandbox_science_docs` mantém documentação/pesquisa. QA e revisores trabalham em escopos próprios. [Plano, arquivos e dependências](superpowers/plans/2026-10-15-friendly-sandbox.md).

Fontes NASA foram consultadas pelo agente de documentação sobre mecânica orbital, Lua, remanescentes e horizonte de Schwarzschild. [physics.md](physics.md) separa fatos da fonte, derivação Newtoniana e limitações. Interface, catálogo, remoção/reinício, codec v2 com leitura v1 e ações autoritativas foram conferidos nos arquivos implementados. Não houve instalação, publicação ou alteração global por esse agente.

Resultados reportados pelos agentes de implementação, revisão e QA:

| Verificação | Resultado deste recorte |
|---|---|
| Lint, tipos e regras | Passaram na execução final; um warning legado em `.superpowers/sdd/2026-10-15-astro-web-foundation/task-4-profile.cjs`, sem erros. |
| Testes unitários | 206/206 em 23 arquivos. |
| Chrome E2E | 18/18 passaram antes do CSS final, em 1,2 minuto. Após o CSS, 2/2 cenários focados passaram: inicialização com console limpo e geometria/foco/arraste móvel a 320 px. Não houve nova rodada dos 18 cenários após o CSS. |
| Responsividade e foco | Após o CSS final, imagens de 320×740 e 480×844 foram inspecionadas sem overflow ou sobreposição; navegação oculta com editor aberto e restaura ao fechar. Desktop 1440 px permaneceu correto. Testes focados de geometria, foco e arraste móvel passaram no Chrome. |
| Revisões complementares | Física/protocolo e documentação científica sem P1/P2; achado P2 de foco corrigido pelo escritor e confirmado pelo revisor e pelo Chrome. Sobreposição móvel do editor foi corrigida e reinspecionada após o CSS final. Permanece achado P3 de enquadramento do disco de buraco negro. |
| Regressões encontradas | Diferença de ULP em `Math.log10` entre renderizações causou aviso de hidratação; atributos foram normalizados a 12 dígitos significativos e receberam teste. UTF-8 foi corrigido em três arquivos do núcleo. |
| `pnpm check` | Execução final passou, incluindo build. Um warning legado de lint permanece. |
| Servidor local | QA reportou HTTP 200 em 3000 e PID 30572; nesta retomada, o PID foi confirmado como `node` ouvindo na porta 3000 e HTTP 200 foi revalidado. A sessão 60166 foi reportada, mas Maestri retornou `Unknown process id 60166`; sessão não confirmada. |
| Capturas | `.playwright-cli/astro-sandbox-desktop.png`, `astro-sandbox-catalog-desktop.png`, `astro-sandbox-mobile.png`, `astro-sandbox-mobile-editor-480.png` e `astro-sandbox-mobile-sliders.png`; 320×740/480×844 foram inspecionadas após o CSS final, sem overflow ou sobreposição. |
| Escopo físico residual | Modelo Newtoniano, sem relatividade geral, colisões ou evolução estelar; calibração em aparelho físico não testada. Achado P3: enquadramento do disco de buraco negro. |

Os 178 testes/6 E2E abaixo pertencem à revisão anterior. Emulação móvel não equivale a teste em aparelho físico ou benchmark de GPU. O modelo continua Newtoniano, sem colisões ou evolução estelar; os limites dos astros compactos estão em [physics.md](physics.md).

## Revisão imersiva — 2026-10-15

A pedido do usuário, a cena passou a usar proporções reais, tempo astronômico perceptível, órbitas osculantes e interface em unidades legíveis. A direção está em `superpowers/specs/2026-10-15-immersive-sandbox-design.md`; a divisão de arquivos, responsáveis e ondas está no plano correspondente.

Implementação paralela com três escritores de escopos exclusivos: dinâmica, cena e interface. Revisores distintos examinaram física/orçamento, renderização/sincronização e UI/conversões. Os achados relevantes foram corrigidos pelos respectivos escritores; revisão final não encontrou P1/P2. Coordenador pesquisou fontes, integrou ativos/E2E e inspecionou screenshots. Nenhum arquivo teve escritores concorrentes; nenhum commit/push foi executado.

| Verificação | Resultado desta revisão |
|---|---|
| `pnpm check` | Passou: lint, tipos, regras, 21 arquivos/178 testes e build. Permanece um warning preexistente em `task-4-profile.cjs`, sem erros. |
| `pnpm exec playwright test` | 6/6 no Chrome instalado: inicialização sem erros JS/shader, navegação, unidades/arquivo, movimento orbital real e pausa, adição após importação, editor móvel e fallback WebGL. Execução sequencial evita concorrência artificial por memória GPU. |
| Modelo/ativos | GLB local preservado; 15 JPEG locais decodificados pelo Windows, Terra e céu 8192×4096, variantes e demais mapas 2048×1024. Fontes Solar System Scope / INOVE e licença CC BY 4.0 em `public/textures/ATTRIBUTION.md`. |
| Inspeção visual | Chrome, desktop 1440×900 e celular emulado 320×740/390×844. Terra, céu, foco/sistema, órbitas e painel recolhível examinados por screenshots. Não equivale a benchmark GPU ou teste em aparelho físico. |
| Física | Teste mensal verifica deslocamento terrestre, raio orbital finito e erro relativo de energia abaixo de `1e-5`. Limite 64 astros e orçamento 100.000 avaliações de pares/512 subpassos possuem regressões. |
| Graphify | Extração local `--code-only --no-cluster`, auto-refresh desativado: 329 nós/750 arestas; 38 arquivos de código atualizados e 30 inalterados. Oito arquivos não produziram símbolos; CSS/GLB ficaram fora da extração. Nenhum LLM utilizado. |
| Estado final | `git diff --check` sem erros; alterações existentes e arquivos não rastreados preservados. Servidor local reiniciado na porta 3000. |

Node `v24.21.0`, pnpm `12.11.2` e Chrome `155.0.8059.40` foram reutilizados; nenhuma dependência foi adicionada. Um cache de CSS do servidor dev reteve versão antiga durante a revisão; reiniciar o servidor resolveu, sem apagar mudanças do workspace. Na retomada, use shell sem perfil se o fnm impedir a seleção do Node que já está instalado.

Referências examinadas: [Sandbox Universe](https://yandex.com/games/app/sandbox-universe-510828), [Universe Sandbox](https://universesandbox.com/faq/) e [Solar Textures](https://www.solarsystemscope.com/textures/). Nenhum código, marca ou ativo do jogo de referência foi copiado.

## Origem e inventário

Verificado em 2026-10-15 no Windows/PowerShell. Toolkit local `vibe-coding-toolkit`, revisão única `323f95f0379e2338160c4d7fe619b878fad9edec`, licença MIT. Foram consultados prompt 12 completo, defaults, bootstrap, catálogo de ferramentas/templates e templates pertinentes. O design e o plano aprovados em `docs/superpowers/` foram preservados.

A pasta inicial ainda não era um repositório Git. O controlador inicializou Git, sem remoto, e registrou spec/plano e `.gitignore` no commit base da branch `main`; a implementação segue em `astro/web-foundation`, sem worktree. Git 2.55.0.windows.5. Nenhum check anterior existia antes do scaffold.

Node efetivo 24.21.0; pnpm 12.11.2; RTK 0.50.0; Graphify 0.9.91; Playwright CLI 0.1.22. `environment-manifest.json` não existe no caminho global indicado: confirmado por `Test-Path`, sem inferir versões do exemplo datado. O perfil PowerShell mostrou aviso do fnm; execução sem perfil evitou o aviso sem alterar a máquina.

Cliente: Codex com ferramentas nativas e skills descobertas. Superpowers e Ponytail estão expostos por plugins; Caveman, Graphify, React best practices, web design guidelines e find-skills aparecem no catálogo da sessão. Context7 remoto está exposto por MCP; já foi consultado no planejamento pelo controlador para Next/Three e não foi duplicado nem autenticado novamente nesta tarefa. Nenhuma nova sessão foi iniciada para provar redescoberta de skills. Modelo/esforço foram herdados do controlador; identificador efetivo e custos não são observáveis pelo trabalhador e não são estimados.

## Fontes e resolução

- [create-next-app oficial](https://nextjs.org/docs/app/api-reference/cli/create-next-app) e [instalação Next](https://nextjs.org/docs/app/getting-started/installation), consultados nesta data.
- Registry npm, por `pnpm view <pacote> dist-tags.latest engines peerDependencies --json`; `eslint-config-next@16.4.1` e `@types/node@24.19.2` foram conferidos separadamente.
- `pnpm dlx create-next-app@16.4.1 --help` confirmou flags reais. Scaffold externo único, sem instalação nem Git: `--typescript --tailwind --eslint --app --src-dir --import-alias '@/*' --use-pnpm --empty --skip-install --disable-git --no-react-compiler --no-cache-components --no-agent-feedback --yes`. Diretório temporário foi registrado apenas no relatório local ignorado.
- [Skills upstream](https://github.com/vercel-labs/agent-skills), revisão HEAD observada `063bee94c3f4df8453406c830b0a7df0f2860278`; listagem real de nove skills por `skills@1.7.2`. [CLI e find-skills](https://github.com/vercel-labs/skills), listagem real de uma skill. Não houve novidade em relação ao catálogo desta revisão do toolkit.

Next exige Node >=20.9; ESLint 10 admite Node >=24; Vitest 5 admite Node ^24; Playwright exige >=20; a CLI skills exige >=22.20. O Node efetivo atende. React DOM 19.3.1 exige React ^19.3.1. Next admite React ^19. O registry apontou TypeScript latest 7.0.2 e tipos Node latest 26.6.5; foram mantidos TypeScript major 5 do scaffold (5.9.3) e tipos Node major 24 exigidos, evitando migração desnecessária e mantendo runtime alinhado.

## Versões efetivamente instaladas

| Pacote | Versão | Escopo |
|---|---|---|
| next / eslint-config-next | 16.4.1 | produção / desenvolvimento |
| react / react-dom | 19.3.1 | produção |
| three | 0.186.1 | produção |
| zod | 4.6.7 | produção |
| tailwindcss / @tailwindcss/turbopack | 4.3.3 | desenvolvimento |
| typescript | 5.9.3 | desenvolvimento |
| eslint | 10.12.0 | desenvolvimento |
| vitest | 5.0.5 | desenvolvimento |
| @playwright/test | 1.64.1 | desenvolvimento |
| @types/node | 24.19.2 | desenvolvimento |
| @types/react / @types/react-dom | 19.3.0 | desenvolvimento |
| @types/three | 0.186.0 | desenvolvimento |

`pnpm list --depth 0` confirmou estas versões. `packageManager` fixa `pnpm@12.11.2`; engines fixa `>=24.21.0 <25`; `pnpm-lock.yaml` registra resolução/integridade. `pnpm-workspace.yaml` foi gerado pelo pnpm 12: scripts de sharp/unrs-resolver negados, e três exceções exatas de idade para Vitest 5.0.5 e seus pacotes mocker/spy. Não houve `--force`, desativação de auditoria ou override de peers. O build funcionou com essas decisões explícitas. Nenhuma biblioteca de banco, logger servidor ou credencial foi adicionada.

## Modelo 3D e texturas

`public/models/astro-sphere.glb` é um GLB 2.0 local, gerado de forma determinística por `node scripts/generate-sphere-glb.mjs`. A esfera UV compartilhada tem 64 × 32 segmentos; `GLTFLoader` carrega o arquivo na cena. Na revisão imersiva, mapas Solar System Scope substituem os placeholders dos astros conhecidos. `body-texture.ts` mantém mapas procedurais determinísticos de 256 × 128 como fallback e para corpos adicionados.

Foi pesquisada no Sketchfab a listagem [Sphere — 3DVarious](https://sketchfab.com/3d-models/sphere-b31b12ffa93a40f48c9d991b6f168f4d), com licença CC Attribution. O modelo não foi baixado: a listagem não confirmou UV e o acesso de download requer autenticação. O GLB local evita depender de um arquivo de origem cuja malha/UV não foi verificada. Blender não foi necessário; `blender` não foi encontrado no PATH nem no diretório padrão consultado.

## Skills e portabilidade

Instalação inicial suportada por projeto: `pnpm dlx skills@1.7.2 add vercel-labs/agent-skills --skill vercel-composition-patterns writing-guidelines vercel-react-view-transitions vercel-optimize deploy-to-vercel vercel-cli-with-tokens --agent codex --copy --yes`. O modo copy evita junctions absolutos no Windows. O registro inicial encontrou seis cópias locais; as três entradas novas abaixo foram reconciliadas em 27/10/2026 com `skills-lock.json` e `.agents/skills`.

| Nome real | Estado / versão de metadados | Origem | Licença verificada | Hash em skills-lock.json |
|---|---|---|---|---|
| vercel-composition-patterns | local, 1.0.0 | vercel-labs/agent-skills | MIT declarada | 10eb4ec94577b79ae98c63ce3e7f35f8a6a06436a4011bff083b397de6960eeb |
| writing-guidelines | local, 1.0.0 | vercel-labs/agent-skills | não verificada | 9c221f46dca7bdf94af9c27ce54a7b4ea323c590333f8bc0a55c65254c646584 |
| vercel-react-view-transitions | local, 1.0.0 | vercel-labs/agent-skills | MIT declarada | 12f8e118b8ca5fa45e3f0b56c269fb2e35251b705d2320b26b0727a0f58adefc |
| vercel-optimize | local, 1.2.0 | vercel-labs/agent-skills | não verificada | fb87d3a135fef30748f772200a9f161f780b5a16830e8e70a3a126195cb16963 |
| deploy-to-vercel | local, 3.0.0 | vercel-labs/agent-skills | não verificada | 3a0481591523c55ecfe2569b6b28b2dcbfa3742367667697219d29170981ad53 |
| vercel-cli-with-tokens | local, 1.0.0 | vercel-labs/agent-skills | não verificada | d3ad6e1d6278a4df322ee5bf49211f921f4aaea1148fb127b4e928de04b39fef |
| impeccable | local, 4.8.0 | pbakaus/impeccable | [Apache-2.0](https://github.com/pbakaus/impeccable/blob/main/LICENSE) | 08c1403e2daff28509af4ca7fc5915cb748b1a6b72181b6142ba35fb2c258d89 |
| web-design-guidelines | local, 1.0.0; também disponível globalmente | vercel-labs/agent-skills | não verificada | d8e7d3afe37dcc8a97b99ffb5afdb4d0919ae0092ea8b68f44eb201f035e33ac |
| playwright-cli | local; versão não declarada no frontmatter | microsoft/playwright-cli | [Apache-2.0](https://github.com/microsoft/playwright-cli/blob/main/LICENSE) | d4983e06b5daae441e48604b4b813a0c38784f3d87ea58f8391d2b5ffeb803fd |
| vercel-react-best-practices | reutilizada global da sessão | — | — | não copiada / sem lock local |
| find-skills | reutilizada global da sessão | — | — | não copiada / sem lock local |
| vercel-react-native-skills | inaplicável: não há React Native/Expo | — | — | não instalada |

No levantamento inicial, `vercel-react-best-practices`, `web-design-guidelines` e `find-skills` eram apenas globais; `web-design-guidelines` também tem cópia local neste registro. Outro checkout precisa descobrir as skills globais ou instalar cópias locais com a mesma CLI, sem `--global`. O app e seus checks não dependem de skills. Atualizações deliberadas: conferir `pnpm dlx skills@1.7.2 update --help`, revisar fontes e executar `update --project --yes`, inspecionando diff e lock.

No conjunto inicial, composição e transições declaram MIT; as outras quatro licenças não foram verificadas. Impeccable declara Apache-2.0 no LICENSE upstream; não afirmo licença para web-design-guidelines ou playwright-cli. `NOTICE.md` registra a limitação do conjunto inicial. A licença MIT do código copiado do toolkit está em `eslint-rules/LICENSE`. Skills de deploy/otimização/transições estão somente disponíveis; nenhum fluxo de nuvem, token ou API experimental foi ativado.

## Matriz de aplicabilidade — catálogo de ferramentas

Estados: **reutilizado** = capacidade existente; **configurado** = arquivos locais; **validado** = execução observada; **inaplicável** = sem necessidade atual; **pendente** = condição explícita para retomar. A coluna final combina risco/critério de verificação; nenhuma linha autoriza efeitos externos.

| Componente do catálogo | Necessidade / ação e escopo | Estado, dependência e critério |
|---|---|---|
| 01 Superpowers | Processo existente; spec/plano aprovados, execução delimitada | Reutilizado no cliente; não repetir aprovações; validar por brief/checks |
| 02 Subagentes | Um implementador por tarefa, com um escritor por arquivo | Reutilizado no host; sem subdelegação; controlador revisa cada diff |
| 03 RTK | Binário e instrução global existente de saída condensada | Reutilizado, 0.50.0; sem novo wrapper/hook; compressão nativa não provada separadamente |
| 04 Ponytail | Menor mudança completa | Reutilizado full, SKILL.md lido; sem plugin duplicado |
| 05 Caveman | Conversa concisa em português | Reutilizado por preferência; documentos com redação normal |
| 06 ESLint/Biome | Qualidade JS/TS | ESLint leve configurado/validado; Biome inaplicável sem lacuna adicional; peers antigos documentados |
| 07 Graphify | Relações locais de código | CLI reutilizada; extração e consulta validadas; exclusões locais; sem LLM externo |
| 08 Obsidian/MCP | Memória externa | Inaplicável: docs versionados bastam; reconsiderar com necessidade e destino autorizado |
| 09 Memória Claude | Contexto em camadas | Reutilizada por equivalente: AGENTS curto e docs detalhados; ponte CLAUDE; memória Claude não executada |
| 10 Hooks do cliente | Automação opcional | Inaplicável nesta base; preservar integrações globais; nenhum novo hook necessário |
| 11 agent-browser | Automação UI | Substituído por Playwright CLI existente + Chrome isolado; smoke validado; nenhuma instalação redundante |
| 12 Context7 | Documentação atual | Reutilizado MCP exposto; consulta do planejamento reportada pelo controlador; nenhuma nova consulta nesta tarefa |
| 13 Anthropic Skills | Artefatos / criação de skills / MCP builder | Inaplicável: nenhum Office/PDF/MCP/skill novo pedido; capacidades equivalentes já no host |
| 14 Chrome DevTools MCP | Console/rede/performance | Reutilizado equivalente Playwright para console/rede; sem MCP novo; traces pendentes até cena interativa existir |
| 15 Codex | Cliente e instruções corretas | AGENTS e skills locais configurados; sem copiar settings Claude; descoberta em sessão nova pendente |
| Maestri | Delegação e revisão no workspace do usuário | Papel local `Astro Read-only Reviewer` criado; projeto consta como confiável no Codex; execução do terminal/agente não foi validada nesta sessão |
| 16 Vercel skills | Web Next/React | Seis locais + três globais; hashes/frontmatter/listagem validados; mobile inaplicável |
| aia-harness | Onboarding alternativo | Inaplicável: duplicaria harness explícito e é direcionado a Claude |
| ui-ux-pro-max | UI especializada | Reutilizável do host; não ativada para página vazia; aplicar quando houver interface substancial |
| hookify / plugins oficiais Claude | Hooks, revisão, commits | Inaplicável: host Codex e nenhuma lacuna; não instalar marketplace/global |
| Habilidades de documentos / skill-creator | Artefatos especializados | Inaplicável no produto atual; não vendorizar material desnecessário |
| Modelo/provedor/API paga | Execução LLM | Preservados host e autenticação; sem proxy, chaves, billing ou troca de modelo |

## Matriz de aplicabilidade — todos os templates

| Template / grupo completo | Ação / destino ou motivo | Verificação / risco |
|---|---|---|
| project-docs/manifest.json | Reutilizado como mapa dos nove documentos | Nove destinos criados com fatos; nenhuma fonte concorrente |
| product.md.template | Adaptado para PRODUCT.md | Futuro claramente planejado, sem banco |
| AGENTS.md.template | Adaptado para AGENTS.md | Comandos reais, acordos, fontes sob demanda, bloco Next preservado |
| CLAUDE.md.template | Adaptado como `@AGENTS.md` | Ponte presente; cliente Claude não testado |
| project-docs/README.md.template | Adaptado para README.md | Execução local e mapa de docs |
| project-docs/architecture.md.template | Adaptado para docs/architecture.md | Estrutura implementada separada da planejada |
| project-docs/design.md.template | Adaptado para docs/design.md | UI atual e critérios de acessibilidade |
| project-docs/onboarding.md.template | Adaptado para docs/onboarding.md | Pré-requisitos, comandos e incidente fnm |
| project-docs/quality.md.template | Adaptado para docs/quality.md | Checks, alcance e limitações reais |
| project-docs/setup.md.template | Adaptado para este documento | Revisão, versões, fontes, matriz e evidências |
| eslint/next.config.mjs.example | Copiado para eslint.config.mjs | Perfil leve sem logger/DB; lint aprovado |
| eslint/eslint-rules/next-base.mjs | Copiado com baseline Next | Presets oficiais, teto 350; validado |
| eslint/eslint-rules/index.cjs | Copiado plugin local | Exportações testadas pelo self-check |
| eslint/eslint-rules/core-rules.cjs | Copiado regras locais | max-lines ativo; console/dados dormentes |
| eslint/eslint-rules/utils.cjs | Copiado helper das regras | Necessário ao plugin; self-check aprovado |
| eslint/verify.mjs | Adaptado em scripts/verify-quality-rules.mjs | Default já aceita ./eslint-rules/index.cjs; três regras aprovadas |
| eslint/next-app.config.mjs.example | Inaplicável | Perfil completo depende de contratos DB/logger ausentes |
| eslint/eslint.config.mjs.example | Inaplicável | Perfil avançado sem necessidade atual |
| eslint/eslint.typed.config.mjs.example | Inaplicável | Evita segundo perfil; tipos são gate separado |
| next/vitest.config.mts.example | Copiado para vitest.config.mts | Ambiente Node e alias validados |
| next/.env.example | Inaplicável | Sem variáveis necessárias; não criar credenciais fictícias |
| next/drizzle.config.ts.example | Inaplicável | Produto sem DB/migrations |
| next/src/db/index.ts.example | Inaplicável | Sem conexão/pool |
| next/src/db/index.test.ts.example | Inaplicável | Não testar infraestrutura ausente |
| next/src/db/schema/index.ts.example | Inaplicável | Sem tabelas fictícias |
| next/src/lib/env-schema.ts.example | Inaplicável | Sem ambiente secreto/DB a validar |
| next/src/lib/env.ts.example | Inaplicável | Sem contrato de ambiente |
| next/src/lib/env.test.ts.example | Inaplicável | Nenhum parser de ambiente criado |
| next/src/lib/logger.ts.example | Inaplicável | Sem operações servidor/log estruturado necessário |
| next/src/lib/logger.test.ts.example | Inaplicável | Não instalar Pino só para testar template |
| next/src/lib/utils.ts.example | Inaplicável | Sem composição de classes; não instalar clsx/merge preventivamente |
| project/.graphifyignore.example | Copiado/adaptado para .graphifyignore | Exclui segredo, skills, dependências e gerados |
| project/codex.config.toml.example | Inaplicável | Context7 já exposto; evitar segundo servidor |
| project/mcp.json.example | Inaplicável | MCP Claude não é config Codex; conexão existente |
| environment-manifest.json.example | Inaplicável ao projeto | Apenas inventário de máquina; manifesto real ausente registrado |
| settings.json.example | Inaplicável | Não configurar hooks Claude no Codex |
| hooks/hook-io.mjs.example | Inaplicável | Nenhum hook novo; evitar interceptadores |
| rules/parallel-subagent-driven-development.md | Reutilizado no fluxo do plano aprovado | Não copiar o protocolo longo; delegar por tarefa sem subdelegação |

## Prompts e guias do catálogo

| Prompts 01–12 | Decisão nesta fundação |
|---|---|
| 01 saneamento / 02 warning burndown | Inaplicáveis: sem legado ou warnings iniciais; sem limpeza destrutiva |
| 03 revisão multiagente | Revisor distinto após cada tarefa e revisão ampla ao final | Controlador fecha os achados; sem cascata de revisões ou subdelegação |
| 04 brainstorming→plano | Reutilizado: spec e plano já aprovados, preservados |
| 05 ondas paralelas | Controle do coordenador; não executar recursivamente |
| 06 memory bootstrap | Equivalente por AGENTS e docs versionados, sem vault |
| 07 ESLint completo / 08 quality gates | Adaptados ao perfil leve e self-check |
| 09 refatoração por tamanho | Inaplicável: sem arquivo de app excedente |
| 10 ambiente global | Inaplicável: inventariar/reutilizar, sem instalação global |
| 11 bootstrap Next | Aplicado ao scaffold externo integrado |
| 12 setup existente | Aplicado ao harness e matriz, preservando produto/autorização |

Guias 00 visão geral, 01 instalação, 02 onboarding, 04 bootstrap e 06 defaults serviram de referência. Guia 03 ambiente é apenas inventário, sem reconfigurar máquina. Guia 05 validação valida o toolkit distribuidor, não deve ser instalado como serviço no app. README/LICENSE do toolkit foram consultados. Nenhum template adicional foi omitido da árvore local inventariada.

## Evidências da primeira fatia — antes da revisão imersiva

Na retomada de 2026-10-15, o PowerShell com perfil mostrou erro do fnm ao selecionar Node; sem perfil, as ferramentas locais funcionaram: Node `v24.21.0`, pnpm `12.11.2` e Chrome `155.0.8059.40`. `pnpm install --frozen-lockfile --force` terminou com sucesso, sem apagar `node_modules` manualmente. Os gates abaixo foram executados após a reinstalação.

### Validação final — após as correções de Worker e câmera

| Check | Resultado |
|---|---|
| `pnpm install --frozen-lockfile --force` | Sucesso; reinstalação validada contra o lockfile existente. |
| `pnpm check` | Sucesso: lint, typecheck, regras locais, 15 arquivos Vitest/156 testes e build estático. ESLint reportou 0 erros e 1 warning preexistente em `.superpowers/sdd/2026-10-15-astro-web-foundation/task-4-profile.cjs`. |
| `pnpm exec playwright test` | 3/3 passaram no Chrome `155.0.8059.40`: inicialização/GLB, edição/fase/importação-exportação e fallback sem WebGL. O erro de contexto WebGL no log é esperado no teste do fallback. |
| `node scripts/generate-sphere-glb.mjs` | Sucesso: `public/models/astro-sphere.glb`, 94.220 bytes, 2.145 vértices e 12.288 índices. |
| Graphify | Sucesso com `GRAPHIFY_NO_AUTO_REFRESH=1` e `--code-only --no-cluster`: 287 nós/599 arestas; 16 arquivos de código atualizados e 38 inalterados. Dois arquivos de teste não produziram símbolos; `globals.css` e o GLB foram ignorados pelo extrator. Sem LLM. |
| Revisão complementar | Sem achados P1/P2 após correções de rollback, foco/pan e plano de corte; revisores apontaram cobertura integrada baixa, agora coberta pelo teste Worker+client. |
| `pnpm audit --prod --json` / `pnpm audit --json` / `pnpm peers check` | Não reexecutados nesta retomada; resultados históricos abaixo. |
| `git diff --check` | Passou sem whitespace errors. `git status --short` conferido; alterações e arquivos não rastreados foram preservados, sem stage/commit. |

### Resultados históricos — antes das últimas correções de Worker e câmera

| Check | Resultado histórico |
|---|---|
| `pnpm check` | Sucesso; 149 testes Vitest. Não cobria as correções posteriores. |
| Vitest focado | 38/38 antes da revisão final. |
| E2E | 3/3 antes das revisões finais de revisão/câmera. |
| Build e typecheck | Sucesso antes das correções finais. |

### Evidências anteriores do scaffold

Os checks abaixo validaram o scaffold antes das features atuais; não são evidência de funcionamento do simulador, GLB ou editor.

| Check | Resultado histórico |
|---|---|
| `pnpm install` e `pnpm install --frozen-lockfile` | Sucesso; lockfile gerado/conferido e ressalva de peers registrada |
| `pnpm lint`, `pnpm typecheck`, `pnpm lint:rules` | Sucesso no scaffold |
| `pnpm test` | 1 arquivo, 2 testes aprovados no scaffold |
| `pnpm build` e servidor local | Build aprovado; rota inicial serviu HTTP 200 |
| Chrome isolado via Playwright CLI/config existente | Título, heading e mensagem da página inicial; console sem erros/avisos |
| `pnpm audit --prod --json` | 0 vulnerabilidades reportadas naquela resolução |
| `pnpm audit --json` | 1 high em dev; detalhes abaixo |
| `pnpm peers check` | Três plugins declaram peers até ESLint 9; ressalva abaixo |
| Graphify e `skills list` | Resultados da fundação; cobertura/discovery limitadas como descrito acima |

O primeiro smoke encontrou favicon.ico 404; um ícone SVG local original via convenção App Router corrigiu a causa. Build e novo navegador confirmaram console limpo. O ambiente Chrome injeta tráfego do antivírus da máquina; não foi introduzido pelo código e suas URLs não são persistidas como evidência. O scaffold e logs temporários são locais; os servidores e sessões de navegador criados pela tarefa foram encerrados ao fim.

Graphify da fundação: `GRAPHIFY_NO_AUTO_REFRESH=1 graphify extract . --code-only --no-cluster --max-workers 2`, seguido de `graphify query 'RootLayout' --budget 500`. A cobertura inicial era parcial; a extração final desta retomada está descrita acima. O grafo é ignorado no Git. Nenhum dado foi enviado a serviço de grafo/LLM.

## Riscos e condições de retomada

1. ESLint 10.12.0 foi fixado pelo plano; `eslint-config-next@16.4.1` aceita >=9, mas `eslint-plugin-import@2.32.0`, `eslint-plugin-jsx-a11y@6.10.2` e `eslint-plugin-react@7.37.5` declaram peers até 9. Os checks reais passaram. Reavaliar quando esses plugins suportarem 10 ou quando houver decisão de alterar a versão exigida. Não foi usado override para mascarar o aviso.
2. [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): braces 3.0.3 vulnerável a exaustão de pilha por padrões profundamente aninhados, através de eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch. Restrito à árvore dev nesta resolução; produção auditada sem achados. Advisory e registry não oferecem versão corrigida publicada. Evitar padrões glob não confiáveis no tooling; atualizar após correção upstream e repetir auditoria/checks, sem downgrade automático.
3. Skills novas estão no disco e são listadas pela CLI; redescoberta em nova sessão Codex/Claude não foi executada. Reabrir sessão e verificar antes do uso; não reinstalar globais automaticamente.
4. Licenças incompletas no upstream de algumas skills: proveniência registrada; reconsiderar antes de redistribuição externa. Não implica licença coletiva MIT.
5. Os E2E cobrem fluxos definidos no Chrome, mas não substituem inspeção visual em dispositivos/GPU diferentes, validação científica das texturas ou auditoria completa de acessibilidade.

Primeira fatia: gates, E2E, Graphify, `git diff --check` e status foram executados; a revisão imersiva posterior está registrada no início deste documento. Não há certificação científica ou benchmark de GPU física. Ao repetir o setup, inventariar estado e fontes, preservar personalizações, conferir ajuda atual e atualizar somente peças pertinentes. MCPs/hooks não devem ser duplicados.

## Onda dinâmica — reports focados recebidos em 16/10/2026

Os resultados abaixo foram enviados pelos responsáveis; não foram reexecutados por Quill nesta sessão.

| Escopo | Resultado reportado | Limite atual |
|---|---|---|
| Kepler / Core | 90/90 Vitest em cinco arquivos e typecheck passaram. | Não é declaração de `pnpm check` global. |
| Umbra / render | 9/9 verificações focadas; ESLint 0. | Prisma reporta smoke pós-release concluído; observações estão na linha visual. |
| Umbra / `camera-focus.ts` | 5/5 focados; ESLint 0; resize desktop → 480 → 320 → 480 px preservou orientação, pan e zoom relativos. | Resultado focado reportado, não benchmark amplo. |
| Lyra / UI | 9/9 focados e lint; Vega reporta nenhum P1/P2. Patch CSS móvel final reportado; `git diff --check` passou. | Revisão final sem P1/P2 reportada após delta CSS/câmera. |
| Comet / `pnpm check` | Passou: 231/231 unitários, lint sem erros, typecheck, regras e build; 1 warning preexistente. | Resultado reportado por Comet; não reexecutado por Quill. |
| Comet / Playwright Chrome | 24 passed, 0 failed; duração 145223 ms (2m25.223s), antes do micro CSS final. | Resultado reportado; sem repetição após a mudança de scrollbar. |
| Quill / smoke Chrome CLI | 320×740 e 480×844; `.planet-navigation` mantém overflow horizontal, scrollbar escondida e rolagem/foco funcionais. Capturas de explosão pausada, fusão e close-up lunar abertas; mapa `moon-lroc-color-4k.jpg` respondeu HTTP 200. | Smoke focado, não suíte E2E. BH 10Rs não foi verificado visualmente. |
| Aster / trilha orbital | Reporta 12/12 focados em três arquivos, ESLint em sete arquivos e typecheck aprovados. Contrato usa snapshot autoritativo atômico, limite 256 amostras/corpo e espaçamento mínimo de 86.400 s simulados. | Relato do implementador, não reexecutado. Revisão estática Quill e revisão final Prisma sem P1/P2 reportados; desalinhamento geométrico não reproduzido. |
| Prisma / `pnpm check` atual | PASS reportado: 240 testes em 29 arquivos; ESLint 0 erros e 1 warning legado; typecheck, regras e build Next.js 16.4.1 passaram. | Relato do Prisma, não reexecutado por Quill. |
| Prisma / runner E2E inicial | 0/0 testes; processo encerrou com código 1. | Inicialização bloqueada pelo lock do Next no mesmo checkout, confirmado por Prisma; Quill pausou apenas o listener 3000 autorizado. |
| Prisma / Playwright Chrome final | 24 passed, 0 failed; 181079 ms, executado em 3101 após liberar 3000. | Resultado reportado por Prisma depois das mudanças atuais; não reexecutado por Quill. |
| Servidor local restaurado | HTTP 200 em `127.0.0.1:3000`; listener PID 4000 `node.exe`, Next 16.4.1 `start-server.js`; sessão foreground Quill 20566. | Servidor está em foreground; encerrar sessão encerra o host. |

Smoke visual focado executado após micro CSS. Em 320×740 e 480×844, `.planet-navigation` ficou visível com `overflow-x:auto`, `scrollbar-width:none` e pseudo-elemento WebKit oculto; largura total do conteúdo 583 px, viewport 304/464 px. `scrollLeft` mudou sob scroll programático; Tab percorreu os dez botões até Netuno e rolou o container. Capturas abertas: explosão experimental pausada, fusão com flash/anel e close-up lunar; textura `moon-lroc-color-4k.jpg` respondeu HTTP 200 e `data-glb-loaded=true`. Isso não confirma outros dispositivos ou Firefox. BH `10Rs` não foi verificado visualmente.

Capturas: `.playwright-cli/qa-explosion-1440x900.png`, `.playwright-cli/qa-collision-flash-1440x900.png` e `.playwright-cli/qa-moon-closeup-1440x900.png`.

Comet reportou `pnpm check` aprovado e E2E 24/24, ambos anteriores ao micro CSS. HTTP 200 foi confirmado em `127.0.0.1:3000`, PID 28256. O dev server está em primeiro plano no terminal Quill e encerra se a sessão for interrompida. Ver [quality.md](quality.md) para detalhes.

O primeiro `pnpm check` foi interrompido por TS2739 em `celestial-scene.ts:75`, pois faltavam campos de câmera nos chamadores. Umbra corrigiu; execução completa posterior passou. Trace JS intermediário de lint ficou apenas nos artefatos. Artefatos foram movidos para `TempAstro-QA-data-2026-10-16-1e3c1deaeb4b42f69c7f8030321bbf85`; nenhuma regra/configuração ESLint foi alterada.
