# Astro — laboratório de impactos e acabamento visual

**Data:** 17/10/2026
**Status:** catálogo SHARD local e consulta lab-only implementados e validados. Outcomes SHARD não entram no Worker; colisões ao vivo continuam na fusão idealizada.

## Objetivo

Construir um laboratório reproduzível de outcomes SPH e, só após fechar o contrato de snapshot, ligar colisões realistas ao N-body. Melhorar iluminação sem trocar mapas licenciados nem inventar textura observacional.

## Estado que este desenho estende

- O Worker calcula gravidade Newtoniana N-body e resolve contato atualmente por fusão perfeitamente inelástica. Conserva massa, momento linear e volume; dissipa energia cinética.
- `EXPLODE_BODY` é uma ação manual experimental: seis fragmentos e energia externa configurável. Ela não é resultado de uma colisão natural.
- A colisão detectada fornece corpos antes/depois do subpasso, mas não tem ainda contrato de ângulo, regime ou massa de ejecta.
- Eventos já cruzam Worker e cena, com efeitos gráficos transitórios; não persistem no arquivo salvo.
- Mapas planetários existentes têm atribuição em `public/textures/ATTRIBUTION.md`. A anã branca já é lisa.

## Contrato científico

1. Modelo de colisão nomeado: `SHARD-880-grid`, catálogo SPH de impactos não rotativos. O domínio é conjunto, não caixa de bounds: `v_imp/v_esc ∈ {1,1.5,2,3,5}`, ângulo `{0°,20°,40°,60°}`, `M_total ∈ {2 Ceres,2 Lua,2 Marte,2 Terra}`, `γ ∈ {0.1,0.5,1}` e água em alvo/projétil `{10%,20%}`. `SPH.table` usa `γ=0.1`; o “0” aparente na tabela do artigo é erro tipográfico. Interpolação só ocorre dentro de célula multidimensional com todos os cantos utilizáveis; sem extrapolação nem atravessar cantos ausentes/crashed. Fora disso, fallback de fusão idealizada com motivo explícito.
2. Primeira fatia fixa composição interna em 10% de água por massa para ambos os corpos. É hipótese declarada; nunca derivar de `waterFraction`, temperatura ou textura. Água visual atual segue independente. O domínio representa corpos rochosos sem rotação; resistência, diferenciação, porosidade, spin e equação de estado não são modelados. Astros não rochosos/compactos usam fallback.
3. SHARD interpola outcomes SPH cerca de 10 horas após o impacto. Estados de remanescentes e debris são relativos ao centro de massa e pertencem a esse snapshot tardio, não ao instante de contato. Não deslocar esses estados como se fossem imediatamente pós-contato sem validar transformação temporal; uso em colisão ao vivo fica bloqueado até fechar contrato de frame/tempo.
4. SHARD fornece massa, água, posições e velocidades de remanescentes/debris; interpolação/clustering não prova conservação de momento nem energia no contrato Astro. Não impor `E_fragments ≤ E_impact` sem equivalência demonstrada. Validar massa/água e frame; relatar tolerâncias observadas como propriedades do dataset, sem corrigir velocidades silenciosamente.
5. Redução para o limite de 64 corpos não pode descartar massa. Clustering determinístico deve preservar massa/água e centro de massa ponderados; efeitos em reacréscimo/evolução são incerteza do modelo e ficam visíveis. Envelope ou conjunto de corpos inválido causa fallback atômico.
6. Resultado determinístico para a mesma query e versão do dataset. IDs não colidem com IDs existentes. Mudança futura no Worker segue rollback atômico.

## Fragmentos, orçamento e fallback

- Preservar teto existente de 64 corpos e orçamento de passos. A quantidade de debris dos arquivos SHARD pode exceder slots disponíveis; nenhuma redução é permitida até validar clustering com quantidades físicas preservadas.
- Não reposicionar nem ajustar velocidades do snapshot tardio para forçar um balanço idealizado. Registrar a origem da amostra e limites numéricos.
- Se laboratório não puder exibir todos os debris, mostrar amostra visual identificada e inventário completo de massa/água. Não criar superfragmento sem algoritmo validado.
- Se o estado extrapolar limites de massa, velocidade, posição, número de corpos ou orçamento, rejeitar o intervalo atomicamente e explicar como recuperar. Não cortar velocidade ou massa silenciosamente.
- Explosão manual continua separada e rotulada como intervenção com energia externa. Não reutilizar essa ação como colisão natural.

## Evento e apresentação

- Resultado de consulta SHARD informa `modelId`, query, domínio, snapshot de origem (~10 h), remanescentes e hipótese 10%/10%. Arquivo de debris original só fica disponível em nó exato da grade; interpolação de listas sem identidade entre linhas é proibida. Não rotular estados tardios como estados de contato. Colisão ao vivo permanece fusão idealizada até mapeamento de tempo/frame validado; laboratório inspeciona outcome separadamente.
- Evento sem `impactResult` é o contrato legado. Se o campo existir, validação exige `version: 1`, campos completos, valores finitos/não negativos, IDs únicos e estados de nascimento coerentes. Versão desconhecida rejeita o snapshot inteiro. Dados de evento não entram no save.
- Não ligar debris SHARD ao VFX de colisão em tempo real. Outcomes são snapshots tardios. Se exibidos em laboratório, separar corpos de dados de poeira decorativa e anunciar modelo, parâmetros, composição fixa, tempo de snapshot e limites.
- Manter anúncio acessível para colisões ao vivo idealizadas; VFX não comunica ejecta calculada antes da integração física.
- Efeito em fases: contato breve, flash/onda visual, ejecta visual alinhada aos fragmentos reais e fade. Brilho, poeira e onda são apresentação; não representam temperatura, radiação ou partículas adicionais com massa.
- Respeitar `prefers-reduced-motion`, duração e quantidade limitadas, descarte de geometria/material e console limpo.

## Experiência de brincadeira

- Adicionar cenários de laboratório reproduzíveis dentro dos nós SHARD: consulta de remanescente/debris. Cada cenário declara domínio, composição 10%/10%, ausência de rotação e snapshot tardio. Fora da grade, mostrar fallback explícito; não extrapolar.
- Permitir editar condição inicial, iniciar/pausar e restaurar o cenário aceito explicitamente. Restaurar é reinício do estado inicial, não reversão física; limpa tempo, eventos e trilhas de gerações anteriores.
- Recuperação de limite numérico oferece preset de velocidade menor como sugestão, sem alterar física ou velocidade aceita silenciosamente.
- Fluxo normal do Sistema Solar e saves atuais continuam legados/compatíveis; nenhuma mudança ao codec ou ao preset Solar é necessária.

## Aparência e ativos

- Primeiro preservar mapas atuais e licenças. Ajustar equilíbrio de material/iluminação existente: reduzir hotspot duro na Terra/Sol e manter dia/noite, nuvens e limbo legíveis.
- Manter anã branca como emissor liso, sem textura inventada. Não adicionar ruído senoidal ao fragment shader.
- Criar asset novo somente se screenshot pareado identificar lacuna concreta e licença/proveniência puder ser registrada. Não substituir `sun.jpg`, mapas terrestres/lunares ou mapas de outros planetas por textura sintética.
- Playwright CLI em Chrome, câmera, viewport e exposição iguais: Terra lado dia/noite, Sol e anã branca; capturar estado antes/depois, validar shader e zero erros/avisos. Comparação não alegará fotometria.

## Arquitetura e compatibilidade

Prováveis áreas: `src/simulation/collisions.ts`, `simulation-time.ts`, `simulation.worker.ts`, `types.ts`, `simulation-client.ts`, `world-mutations.ts` e seus testes; fluxo de evento e VFX em `src/features/simulation/scene-events.ts`, `celestial-scene.ts`, `simulation-events.ts`/`page.tsx`; novos controles/situações no `SimulationToolbar.tsx` ou superfície apropriada; aparência em `celestial-bodies.ts` e `body-appearance.ts` apenas se smoke provar necessidade.

Manter física fora de Three.js/UI. Eventos novos são opcionais no protocolo e transitórios. Não alterar JSON salvo. Validar snapshots no limite do cliente. Corpos de fragmento seguem o contrato atual de `CelestialBody` e limites existentes; nenhum campo científico novo é persistido nesta fase.

## Sequência de implementação proposta

1. **Dados e consulta SHARD:** medir pacote compacto; se inviável, não incluir dataset nem anunciar feature pronta. Implementar consulta 6D, domínio estrito e fallback.
2. **Laboratório isolado:** preset/query reproduzível, resultado com frame/unidades/tempo, mostrar debris em snapshot sem fingir evolução até ali.
3. **Validar contratos físicos:** verificar formato de debris e conversão de unidades; comparar massa/água, frame, CoM, velocidade e orçamento. Manter live collision idealizada até resolver salto de 10 h e influências externas.
4. **VFX e superfície:** manter efeitos visuais de colisão legados e distinguir deles os snapshots SHARD; só ajustar materiais com screenshots pareados.
5. **Validação:** suites Core/UI e Playwright CLI; console limpo. Medir FPS/VRAM em Iris Xe antes de aceitar custos de render; não declarar benchmark sem medição.

## Testes de aceitação

- Casos de referência em nós SHARD, interpolação interna e fora do domínio; comparar com dados-fonte selecionados. Testar rejeição de células incompletas/crashed e composição fora do suporte. Interpolação não reconstrói hidrodinâmica.
- Mesma entrada reproduz saída e IDs; entradas limítrofes são contínuas ou explicitamente classificadas; domínio inválido usa fallback indicado.
- Massa e água fecham conforme catálogo. Momento, energia e raio são medidos contra snapshot SPH e não alegados conservados sem contrato provado; redução de debris preserva massa/água e informa efeito no momento.
- Cap de corpos e limites rejeitam sem estado parcial. Uma visualização limitada deve indicar claramente que é amostra; corpo físico agregado exige validação de massa/água, frame e momento.
- Cliente aceita evento legado sem `impactResult`, valida contrato V1 inteiro e rejeita NaN, IDs duplicados, valores fora de faixa e versão desconhecida. Casos com mais de um evento geram anúncio agregado que menciona todos; reduced motion mantém anúncio textual.
- Trilha e câmera não misturam geração após restore/colisão; VFX resolve IDs e posições dos fragmentos aceitos; partículas decorativas não viram corpos nem recebem massa.
- Playwright: abrir cenário, pausar/editar/rodar impacto, ler resultado, observar fragmentos em movimento, restaurar cenário e verificar relógio/trilhas limpos; console sem erro.
- Playwright: disparar dois ou mais eventos no mesmo snapshot e confirmar resumo completo; em reduced motion, confirmar texto e ausência de animação intensa.
- Screenshots pareados verificam hotspot e legibilidade sem mudar mapas/licenças; anã branca lisa; movimento reduzido não reproduz VFX intenso.

## Fora do escopo

Hidrodinâmica SPH, equação de estado, diferenciação núcleo/manto, atmosfera, spin, fragmentos granulares, termalização/radiação, supernova, estrelas/compactos, relatividade geral, som e alterações do formato de save.

## Fontes primárias

- Malidibayeva et al. (2026), [SHARD: SPH outcomes of protoplanetary impacts](https://arxiv.org/abs/2606.17348), publicado em *The Astronomical Journal* 172 (2026), DOI `10.3847/1538-3881/ae8ae7`; [catálogo e `SPH.table`](https://github.com/malidib/shard), licença CC0 1.0 declarada na raiz. Preservar citação/proveniência. Catálogo contém 880 outcomes, corpos não rotativos e snapshots ~10 h. Resolução/clustering limitam debris pequenos e água do segundo remanescente. É interpolação SPH, não SPH ao vivo nem previsão exata.
- Crespi, Ali-Dib & Dobbs-Dixon (2024), [Protoplanet collisions: new scaling laws from SPH simulations](https://doi.org/10.1051/0004-6361/202346519), *A&A* 685, A86. Não combinar lei do maior remanescente com estatística populacional de Crespi et al. (2021) como se descrevesse ejecta deste impacto individual.
- Leinhardt & Stewart (2012), [Collisions Between Gravity-Dominated Bodies: 1. Outcome Regimes and Scaling Laws](https://doi.org/10.1088/0004-637X/745/1/79), *ApJ* 745, 79; Stewart & Leinhardt (2012), [Collisions Between Gravity-Dominated Bodies: 2. The Diversity of Impact Outcomes During the End Stage of Planet Formation](https://doi.org/10.1088/0004-637X/751/1/32), *ApJ* 751, 32. Fundamentam regimes distintos e limites dos modelos analíticos.

Artigos e catálogo são modelos, não observações nem garantia para toda composição. Documentar domínio conjunto, interpolação, frame, snapshot tardio, tolerâncias e fallback antes de habilitar colisões comuns.
