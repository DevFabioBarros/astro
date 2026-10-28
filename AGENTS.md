# Astro — instruções compartilhadas

Leia `PRODUCT.md`, os arquivos pertinentes e o plano aprovado antes de editar. `docs/setup.md` registra versões, ferramentas e limites; `docs/architecture.md` descreve a estrutura implementada.

## Comandos

- Node `>=24.21.0 <25`; pnpm `12.11.2`. Versões instaladas e ressalvas: `docs/setup.md`.
- Instalar: `pnpm install --frozen-lockfile`.
- Desenvolver: `pnpm dev`; produção: `pnpm build` e `pnpm start`.
- Lint: `pnpm lint`; tipos: `pnpm typecheck`; regras: `pnpm lint:rules`.
- Testes: `pnpm test`; todos os checks: `pnpm check`.

## Acordos

- Faça a menor alteração completa, reutilizando padrões. Preserve alterações locais, validação, erros e acessibilidade.
- Responda em português brasileiro com concisão; código, docs e commits usam redação normal. Ponytail full e Caveman são preferências que o usuário pode desativar.
- Diferencie fatos, hipóteses e resultados executados. Atualize o documento responsável junto de mudanças de comportamento, comandos ou fronteiras.
- Continue trabalho autorizado e pergunte apenas por informação indispensável. Responda a status e retome; respeite pausas, negativas e limites.
- Banco, credenciais, serviços, custos, publicação, push e mensagens a terceiros exigem autorização pertinente. Não introduza hooks Git, bloqueios de push ou exigência de branch/worktree.
- Lógica relevante exige checks proporcionais; não enfraqueça regras para fazê-los passar. Nenhum check publica ou migra dados.
- Física permanece independente da renderização. Valide entradas externas em runtime; segredos não pertencem ao cliente ou aos logs.
- Use Context7 disponível e fontes oficiais para APIs. Reutilize RTK sem duplicar hooks/wrappers. Não altere integrações globais em tarefas do projeto.
- Graphify: use `GRAPHIFY_NO_AUTO_REFRESH=1` e extração `--code-only --no-cluster`. Confira cobertura e atualidade antes de confiar no grafo. `.graphifyignore` exclui segredos e gerados. Não use backend pago ou refresh por hook.
- Preserve cliente, autenticação e modelo autorizados. Delegue somente quando autorizado e útil, com um escritor por arquivo e revisão do coordenador. Um plano aprovado ou skill ativa que exija delegação é autorização explícita: use a ferramenta de agentes disponível; se ela faltar, pare antes de executar inline e reporte o bloqueio.
- Na retomada confira checkout, arquivos e processos reais. Bloqueios afetam tarefas dependentes. Não prometa execução em segundo plano sem processo verificável.

## Fontes e skills sob demanda

Produto: `PRODUCT.md`; código: `docs/architecture.md`; UI: `docs/design.md`; entrada local: `docs/onboarding.md`; checks/revisão: `docs/quality.md`; ferramentas e versões: `docs/setup.md`.

Skills locais e hashes estão em `.agents/skills/` e `skills-lock.json`. React best practices, web design guidelines e find-skills são reutilizadas do ambiente atual; a matriz explica portabilidade. Confirme descoberta numa nova sessão. Instalar deploy não autoriza publicar. Transições e otimização entram apenas com necessidade concreta.

## Produto atual

`PRODUCT.md` separa recursos entregues do roadmap. A aplicação inclui Sistema Solar, simulação em Worker, editor, cena 3D e importação/exportação local. Física usa unidades SI e limites explícitos; atualize [architecture.md](docs/architecture.md) e [design.md](docs/design.md) quando contratos ou fluxos mudarem. Não descreva features planejadas como entregues. Importações não transmitem conteúdo nem substituem estado antes da validação.
<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

