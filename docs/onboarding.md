# Preparação local

## Pré-requisitos e execução

Use Node `>=24.21.0 <25` e pnpm `12.11.2`. Confira `node --version` e `pnpm --version`. O inventário, versões efetivamente registradas e ressalvas estão em [setup.md](setup.md). Não há banco, conta ou arquivo `.env` necessário.

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Abra `http://localhost:3000`. A rota inicia a Terra em destaque e simula um dia por segundo. Selecione astros, arraste para explorar e aproxime com a roda. Ver sistema mostra as órbitas; Focar astro visita o selecionado. Use Pausar/Retomar, passagem do tempo e gravidade. No celular, Editar abre o inspetor. Arraste Massa, Tamanho, Temperatura e Água; Digitar valores expande campos exatos em unidades astronômicas. Criar astro abre nove tipos; Lua exige planeta. Remover preserva os demais corpos; Reiniciar sistema restaura o preset e configurações padrão. Exportação escreve `astro-simulation` v2; importação local aceita v1 e v2. [Experimentos e limites físicos](physics.md).

Para produção local: `pnpm build` e `pnpm start`. `pnpm check` encadeia lint, tipos, regras locais, testes e build. Execute `pnpm exec playwright test` para os fluxos Chrome; evidências estão em `setup.md`.

## Primeiro fluxo de trabalho

Leia [AGENTS.md](../AGENTS.md), [PRODUCT.md](../PRODUCT.md) e a tarefa pertinente do [plano aprovado](superpowers/plans/2026-10-15-astro-web-foundation.md). Inspecione `git status` antes de editar. Atualize o documento responsável junto da mudança. [quality.md](quality.md) explica os checks; [setup.md](setup.md), versões e integrações.

Codex lê `AGENTS.md`; `CLAUDE.md` importa o mesmo arquivo, sem integração Claude testada. Skills locais estão em `.agents/skills/` e `skills-lock.json`; três capacidades globais são reaproveitadas conforme a matriz. Abra nova sessão para conferir descoberta antes de depender delas. Executar o app não exige configuração global de agentes.

## Limites e incidente observado

Importação é local, validada antes de substituir o estado e limitada a 10 MiB. A cena exige WebGL 2; se indisponível ou interrompido, a interface mostra uma explicação e mantém controles e lista acessíveis. Gravidade é newtoniana de massas pontuais fora do contato; raio determina tamanho e contato na fusão perfeitamente inelástica. Fase de água assume pressão constante de 1 atm e não simula clima.

O PowerShell com perfil imprimiu `A default version has not been set` na inicialização do fnm; naquela execução, `node` informou 24.21.0. Os comandos seguintes foram executados sem carregar o perfil (`login: false`); nenhuma configuração global foi modificada. Consulte `docs/setup.md` para as evidências registradas dessa sessão; não assuma que o incidente descreve o ambiente atual.
