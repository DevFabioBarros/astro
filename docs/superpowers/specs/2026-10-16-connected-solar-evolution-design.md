# Evolução solar conectada — especificação de design

**Data:** 16/10/2026  
**Estado:** execução autorizada. A1 Core e B2 renderização reportados verdes; C2 UI em integração. Prumo fará validação independente no gate final; QA final ainda não foi declarado verde.  
**Escopo desta etapa:** registrar requisitos, limites e decisões confirmadas. Questões científicas abertas continuam sem decisão.

## Intenção

Permitir que a pessoa explore qualitativamente como o Sol muda com a idade, sem confundir evolução estelar com o relógio que integra as órbitas. O recurso deve apresentar propriedades estelares conectadas e deixar claro onde o modelo deixa de sustentar conclusões físicas.

## Requisitos da pessoa usuária

- Ver idade solar em Gyr e estágio evolutivo em linguagem legível.
- Avançar a evolução em passos controláveis e pausá-la.
- Ver massa, raio, luminosidade e temperatura efetiva (Teff) coerentes com a idade e o estágio escolhidos.
- Entender que o avanço estelar é independente do tempo orbital da simulação.
- Saber quando propriedades foram editadas manualmente e quando o modelo evolutivo as governa.
- Receber aviso claro sobre extrapolação e risco de engolfamento de órbitas interiores.
- Exportar/importar o estado evolutivo, se persistência fizer parte da entrega, sem perder compatibilidade com arquivos legados.

## Decisões confirmadas

- **Relógios separados:** idade evolutiva não altera `simulationTimeSeconds`, velocidade orbital ou passo do Worker. Não usar a velocidade N-body para representar Gyr.
- **Escopo inicial:** primeira entrega dedicada ao Sol do preset, começando em trilha solar de `1 M☉`. Não se presume que todas as estrelas do catálogo usem esse modelo.
- **Pausa e exclusão mútua:** relógio evolutivo começa pausado. Durante reprodução/avanço estelar, o relógio orbital fica pausado; para retomar N-body, a pessoa pausa a evolução primeiro. Não há avanço simultâneo.
- **Autoridade:** aplicar cada estado evolutivo por uma ação atômica ao Worker. React não mantém autoridade paralela sobre propriedades físicas; estados de interface podem representar seleção/controle pendente, mas o corpo aceito vem do Worker.
- **Metadados:** registrar `modelId`, versão do modelo e idade evolutiva no estado persistente do Sol.
- **Luminosidade:** derivar consistentemente pela lei de Stefan–Boltzmann a partir de raio e Teff; não cachear nem persistir valor redundante.
- **Fluxo:** UI Dial apresenta irradiância/fluxo geométrico em `W/m²`; não é clima e não pertence às tarefas de renderização Croma.
- **Persistência:** se idade/modelo estelar forem persistidos, criar formato `astro-simulation` v3. Decoder deve continuar aceitando v1 e v2, além de v3. Não adicionar campos a v2: seu schema estrito torna isso incompatível com leitores antigos.
- **Pausa não persistida:** estado de execução/pausa não entra no arquivo; importação inicia evolução pausada.
- **Edição manual:** alterações manuais de massa, raio ou temperatura exigem saída explícita do modo evolutivo. Aplicar o próprio edit manual e preservar como experimento separado, sem reentrada automática na trilha.
- **Fonte aprovada:** trilha local MIST de 1 M☉ com 1.710 pontos. EEP terminal 1710 = `INICIO WDCS`, conforme Tabela II do README oficial; `FSPSphase=6` é categoria agrupada e não nega a transição para anã branca. Domínio: 4,58 Gyr a 11,465471475297027 Gyr; não estender a curva ao resfriamento de anã branca.
- **Proveniência/licença:** fonte exata `.vitest/solar-research/track-summary.json`; trilha `00100M.track.eep`. Descrever como dados científicos de acesso público; nenhuma licença específica identificada. Registrar atribuição e hash real; não inventar licença. Não copiar código, TAR bruto ou dados raw de 4 MB.
- **Modo secular:** grupo(s) osculante(s) solar(es); absorção geométrica aproximada quando pericentro cruza `Rstar + Rcorpo` em qualquer knot ou endpoint da idade. Transferir massa e momento linear ao Sol, com `accretedMassKg ≤ 1e-4 M☉`. Trilha estrutural segue 1 M☉; massa gravitante `Mtrack,ancorada + accretedMassKg`. Por passo: `Mdepois + ΔMvento = Mantes`; `Pdepois + ΔMvento × Vestrela_antes = Pantes`, incluindo engolfamento e transferência interna sem somar acreção duas vezes. Global: `Mativa + Mvento_acumulado = Minicial_sistema`. Vento reage no COM corrigindo velocidade comum de todos os corpos após mapear órbitas, preservando velocidades relativas/osculantes. Terra e Lua formam grupo.
- **Envelope e aproximações:** engenharia verifica `P × mdot / M ≤ 0.1` e perturbação externa ≤1% da atração solar medida pelo COM. Core prova compensação de reação/vento sem impulso relativo arbitrário. Consistência baricêntrica do modo secular não implica conservação de momento angular, spin ou energia globais, nem histórico real em Gyr. Colisões normais N-body permanecem ativas. Sem hidrodinâmica, spin, marés ou clima. Perfil solar permite raio até `3e11 m` (trilha chega a `352.302 R☉ ≈ 2.451e11 m`) e coordenadas até `1e13 m`; limites gerais permanecem.
- **Modo manual/reset:** editar massa, raio ou temperatura sai explicitamente da trilha e preserva o próprio edit; coordenadas estendidas permanecem, sem avançar a trilha estrutural. `Reset Solar` restaura o preset inteiro por ação explícita e rotulada, usando caminho seguro atual de reset/importação.
- **Integração:** coordenador integra os trabalhos e revisa em modo read-only. Não presumir mudança da física orbital além da aplicação validada das propriedades estelares.
- **Escopo de UI:** controles enxutos e acessíveis; sem redesenho da aplicação ou troca de stack.

## Direção de interação proposta

Colocar idade, estágio e controles de evolução no contexto do Sol selecionado. Mostrar o tempo orbital em seu controle atual, com rótulo distinto. Avançar por etapas explícitas, com estado de pausa perceptível e valor acessível por teclado/leitor de tela. O valor de idade deve permanecer legível ao pausar. O componente opcional `SolarEvolutionControls` recebe o corpo aceito e parâmetros/ações de UI por props; não importa nem acopla o módulo de modelo estelar.

Apresentar as quatro propriedades como um conjunto derivado, atualizado atomicamente. Se a pessoa editar propriedades manualmente, encerrar ou suspender a autoridade do modelo evolutivo por ação explícita, preservando a alteração manual e identificando o estado como experimento. Não impor ainda formato exato dos controles nem o comportamento do botão de retorno; isso depende das decisões científicas abertas.

## Limites científicos e de produto

- O núcleo atual é N-body newtoniano, corpos pontuais com raio usado para contato/fusão simplificada. Não modela evolução estelar, envelope, marés, transferência de massa, vento estelar ou resposta térmica orbital.
- Colisões não convertem energia em calor. A explosão manual é fragmentação experimental com energia externa, não supernova nem evolução estelar.
- Absorção geométrica em knot/endpoint é aproximação, não hidrodinâmica nem previsão real de engolfamento. Transferência de massa/momento e vento devem fechar o ledger sem acreção duplicada; teto acumulado de acreção `1e-4 M☉`.
- `MAX_RADIUS_M = 1e10` em `src/simulation/physics.ts` não cobre a trilha: perfil solar precisa de `3e11 m` e coordenadas `1e13 m`, sem ampliar limites gerais. Compatibilizar física, render, escala/câmera e contatos especializados.
- Contato/fusão genérico do integrador não pode competir com absorção por grupos nem contar a mesma massa duas vezes; EEP/trilha estrutural permanece ancorada em 1 M☉.
- Idade, estágio e valores derivados precisam de fonte científica rastreável, domínio de validade e descrição da extrapolação. UI e documentação não podem sugerir precisão profissional.
- Massa, raio, luminosidade e Teff devem vir do mesmo estado do modelo; validação inválida deve rejeitar a atualização inteira e preservar último estado válido.
- O renderizador escolhe a fonte de luz dominante usando `R²T⁴` em `src/features/simulation/body-appearance.ts` (`dominantLightSource`); a intensidade/configuração de luz é ilustrativa em `celestial-scene.ts`. Não escolhe a estrela por massa. Uma luminosidade de primeira classe exigiria contrato explícito e análise de impacto na seleção de fonte.

## Persistência proposta

v3 persiste metadata necessária à reconstrução (modelId, versão, idade e massa/accretion metadata necessária). Não exigir momentum acumulado duplicado quando os vetores atuais dos corpos já representam estado aceito. Luminosidade e Teff são derivados; não duplicar/cachear. Pausa não é persistida. v1/v2 continuam decodificáveis sem estado evolutivo.

O decoder deve validar versão, domínio, coerência entre modelo e tipo do corpo e estado físico antes de substituir o mundo. Importação inválida permanece atômica. Não persistir estado transitório de reprodução/pausa, salvo decisão futura justificada.

## Dependências de arquitetura

O domínio evolutivo deve ser puro e independente de React, Worker visual e Three.js. A aplicação deve converter uma etapa aceita em mutação/revisão do mundo pelo caminho validado existente. O Worker continua autoridade sobre o mundo N-body; o modelo estelar não deve comandar RAF nem redefinir relógio orbital.

### Protocolo de integração C2 confirmado

- `WorldMutation`: `{ type: "INIT_SOLAR_EVOLUTION" }`, `{ type: "ADVANCE_SOLAR_AGE", ageYears }`, `{ type: "EXIT_SOLAR_EVOLUTION" }`. UI enfileira essas ações com a revisão já existente.
- `SimulationWorkerCommand`: `{ type: "SET_STELLAR_EVOLUTION_RUNNING", running }`; snapshot expõe `stellarEvolutionRunning` (ausente equivale a `false`) e client expõe `setStellarEvolutionRunning(boolean)`.
- `START`, `PAUSE` e o estado do Worker governam a exclusão dos relógios. React não cria intervalo físico nem mantém massa/idade como autoridade paralela.
- A trilha orbital limpa quando idade `stellarEvolution.ageYears` muda em snapshot aceito, mesmo sem mudança em tempo orbital/revisão. Snapshot idêntico não limpa trilha.
- Core publica helpers puros `stellarLuminosityW(body)` e `stellarIrradianceWm2(star, target)` em `stellar-evolution.ts`; Dial consome-os no painel do Sol e no inspector de planeta. Irradiância não altera clima/temperatura.
- `Reset Solar` usa o caminho seguro de reset/importação existente e restaura o preset completo. Saída manual é explícita; depois dela, edits locais preservam perfil estendido sem seguir a trilha.

Contratos atuais relevantes:

- `src/simulation/types.ts`: `CelestialBody` armazena `massKg`, `radiusM`, `surfaceTemperatureK`; não tem idade, luminosidade ou Teff explícita.
- `src/simulation/body-edits.ts` e `world-mutations.ts`: edição e mutações são validadas; massa editada preserva movimento. Alterar massa muda gravidade orbital imediatamente.
- `src/simulation/physics.ts`: limites de massa/raio e validação de estado.
- `src/features/simulation/ObjectInspector.tsx`: controles de massa, raio e temperatura; o hint atual diz que temperatura não calcula evolução estelar.
- `src/app/page.tsx`: estado React, fila de mutações com revisão e integração de snapshots.
- `src/features/simulation/SimulationCanvas.tsx`: ponte Worker/snapshots; histórico e cena usam estado aceito.
- `src/features/simulation/body-appearance.ts` e `celestial-scene.ts`: aparência e luz dominante atuais.
- `src/simulation/save-file.ts`: schemas estritos v1/v2, codec local até 10 MiB/64 corpos; deve ganhar v3 sem quebrar leitura legada.
- Documentação de produto/física/arquitetura/design deve declarar o modelo, fonte, limites e persistência após aprovação.

## Ownership e estado da entrega

- **Helion — Core:** física, modelo/domínio, protocolo Worker, mutações, validação, envelope do perfil solar e codec v3. A1 reportado verde; contratos de execução e helpers devem ser consumidos pelos nomes acima.
- **Croma — Render:** cor, material, luz, câmera e escala visuais para o envelope solar. B2 reportado verde; não decide física nem UI.
- **Dial — UI e docs:** ownership exclusivo de `page.tsx`, `ObjectInspector.tsx`, `SimulationCanvas.tsx`, `SolarEvolutionControls.tsx` + teste, `astronomy-units.ts` + teste e documentação C2. `SaveControls.tsx` só se necessário. Sem edição Core/codec/render.
- **Prumo — QA:** validação independente posterior de critérios, regressões e E2E; QA final pendente.
- **Executor + coordenador:** executor integra os deltas; coordenador decide limites/arquivos e revisa read-only. Um escritor por arquivo.

## Critérios de aceite para plano futuro

- Idade/estágio evoluem enquanto relógio orbital permanece idêntico; pausa impede novos passos estelares.
- Massa, raio, luminosidade e Teff representam o mesmo estado aceito e aplicam-se atomicamente.
- Início reproduzível na trilha solar de `1 M☉`; outras estrelas não entram implicitamente no modelo.
- Edição manual permanece disponível como experimento separado e nunca é sobrescrita sem ação explícita.
- Mensagens distinguem idade evolutiva, tempo de viagem, estimativa do modelo e extrapolação/engolfamento.
- Se persistência estiver no escopo: exportação v3 round-trip; leitura v1/v2 mantida; dados inválidos rejeitados sem substituir o mundo.
- Teclado, foco visível, nomes/valores acessíveis, anúncio de estágio e comportamento mobile verificados.
- Nenhum texto afirma resultado orbital confiável além do domínio validado do modelo.

## Revisão e QA

Prumo revisa consistência dos fatos MIST/atribuição, ledger de massa e momento, absorção geométrica, grupos Terra–Lua, limites estendidos, reset integral e contrato da UI no gate final. Divergência retorna ao coordenador; revisão não altera dados nem inventa licença. Implementação C2 está autorizada; QA final permanece pendente.

## Base de código e evidências

Pesquisa Helion: resumo `.vitest/solar-research/track-summary.json`, trilha `00100M.track.eep`, MIST 1 M☉/1.710 pontos; fatos de EEP/domínio e atribuição vêm do resumo. Dados científicos de acesso público; nenhuma licença específica identificada. Registrar hash real e atribuição; não afirmar MIT/CC. Não copiar código, TAR bruto nem dados raw de 4 MB.

Fechamento técnico aprovado pelo coordenador sob autorização do usuário. A1/B2 são reportados verdes; C2 integra UI e docs sob os contratos acima. E2E e revisão QA de Prumo ficam para o gate final.
