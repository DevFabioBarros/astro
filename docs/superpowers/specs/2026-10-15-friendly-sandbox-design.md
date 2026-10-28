# Sandbox acessível e experimentos gravitacionais

Continuação solicitada pelo usuário em 2026-10-15. Preserva as especificações e o plano anteriores; este recorte acrescenta controles por arraste, catálogo e experimentos sem trocar stack ou ativos.

## Aceite

- Massa, tamanho, temperatura e água ajustáveis por sliders; digitação avançada continua disponível.
- Massa altera força sem reiniciar tempo, posição ou velocidade. Ações usam estado autoritativo do Worker.
- Remover Terra mantém Lua em movimento sob as forças restantes.
- Catálogo com estrela, anã branca, estrela de nêutrons, buraco negro, planeta rochoso, gigante gasoso, lua, asteroide e cometa. Lua nova exige planeta.
- Reiniciar restaura Sistema Solar, configurações padrão e Terra em foco. Mundo vazio permanece utilizável.
- Exportação v2 preserva metadados; importação v1 continua válida. Validação precede substituição do mundo.
- Cena GLB distingue remanescentes, exclui buracos negros das fontes de luz e acompanha mudança de primário dos guias.
- Revisão independente de física/protocolo e UI/renderização; checks e inspeção desktop/celular executados por agentes de validação.

## Limites

Newtoniano N-body, sem colisões, evolução ou relatividade. Buraco negro tem horizonte derivado da massa e disco ilustrativo; encontros até 50 raios de Schwarzschild são recusados com gravidade ativa. Fontes e derivação dos experimentos ficam em [physics.md](../../physics.md).

Nenhum deploy, push, serviço pago ou alteração global integra este recorte.
