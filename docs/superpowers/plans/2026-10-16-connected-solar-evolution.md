# Evolução solar conectada — plano de implementação

> **Estado em 16/10/2026:** A1 Core e B2 renderização reportados verdes; C2 UI/Dial autorizada e em integração. Prumo fará QA independente somente no gate final. Sem commits.

**Objetivo:** acrescentar evolução didática do Sol do preset com idade, propriedades estelares derivadas, persistência v3 e controle orbital secular explicitamente aproximado.

**Arquitetura:** Helion é dono de Core, Worker/client/mutações e validação; Croma é dono da renderização e codec v3; Dial integra UI/docs após contrato confirmado; Prumo valida independentemente no fim. Worker permanece autoridade física; relógios evolutivo e orbital nunca avançam juntos.

**Stack:** Next.js/React/TypeScript e Worker existentes; sem dependências novas previstas. Confirmar versões efetivas na execução conforme `docs/setup.md`.

**Design:** `docs/superpowers/specs/2026-10-16-connected-solar-evolution-design.md`.

## Restrições globais

- Primeira entrega aplica-se somente ao Sol do preset e trilha de `1 M☉`.
- Relógio evolutivo inicia pausado. Ao avançar/reproduzir idade, N-body fica pausado; retomar N-body exige pausar evolução.
- Toda etapa física é ação atômica validada pelo Worker; React não mantém estado físico concorrente.
- Luminosidade deriva de `4πR²σTeff⁴`; não persistir cache redundante. Dial exibe irradiância `W/m²` como indicador de fluxo, sem clima.
- Arquivo v3 guarda `modelId`, versão e idade; decoder mantém v1/v2. Estado de execução/pausa não é persistido.
- Edição manual de massa/raio/temperatura sai explicitamente do modo evolutivo e preserva o próprio edit.
- Fonte MIST: trilha 1 M☉, 1.710 pontos; domínio 4,58 Gyr a 11,465471475297027 Gyr; EEP terminal 1710 = `INICIO WDCS` (Tabela II README oficial). `FSPSphase=6` é agrupada, não nega WD. Não estender ao resfriamento WD.
- Fonte exata `.vitest/solar-research/track-summary.json`; trilha `00100M.track.eep`. Dados científicos de acesso público; nenhuma licença específica identificada. Registrar atribuição e hash real; não inventar licença nem copiar código, TAR bruto ou dados raw de 4 MB.
- Perfil solar: raio até `3e11 m`, coordenadas até `1e13 m`; trilha chega a `352.302 R☉ ≈ 2.451e11 m`. Limites gerais permanecem.
- Modo secular: grupos osculantes solares; absorção geométrica em qualquer knot/endpoint quando pericentro cruza `Rstar + Rcorpo`. Transferir massa/momento linear ao Sol, acreção ≤`1e-4 M☉`. Trilha estrutural 1 M☉; massa gravitante = `Mtrack,ancorada + accretedMassKg`. Por passo: `Mdepois + ΔMvento = Mantes`; `Pdepois + ΔMvento × Vestrela_antes = Pantes`, sem somar acreção duas vezes. Global: `Mativa + Mvento_acumulado = Minicial_sistema`. Vento reage no COM corrigindo velocidade comum de todos corpos após mapear órbitas, preservando velocidades relativas/osculantes. Earth–Moon como grupo.
- Core prova compensação de reação/vento sem impulso relativo arbitrário. Consistência baricêntrica não alega conservação global de momento angular, spin ou energia nem histórico real Gyr. Colisões normais N-body permanecem. Verificar `P × mdot / M ≤ 0.1` e perturbação externa ≤1% da atração solar por COM. Sem hidro, spin, marés ou clima.
- Reset Solar restaura o preset completo pelo fluxo seguro existente; sair para edição manual preserva perfil coordenado estendido, mas não continua a trilha.
- Um escritor por arquivo; arquivos de coordenação/lockfile não mudam salvo necessidade demonstrada e autorização do coordenador.
- Contrato C2 confirmado: mutações `INIT_SOLAR_EVOLUTION`, `ADVANCE_SOLAR_AGE { ageYears }`, `EXIT_SOLAR_EVOLUTION`; comando `SET_STELLAR_EVOLUTION_RUNNING { running }`; snapshot `stellarEvolutionRunning` opcional (default false); client `setStellarEvolutionRunning(boolean)`. Idade/saída usam revisão existente.
- Core exporta `stellarLuminosityW(body)` e `stellarIrradianceWm2(star, target)` em `stellar-evolution.ts`. Limpar trilhas ao mudar `stellarEvolution.ageYears` em snapshot aceito; snapshot idêntico não limpa.
- Escopo desta tarefa é plano e atualização da spec somente; não executar código, testes, configuração ou browser.

## Review focus

- Arquivo ausente/corrompido, atribuição divergente ou hash errado: rejeitar dados; registrar ausência de licença específica sem inventar termos; testar validação de domínio por Helion.
- Idade fora de 4,58–11,465471475297027 Gyr ou número não finito: rejeitar sem alterar Worker; teste unitário por Helion.
- Pausa/retomada concorrente entre relógios: provar exclusão mútua no teste de integração Worker/Core.
- Atualização parcial de massa/raio/Teff: testar atomicidade e rollback no contrato de mutação.
- Absorção/vento: testar ledger massa/momento, teto `1e-4 M☉`, e que acreção não é somada duas vezes.
- Raio solar cruza grupo: testar absorção por pericentro/knot/endpoint, Earth–Moon em COM e que fusão genérica não duplica absorção.

## Arquivos e ownership

- **Helion — Core:** `src/simulation/types.ts`, `src/simulation/physics.ts`, novos módulos de dados/domínio estelar, protocolo/Worker e mutações, `src/simulation/save-file.ts` e testes correspondentes. Helion especifica caminho/nome final dos novos módulos ao fechar interfaces; sem inventar API antes disso.
- **Croma — Render:** `src/features/simulation/body-appearance.ts`, `celestial-bodies.ts`, `celestial-scene.ts`, `camera-focus.ts`, `scene-scale.ts` e testes visuais/unidade próprios; cor/material/luz/câmera/escala apenas. Irradiância UI não pertence a Croma.
- **Dial — UI + docs:** `src/app/page.tsx`, `src/features/simulation/ObjectInspector.tsx`, novo `SolarEvolutionControls.tsx` opcional com props de corpo aceito + parâmetros/ações UI sem importar modelo, `src/features/simulation/SimulationCanvas.tsx` se necessário, UI de irradiância `W/m²`, Reset Solar integral; `PRODUCT.md`, `docs/physics.md`, `docs/architecture.md`, `docs/design.md` e spec. Integrar interfaces publicadas por Helion; não editar arquivos Core/Render.
- **Prumo — QA final:** arquivos `e2e/` e artefatos de evidência/relatório atribuídos no plano de QA; validação independente, sem editar arquivos de produto.
- **Coordenação:** decide interfaces/arquivos compartilhados e integra deltas read-only. Se `SimulationCanvas.tsx` tocar visualização além da ponte de estado, coordenador decide ownership antes de editar. Lockfile só muda com necessidade comprovada.

## Fase A1 — contratos e metadata; Helion — concluída, verde reportado

**Arquivos:** `src/simulation/types.ts` e fixtures/documentação de contrato pertencentes a Helion. Fonte factual exata: `.vitest/solar-research/track-summary.json`; trilha: `00100M.track.eep`. Dados científicos de acesso público; metadados sem licença específica identificada. Nenhum código, TAR bruto ou dados raw de 4 MB são copiados.

- [ ] Exportar tipos metadata do Sol: modelId, modelVersion, ageGyr e estado secular mínimo a fechar com relatório Helion. Dados físicos permanecem Worker-authoritative.
- [ ] Registrar fonte MIST de 1 M☉, 1.710 pontos, domínio conhecido e EEP terminal 1710 = `INICIO WDCS`; não extrapolar ao resfriamento WD.
- [ ] Registrar atribuição, URL/hash e hash da trilha; metadados indicam acesso público e licença específica não identificada. Não inventar licença nem copiar código/TAR/raw.
- [ ] Revisão curta Prumo da spec e contratos A1; coordenador resolve achados. **Gate:** nenhuma tarefa A2/B/C começa antes desse gate.

## Fase A2 — domínio, validação e dados; Helion

**Arquivos:** módulos Core definidos na Fase 0, `types.ts`, `physics.ts` e testes de domínio/validação de ownership Helion.

- [ ] Escrever testes para amostras MIST documentadas, domínio 4,58–11,465471475297027 Gyr, entradas inválidas, valores finitos/unidades e propriedades derivadas coerentes.
- [ ] Implementar leitor/adaptador mínimo de dados numéricos compactos locais; não incluir código, TAR bruto ou arquivo raw de 4 MB; registrar hash/atribuição.
- [ ] Implementar função pura de idade → estágio e propriedades; calcular luminosidade e irradiância derivadas, sem clima nem cache persistente.
- [ ] Implementar validação atômica do perfil solar até raio `3e11 m` e coordenadas `1e13 m`; manter limites gerais e mundo anterior em rejeição.
- [ ] Rodar testes focados Core e typecheck; registrar comandos/resultados para revisão.

## Fase A3 — Worker, protocolo, codec v3 e modo secular; Helion

**Arquivos:** protocolo/mutações/Worker, `save-file.ts` e testes Core pertencentes a Helion.

- [ ] Definir e testar uma mutação atômica de passo/seek que carrega metadata `modelId`, versão e idade com estado físico derivado aceito.
- [ ] Fazer Worker autoridade única; impedir avanço orbital enquanto evolução roda e exigir pausa evolutiva para retomar N-body. Estado inicia pausado após criação/importação.
- [ ] Implementar grupos osculantes solares e absorção aproximada quando pericentro cruza `Rstar + Rcorpo` em knot/endpoint; absorver massa/momento linear ao Sol, teto total `1e-4 M☉`.
- [ ] Manter trilha estrutural ancorada em 1 M☉, massa gravitante `Mtrack,ancorada + accretedMassKg`, teto de acreção `1e-4 M☉`. Por passo verificar `Mdepois + ΔMvento = Mantes` e `Pdepois + ΔMvento × Vestrela_antes = Pantes`; global `Mativa + Mvento_acumulado = Minicial_sistema`. Não contar absorção/acreção duas vezes.
- [ ] Após mapear elementos/orbitas, aplicar reação de vento como correção da velocidade COM comum de todos os corpos, preservando velocidades relativas/osculantes. Testar ausência de impulso relativo arbitrário e manutenção da contabilidade de momento linear; não alegar conservação de momento angular/spin/energia nem histórico Gyr. Preservar colisões normais N-body.
- [ ] Preservar forma orbital via `a × (Mstar + mgrupo)` e fase instantânea, sem alegar posição real em Gyr; tratar Terra–Lua como grupo COM. Verificar `P × mdot / M ≤ 0.1` e perturbação externa ≤1% da atração solar por COM.
- [ ] Manter edição manual como modo separado; mutação manual de massa/raio/temperatura requer ação explícita de saída e aplica o valor manual sem passo estelar concorrente.
- [ ] Implementar v3: persistir metadata necessária; recalcular propriedades; não salvar pausa; decodificar v1/v2/v3 e validar atomicamente. Testar round-trip v3, fixtures v1/v2 e entradas v3 inválidas.
- [ ] Rodar testes focados Worker/codec e regras/types Core; registrar resultados.

## Fase B — renderização; Croma — B2 reportado verde

**Arquivos:** `body-appearance.ts`, `celestial-bodies.ts`, `celestial-scene.ts`, `camera-focus.ts`, `scene-scale.ts` e testes de ownership Croma.

- [ ] Integrar temperatura/raio aceitos sem derivar física no renderizador; iluminar pela luminosidade derivada com fonte dominante e exposição declarada ilustrativa.
- [ ] Ajustar escala/câmera/limites visuais para raio `3e11 m` e coordenadas `1e13 m` do perfil solar, mantendo caminhos e limites dos demais corpos.
- [ ] Testar seleção da fonte, escalas, enquadramento e transições entre viewport desktop/mobile; validar que crescimento não causa NaN, clipping catastrófico ou custo não limitado.
- [ ] Rodar testes focados/lint Croma; registrar resultados para revisão.

## Fase C2 — integração UI e documentação; Dial — concluída, verificação focada aprovada

**Arquivos:** `page.tsx`, `ObjectInspector.tsx`, novo `SolarEvolutionControls.tsx` se útil, `SimulationCanvas.tsx` se necessário; docs listadas em Ownership.

- [x] Integrar painel do Sol selecionado: idade real em Gyr, estágio acessível, propriedades do snapshot aceito, marcos fornecidos pelo modelo, iniciar/pausar e avanço por idade; nenhum intervalo físico local.
- [x] Manter clock orbital parado enquanto Worker reporta `stellarEvolutionRunning`; permitir retomar N-body somente após pausar evolução. O Worker segue autoridade; botão da UI envia comandos acordados.
- [x] Exibir irradiância do planeta pelo helper Core `stellarIrradianceWm2(star, target)` em `W/m²`, sem alterar clima/temperatura. Luminosidade vem de `stellarLuminosityW(body)`.
- [x] Usar `getBodyEditLimits` em sliders e passar limites para `parseAstronomicalEdit`; permitir edição válida em raio/coordenadas do perfil solar.
- [x] Limpar histórico orbital quando `stellarEvolution.ageYears` muda em snapshot aceito, inclusive com relógio/revisão iguais; preservar em snapshots sem mudança de idade.
- [x] Edição manual exige ação explícita para sair do modelo e preserva perfil estendido. `Reset Solar` rotula substituição integral e usa fluxo seguro existente.
- [x] Iniciar pausado. Evolução pausa N-body; retomar N-body exige pausar evolução. `Reset Solar` exige ação explicitamente rotulada e restaura preset inteiro via fluxo seguro existente de reset/importação.
- [x] Mostrar estágio, idade, massa, raio e Teff do mesmo snapshot aceito; luminosidade derivada e fluxo `W/m²` apresentado por Dial sem rótulo de clima.
- [x] Edição manual de massa/raio/temperatura pede saída do modo evolutivo, preserva o edit e perfil de coordenadas estendido, interrompe trilha estrutural e identifica experimento manual. Sem sobrescrita automática ou reentrada implícita.
- [x] Anunciar modelo/fonte/faixa aprovada, incerteza/extrapolação e política de contato/engolfamento fornecida por Helion. Não inventar idades/estágios nem afirmar órbitas reais em Gyr.
- [x] Atualizar docs para comportamento efetivamente entregue, contrato v3, arquivos antigos, limites especiais e limitações. Não documentar intenção como feature entregue antes da integração.
- [x] Rodar unitários/UI focados, lint e typecheck; registrar resultados.

## Fase D — integração final, Prumo QA e gate REVIEW; somente ao final

- [x] **Core — prova unitária reportada:** Helion reportou 224 testes em 17 arquivos, lint/typecheck verdes. `simulation.worker.test.ts` cobre exclusividade dos clocks e rollback; `stellar-evolution.test.ts` cobre EEP 1710/white dwarf, absorção Earth–Moon, ledger e fechamento massa/momento; `save-file.test.ts` cobre codec v3 e rejeições.
- [x] **UI — prova focada reportada:** Dial reportou 21/21 em cinco arquivos, ESLint e typecheck verdes; testes do inspetor cobrem G/medidas/BH, toolbar os clocks e controles o marco terminal/idade acessível. Isso não equivale a E2E de teclado/W/m².
- [x] **Prumo — browser:** os três cenários solares anteriores passaram 3/3; cenário terminal novo passou isolado 1/1: marco aceito em idade final, estágio/`white-dwarf`, massa/raio compatíveis com helper Core, igualdade entre massa acretada e IDs absorvidos, fechamento massa ativa + vento e rejeição v3 preservando estado. Não mede reação COM por passo.
- [x] **Prumo — import no browser:** v3 round-trip, fixtures v1/v2 e novo caso de idade v3 fora do domínio rejeitada preservando export anterior.
- Cobertura browser não observada nesta QA (limite, sem tarefa aberta): teclado/acessibilidade, fluxo W/m² visível, contato/limites completos e comunicação visual terminal mobile.
- Medições não executadas nesta QA (limite, sem tarefa aberta): `P × mdot / M ≤ 0.1`, perturbação ≤1% e reação COM por passo. A checagem read-only MIST confirma hashes/extração, não revalida física.
- [x] **MIST — proveniência reportada por Helion:** archive SHA256 `a445d926c1765e951eb1bf6811dbfb14635725efcf63aaaa883d02f36cc58741` e raw track SHA256 `a962600501741588e17ac133d60040ca686c62a2e5f07100f9eeeec3be1bc4f3` coincidem com metadata; 1710×77, cinco campos compactos em todas as linhas e dez primary EEPs coincidem. MIST v1.2, trilha 1 M☉; referências indicadas pelo projeto: Dotter 2016 e Choi et al. 2016 ([MIST References](https://mist.science/references.html)).
- Limite de licença MIST: nenhuma licença específica foi identificada; não inferir licença ou permissão.
- [x] `pnpm check` passou antes do novo cenário QA: lint (zero erros, um warning legado), typecheck, lint:rules, 311 testes em 36 arquivos e build. Os três E2E solares prévios passaram 3/3; cenário terminal rodado depois, isolado 1/1. ESLint do spec QA passou após a adição.
- [x] `git diff --check` passou sem stage ou commit.
- [x] **REVIEW aprovado pelo coordenador:** provas combinadas Core/unitárias + E2E confirmam domínio/estágio terminal, clocks/atomicidade Worker, codec v1/v2/v3, ledger e ownership revisado. MIST: hashes/extração e referências registrados; licença específica desconhecida sem alegação de permissão. Revisão focada sem P1/P2.

## Limites científicos ainda ativos

1. **Metadados:** archive MIST v1.2 e track local validados por Helion contra hashes nos metadados; membro raw 1710×77, cinco campos compactos e dez primary EEPs coincidem. Manter atribuição. Licença específica não foi identificada; não inferir licença/permissão. MIST recomenda Dotter (2016) e Choi et al. (2016): [References](https://mist.science/references.html). Fontes locais: `.vitest/solar-research/track-summary.json`, `00100M.track.eep`.

C2 e QA focal D concluídos e Gate REVIEW aprovado pelo coordenador após três E2E solares anteriores + um terminal isolado, `pnpm check` final anterior à adição do teste QA, revisão visual CSS desktop/mobile e provas Core/UI indicadas acima; veja `docs/quality.md`. E2E registra somente provas de browser; Core/unitários cobrem contratos internos. Limites explícitos de cobertura incluem browser teclado/W/m²/terminal mobile, medição independente `P × mdot / M`, perturbação e reação COM por passo, licença MIST não identificada e ausência de `pnpm check` global após a adição QA. `git diff --check` passou. Revisão global de alterações preexistentes ficou fora do escopo. Sem commit, push, deploy ou mudança de dependência.
