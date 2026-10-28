# Astro

Sandbox astronômica no navegador. O corte atual combina Sistema Solar em cena 3D, gravidade newtoniana, edição de corpos e arquivos locais. Consulte [PRODUCT.md](PRODUCT.md) para recursos entregues e roadmap.

A Onda 1 de universo dinâmico está em andamento, mas ainda não foi entregue nem aprovada em QA. O contrato, limitações e plano estão em [física](docs/physics.md), [arquitetura](docs/architecture.md) e [plano de execução](docs/superpowers/plans/2026-10-15-dynamic-universe.md).

## Executar

Use Node `>=24.21.0 <25` e pnpm `12.11.2`:

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Abra `http://localhost:3000`. A página inicia com a Terra em destaque e um dia simulado por segundo. Use Pausar para parar o tempo. Não há variáveis de ambiente obrigatórias, conta ou banco.

Para produção local, execute `pnpm build` e `pnpm start`. `pnpm check` reúne lint, tipos, regras locais, testes e build; os resultados da validação integrada estão em `docs/setup.md`.

## Usar a sandbox

- Selecione astros pelo nome ou na navegação inferior. Arraste para explorar e use a roda para aproximar. Use Ver sistema para visualizar as órbitas e Focar astro para visitar a superfície.
- Raios e distâncias seguem a mesma escala física. Marcadores permitem encontrar planetas que ficam minúsculos na visão do sistema; selecionar não aumenta o corpo.
- Pause ou retome e escolha uma hora, um dia, uma semana ou um mês simulado por segundo. Gravidade ajusta a intensidade em relação ao valor natural.
- Use Criar astro para escolher entre nove tipos, de luas a buracos negros. Escolha o centro da órbita inicial; novas luas exigem um planeta. Sem órbita inicial posiciona o corpo sem velocidade inicial.
- Arraste Massa, Tamanho, Temperatura e Água. Massa oferece atalhos 1×, 2× e 10× em relação à seleção inicial. Digitar valores abre campos exatos; Órbita e movimento abre posição e velocidade. No celular, Editar abre o inspetor.
- Remover apaga apenas o astro escolhido; seus satélites continuam com o movimento e a gravidade dos corpos restantes. Reiniciar sistema recupera o Sistema Solar e seus valores padrão.
- A temperatura muda cor e propriedades do material de superfície conforme a fase simplificada da água a 1 atm: gelo mais fosco, líquido mais liso/refletivo e vapor translúcido. Isso não representa clima ou fluxo de água.
- A esfera GLB é gerada por `node scripts/generate-sphere-glb.mjs`. Terra e Via Láctea têm mapas de até 8K; os demais mapas são 2K. Fontes e licença CC BY 4.0 estão em [créditos](public/textures/ATTRIBUTION.md).
- Exporte JSON local `astro-simulation` v2; importe v1 ou v2, inclusive mundos vazios. Importações inválidas, acima de 10 MiB ou com mais de 64 astros não substituem a simulação.

O raio altera o tamanho visual, mas não a física de massas pontuais; colisões não estão implementadas. Se WebGL 2 estiver indisponível, a interface informa a limitação e mantém os controles/lista acessíveis.

## Documentação

- [Produto e roadmap](PRODUCT.md).
- [Preparação local](docs/onboarding.md).
- [Arquitetura](docs/architecture.md).
- [Design e acessibilidade](docs/design.md).
- [Qualidade](docs/quality.md).
- [Física, experimentos e fontes NASA](docs/physics.md).
- [Instruções para agentes](AGENTS.md).
- [Setup, versões e matriz do toolkit](docs/setup.md).
- [Especificação aprovada](docs/superpowers/specs/2026-10-15-astro-design.md) e [plano aprovado](docs/superpowers/plans/2026-10-15-astro-web-foundation.md).
