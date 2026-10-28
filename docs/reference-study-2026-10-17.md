# Estudo de referências — 17/10/2026

Pesquisa interativa curta e fontes complementares para controles físicos da sandbox. Nenhuma marca, arte, código ou composição de tela foi copiada.

| Fonte | Observado ao vivo ou documentado | Aplicação no Astro e prioridade futura |
|---|---|---|
| [Yandex Games — Sandbox Universe](https://yandex.com/games/app/sandbox-universe-510828) | Jogado no Chrome via iframe. Catálogo Solar, editor Earth, órbita, clone, Explode e relógio foram observados. Massa mostrou `1.0 M⊕`; um passo de teclado passou a `1.1 M⊕`, raio `1.03 R⊕`, densidade exibida `5509 kg/m³`. Aba Orbit mostrou período, excentricidade, Auto Orbit e Stop; Edit mostrou massa, raio, densidade e rotação. Pausa via Space foi confirmada. Um aviso de baixa precisão orbital apareceu em tempo acelerado. Explode foi acionado no clone enquanto a cena evoluía e a contagem de corpos variou; não é possível atribuir a variação somente à ação. | Astro exibe massa, raio/diâmetro, densidade, gravidade e escape juntos e calcula prévia de fragmentação com helper físico compartilhado. Próximo: tornar colisões controláveis em cenários pequenos sem sugerir hidrodinâmica. |
| [Universe Sandbox FAQ](https://universesandbox.com/faq/) e [vídeos oficiais](https://universesandbox.com/videos/) | FAQ documenta gravidade newtoniana N-body, passos temporais adaptativos e redução de precisão/velocidade conforme tamanho do passo. A página de vídeos mistura trailer oficial com gravações de criadores; não foram tratados como tutoriais oficiais. | Inspira comunicar limite de precisão e distinguir evolução numérica de efeito visual. Depois: controles didáticos de passo/precisão com indicação clara do custo. |
| [SpaceEngine manual](https://spaceengine.org/manual/user-manual-0980/) e [editor de planetas](https://spaceengine.org/manual/making-addons/creating-a-planet/) | Documentação descreve massa, diâmetro, gravidade, temperatura e distância no HUD; editor expõe parâmetros físicos/orbitais. Documentado, não jogado nesta sessão. | Astro já coloca medidas físicas ao lado da órbita. Futuro: agrupar propriedades observadas e editáveis sem misturar valores derivados e campos ajustáveis. |
| [PhET Gravity Force Lab](https://phet.colorado.edu/sims/html/gravity-force-lab/2.2.19/gravity-force-lab_en.html) | Referência complementar documentada: explora relação de força com massas e distância; não é integração de órbitas N-body. Não foi jogado nesta sessão. | Prioridade futura: comparação visual de força/distância que complemente o movimento orbital, sem substituir o modelo N-body. |
| [REBOUND — integradores](https://rebound.hanno-rein.de/integrators/) e [API](https://rebound.hanno-rein.de/api/) | Documentação técnica de integradores, gravidade, colisões e passos numéricos; não é uma experiência visual de sandbox. | Referência técnica para precisão e validação de cenários N-body. Não implica trocar o integrador atual. |

## Limites da sessão Yandex

O jogo abriu dentro de iframe de outro domínio; o DOM do jogo era parcialmente inspecionável, mas canvas, estado e física não eram auditáveis. Rejeitei opções de parceiros/consentimento, não fiz login nem compra. A cena estava em desafio e mudava durante edição; clone e explosão foram observados, mas sem colisão controlada nem medida confiável do resultado da explosão. Não inferir conservação, vínculo massa-raio ou causalidade dos números exibidos. Capturas locais: `.playwright-cli/yandex-game-main.png`, `yandex-objects-panel.png`, `yandex-earth-edit.png`, `yandex-earth-orbit.png`, `yandex-clone-before-explosion.png` e `yandex-clone-orbit.png`.

## O que entrou no Astro

- Botões independentes Órbitas estimadas (padrão ativo) e Rastros percorridos (padrão inativo), com `aria-pressed`; trilhas leem snapshots aceitos.
- Explosão recebe energia específica opcional; UI reaproveita prévia do Core, mostra velocidade inicial e energias em unidades legíveis e impede ação quando o rascunho não pode ser representado.
- Prioridades: manter explícitos limites de modelo/precisão; desenhar colisões pequenas e repetíveis; ensinar como massa, raio e distância alteram força e contato.

## Referências físicas e prioridades futuras

Universe Sandbox Update 31.3 diz que temperatura e brilho de fragmentos de colisão derivam da energia do impacto ([nota oficial](https://universesandbox.com/blog/2022/09/planetary-defense-dart-update-31-3/)); Update 32.3 relata ejeção de fragmentos conforme ângulo de impacto ([nota oficial](https://universesandbox.com/blog/2023/06/grand-collision-unification-update-32-3/)). São descrições do produto, não validação científica independente.

O [DevLog de materiais/SPH](https://universesandbox.com/blog/2019/12/sph-devlog-1/) descreve capacidade térmica, mudanças de fase e partículas com massa, temperatura, velocidade e posição. O [roadmap 2026](https://universesandbox.com/blog/2026/03/universe-sandbox-roadmap-2026/) lista rotação de fragmentos e colisões de corpos com forma real como trabalho planejado; roadmap não é funcionalidade entregue nem evidência de precisão.

- **Calor, capacidade e material:** futuro balanço deve repartir energia entre movimento, calor, mudança de fase e ejecta, com propriedades materiais declaradas. Verificar fechamento do ledger e ΔT compatível com energia, massa e capacidade térmica; calor não é todo o K do impacto ([paper sobre aquecimento por impactos](https://pmc.ncbi.nlm.nih.gov/articles/PMC7613298/)).
- **Spin e momento angular:** registrar spin vetorial e contabilizar L orbital + L de rotação em colisões oblíquas. Verificar balanço vetorial antes/depois; fragmentos sem spin são limitação apontada no roadmap 2026. Referência: [Canup 2004, formação da Lua por impacto gigante](https://doi.org/10.1126/science.1104133).
- **Regimes de colisão calibrados:** classificar acreção, hit-and-run e disrupção por razão de massas, ângulo e energia específica; testar limiares publicados e conservação de massa/momento. Base: [Leinhardt & Stewart 2012, regimes e leis de escala](https://doi.org/10.1088/0004-637X/745/1/79).
- **Marés:** modelar torque e dissipação com parâmetros explícitos; verificar conservação de momento angular orbital + spin, dissipação de energia e tendência de sincronização no regime aplicável. Base: [Hut 1981, atraso temporal constante](https://ui.adsabs.harvard.edu/abs/1981A%26A....99..126H/abstract).

Esta rodada implementa somente K de ejeção experimental parametrizada (`K = Mq`, `v = √(2q)`). Não implementa calor/material, spin, regimes calibrados ou marés; energia de ligação homogênea é apenas referência, não critério de fragmentação.
