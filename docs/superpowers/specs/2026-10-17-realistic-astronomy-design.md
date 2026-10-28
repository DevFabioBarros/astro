# Astro — evolução estelar, trajetórias e renderização realistas

**Data:** 17/10/2026  
**Status:** proposta para aprovação; pesquisa e correção visual do horizonte concluídas.

## Objetivo

Melhorar a coerência astronômica sem apresentar estimativas visuais como física simulada. Manter a gravidade N-body Newtoniana separada de modelos estelares e de renderização. Fazer alterações em ondas pequenas, com validação própria.

## Evidências atuais

- `CelestialBody.massKg` é a massa gravitante do Worker. Editá-la não recalcula raio ou temperatura.
- O modo estelar atual usa uma trilha MIST local de 1 M☉ até o início da formação da anã branca. Não cobre outras massas nem o resfriamento de anãs brancas.
- Trilhas históricas já usam snapshots aceitos, alvo angular de 5°, intervalo máximo de um dia simulado e limite de 256 pontos. Publicação do Worker até 20 Hz pode impedir esse alvo em alta velocidade; não foi reproduzido defeito geométrico independente.
- A cena usava dois anéis genéricos sempre ativos para buracos negros. Esta sessão removeu ambos. Agora mostra somente o horizonte preto de Schwarzschild; não há lente nem disco de acreção.
- Anãs brancas já usam uma esfera lisa com cor e brilho aproximados pela temperatura e escurecimento de limbo. Uma textura superficial irregular não tem suporte observacional adequado.

## Contratos científicos

1. Não inferir idade, estrutura ou destino de uma estrela ao editar sua massa gravitante atual. `M_current` controla N-body; `M_initial` identifica a massa inicial da trilha.
2. Massa, raio e temperatura de estrelas normais dependem de fase, idade e composição. Não aplicar fórmula universal `R(M)` a estrelas normais, gigantes e remanescentes.
3. Uma anã branca tende a diminuir de raio ao ganhar massa; não usar a relação da sequência principal. Estrelas de nêutrons exigem equação de estado e relatividade geral. Buracos negros mantêm `Rs = 2GM/c²`.
4. O destino de uma estrela depende da evolução do núcleo, composição, perda de massa, rotação e histórico binário. Não classificar como anã branca, estrela de nêutrons ou buraco negro por um corte universal de massa atual.
5. O horizonte do buraco negro não é uma superfície emissora. Disco de acreção exige matéria; lente exige cálculo de desvio relativístico da luz. Sem esses estados/modelos, a cena não deve inventá-los.
6. Anãs brancas devem permanecer lisas, com aparência dependente de temperatura e geometria de iluminação. Não criar manchas, continentes ou granulação sem um modelo físico correspondente.

## Ondas propostas

### A. Medir resolução da trilha antes de alterar protocolo

- Criar evidência quantitativa para os limites de 20 Hz usando o preset e um caso Lua–Terra em velocidade máxima: intervalo temporal, maior passo angular e erro geométrico da polilinha contra solução de referência.
- Manter snapshots aceitos, geração/revisão e limite atual enquanto a medição não mostrar que falham no critério acordado.
- Se o erro superar o limite visual acordado, avaliar pontos reais dos subpassos aceitos do integrador, enviados em lote com teto de memória/tráfego. Não suavizar por spline nem interpolar posições que não foram integradas.
- Não mudar o formato JSON salvo. Testar fidelidade, limite, reset, rejeição do Worker e desempenho antes de aumentar dados do protocolo.

### B. Fechar domínio e proveniência antes de ampliar evolução estelar

- Manter a trilha solar atual sem extrapolação.
- Antes de adicionar dados, confirmar licença, atribuição e permissão de redistribuição do dataset. A licença específica do MIST embutido hoje não foi identificada; não copiar novos grids enquanto isso não estiver resolvido.
- Definir uma matriz explícita de massas iniciais, composição, rotação, faixas de idade/fase e EEPs suportados. Demonstrar que interpolação não atravessa descontinuidades nem extrapola.
- Definir e testar o ledger de `M_current`, massa estelar da trilha, vento/ejeção e acreção, incluindo remoção de corpos engolfados, momento, colisões, edição manual, importação e reset.
- Manter edição manual como experimento separado do track. Uma alteração manual de massa não troca `M_initial` nem escolhe novo destino evolutivo.
- Versionar o contrato salvo somente após fechar migração estrita e rejeição atômica, preservando leitura v1/v2/v3.
- Limitar primeiro grid a fases estelares efetivamente cobertas. Tratar formação de anã branca como endpoint. Não prometer resfriamento WD, destino NS/BH ou supernova sem modelos/dados próprios.

### C. Aparência estelar após definir alvo visual mensurável

- Slice BH desta sessão está concluído: horizonte preto, sem anéis sem matéria e sem alegações de lente ou emissão.
- Manter WD lisa; mudança futura deve melhorar enquadramento, faixa de cor/temperatura ou iluminação com critérios testáveis, sem inventar mapa superficial.
- Uma textura procedural de fotosfera só deve entrar se for determinística, leve e descrita como efeito visual não calibrado. Manter o mapa solar atribuído existente.
- Lensing relativístico e disco/acréscimo ficam fora deste slice; exigem modelos e estado de matéria explícitos.

## Validação e limites

Cada onda precisa de teste focado da física ou composição da cena, `git diff --check` e revisão read-only independente. Gate global só deve ser reportado se executado. Revisão visual precisa indicar GPU, resolução e cenário; GPU integrada, emulação e screenshot estático não certificam desempenho ou física.

Nesta sessão, `src/features/simulation/celestial-bodies.test.ts` passou 7/7 após teste vermelho observado. `git diff --check` passou segundo os agentes. Lint, typecheck, build, `pnpm check` e inspeção visual não foram executados. Node `v24.21.0` foi chamado diretamente; fnm avisou que a versão de projeto não está selecionada/instalada.

## Fontes

- MIST, [overview e limites de trilhas](https://mist.science/) e [interpolador](https://mist.science/interp_tracks.html): grade disponível cobre 0,1–300 M☉, com evolução até endpoints diferentes conforme massa. Isso não implica domínio temporal comum nem licença de redistribuição confirmada.
- NASA, [evolução estelar](https://science.nasa.gov/mission/webb/star-lifecycle/) e [anãs brancas](https://imagine.gsfc.nasa.gov/science/objects/dwarfs1.html): fases e remanescentes dependem da evolução; valores de massa são aproximações didáticas.
- Cummings et al., [relação massa inicial–final de anãs brancas](https://arxiv.org/abs/1505.06737): relação observacional com dispersão e dependência de massa.
- Nauenberg, [relação massa–raio para anãs brancas](https://academic.oup.com/mnras/article/160/4/435/2603206): relação degenerada difere da sequência principal.
- NASA SVS, [visualização de buraco negro, disco e lente gravitacional](https://svs.gsfc.nasa.gov/14619/): mostra que a aparência luminosa depende de disco e desvio de luz; não é textura do horizonte.
