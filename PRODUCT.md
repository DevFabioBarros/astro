# Astro

## Produto

Astro é um projeto pessoal para brincar com o Sistema Solar: abrir um overview visível, selecionar e focar corpos, ajustar o tempo e pausar. Impactos com consequências persistentes e captura criativa por buraco negro são as duas ações de destaque. Reset e saves locais fecham a jornada; o Worker decide os resultados e a interface identifica arte visual. O projeto não busca realismo universal ou equivalência MLR. Universe Sandbox inspira capacidades, sem copiar marca, código, interface, texto, datasets ou ativos.

## Entregue

- Sistema Solar inicial com Sol, oito planetas e Lua, em cena Three.js/WebGL 2.
- O orçamento visual ajusta o DPR ao tamanho da cena, ao limite de textura da GPU e à cadência RAF; cenas pausadas renderizam a 15 fps e abas ocultas suspendem o loop.
- Abertura no overview solar pausado, com estado acessível de preparação da cena e do motor de simulação.
- Gravidade newtoniana N-body calculada em Web Worker com velocity-Verlet e passo adaptativo; inicia em movimento a um dia por segundo e a interface limita o controle a um dia por segundo.
- Posições e órbitas usam unidades físicas; em Ver sistema, raios visuais mínimos ajudam a localizar corpos pequenos. Foco usa escala física, exceto ampliação artística do buraco negro criativo. Órbitas são guias osculantes, não previsão N-body.
- Referencial orbital visual com pontos L1–L5 aproximados; clique cria um cometa com pose inicial no ponto escolhido.
- Trilha histórica sólida deriva de snapshots aceitos e de lotes opcionais de subpassos reais aceitos pelo integrador; cada corpo mantém até 256 amostras. O Worker publica no máximo 128 subpassos e ~512 KiB estimados por lote, decimando candidatos reais quando necessário. A amostragem mira passos angulares de 5° e tem teto de um dia simulado. A 1 mês simulado/s, snapshots isolados ficam separados por ~1,5 dia (cerca de 18,08 pontos por órbita lunar, contra 72 no alvo de 5°); subpassos podem melhorar a resolução, sem garanti-la. Guia osculante contínua mostra estimativa instantânea de dois corpos; controles Órbitas e Rastros são independentes.
- Experimento binário em um clique no dock: duas estrelas orbitam o baricentro em uma órbita de cerca de 23 dias, com órbitas estimadas e rastros; substitui o mundo atual e respeita o limite da interface de um dia por segundo.
- Biblioteca com sete cenas jogáveis: binária, Terra–Marte, captura criativa, Sol extremo, eclipse solar, Lua mais distante e impacto de raspão. Cada cartão mostra miniatura, duração aproximada e detalhes técnicos sob demanda.
- Terra com continentes, nuvens, luzes noturnas e atmosfera; mapas planetários, anéis de Saturno, Sol luminoso e fundo da Via Láctea.
- Cometas têm cauda procedural azul/âmbar orientada pela estrela luminosa mais próxima; é VFX, sem perda de massa ou força.
- Iluminação visual combina até duas estrelas normalmente ou quatro em telas de alta resolução compatíveis; eclipses e sombra dos anéis são aproximados e não alteram temperatura.
- Seleção pela cena ou lista abre o inspetor; catálogo com estrela, anã branca, estrela de nêutrons, buraco negro, planeta rochoso, gigante gasoso, lua, asteroide e cometa.
- Controles de massa, tamanho, temperatura e água; digitação opcional e edição avançada de posição/velocidade. A edição estelar de sequência principal usa Eker 2018 entre 0,179 e 31 M☉ para derivar massa, raio e temperatura no candidato aceito; não avança a fase ou idade. Alterar massa orbital preserva posição e velocidade.
- Remoção individual sem apagar satélites; Reiniciar sistema restaura o Sistema Solar, gravidade natural, tempo e velocidade padrão.
- Desfazer/Refazer locais usam checkpoints autoritativos do Worker, com limite de 20 ações e 16 MiB; gestos contínuos de sliders formam uma ação. Reset e importação iniciam nova geração; histórico e eventos não entram nos saves.
- Fase visual de água por temperatura, sob aproximação de 1 atm. A adesão explícita ao inventário versionado acrescenta massa/volume e registra líquido, gelo, vapor e água escapada; aquecimento usa uma regra de retenção nomeada e resfriamento não restaura perdas. Corpos legacy mantêm a regra antiga sem migração implícita. Um perfil térmico terrestre aproximado pode ser ativado por corpo e aquece/esfria pela luz estelar aceita; com atmosfera explícita, o solver usa o diagnóstico óptico aceito no fechamento greenhouse abaixo.
- Explodir uma estrela comum no modo criativo mantém o corpo intacto e emite gás visual transitório. Capturas aceitas por buraco negro criativo recebem um vórtice breve. Esses efeitos não adicionam massa, calor ou energia ao modelo.
- Evolução didática apenas para o Sol do preset, pela trilha MIST local de 1 M☉; relógio estelar e tempo orbital são exclusivos. Saves v7 preservam composição explícita e estado atmosférico opcional, v6 inventário de água, v5 perfis térmicos; leitura aceita v1–v7.
- Interface em km, UA, km/s, °C, porcentagem e massa em notação científica; editor recolhível no celular.
- Medidas derivadas ficam em bloco recolhível; trajetória orbital tem diagrama osculante, periastro, apoastro, período e inclinação derivados do estado aceito. Não prevê a trajetória N-body.
- Exportação local de JSON `astro-simulation` v7 quando há composição explícita ou atmosfera (atmosfera exige composição), v6 quando há inventário de água, v5 quando há perfil térmico e v2–v4 conforme os campos. Leitura aceita v1–v7, de zero a 64 astros.

## Limites do modelo

Corpos seguem gravidade newtoniana; órbitas desenhadas são guias, não previsões de longo prazo. Colisões físicas têm domínios limitados; fragmentação criativa e seus efeitos visuais não representam ejecta calibrada nem energia física adicional.

Temperatura, água e atmosfera são modelos simplificados e opcionais, sem clima local, estações ou circulação. Relevo e efeitos de cena não alteram raio físico, massa ou gravidade. Buracos negros usam raio de Schwarzschild como referência; captura e ampliação criativas não simulam relatividade geral, acreção ou lente gravitacional física.

Saves ficam no dispositivo; importações inválidas ou acima de 10 MiB são rejeitadas sem substituir o mundo. Hipóteses, equações e domínios detalhados estão em [física](docs/physics.md) e [arquitetura](docs/architecture.md).

## Onda 1 do universo dinâmico — QA final reportado em 16/10/2026

Gates finais reportados por Prisma: `pnpm check` PASS (240 testes em 29 arquivos; lint 0 erros/1 warning legado; typecheck, regras e build Next.js 16.4.1 verdes) e Playwright Chrome PASS 24/24 em 181079 ms. No smoke pós-release, a trilha ficou visível em movimento; a esfera oculta trechos na limb e nenhum desalinhamento geométrico foi reproduzido. A binária carregou duas estrelas a 1 mês/s (~80,54 dias), com UI indicando iluminação pela estrela dominante. A Lua mostrou crateras/maria sem seam óbvia; não houve comparação pixel-centro concluída nem defeito claro. Captura da explosão mostra seis fragmentos e aviso; imagem estática não prova presença/ausência de efeito efêmero ou pluma. Mobile 390×844 corta o trilho após Jupiter parcial, sem overflow do documento. Mobile e contraste ficam como oportunidades visuais/risco UX, sem alvo medido ou quebra funcional demonstrada. Servidor restaurado em foreground: HTTP 200, PID 4000, Next `start-server.js` deste checkout. Capturas e fontes estão em [plano de astronomia](docs/superpowers/plans/2026-10-16-astronomy-next-stage.md) e [quality](docs/quality.md).

Registro histórico da onda de 15–16/10: desde então colisões, eventos, edição estelar, captures criativas e saves mudaram. Para o contrato vigente, consulte os limites acima e [física](docs/physics.md), [arquitetura](docs/architecture.md) e [créditos dos mapas](public/textures/ATTRIBUTION.md). Os números de QA desta seção pertencem àquela execução e não demonstram gates atuais.

## Cenário binário

“Dança binária” no dock substitui o mundo atual por duas estrelas em órbita do baricentro, separadas por 0,2 UA. A órbita circular dura cerca de 23,1 dias; o cenário inicia a 1 dia/s e liga guias orbitais e rastros. O inspetor abre na estrela B com diagrama e elementos osculantes relativos. Reiniciar simulação restaura o Sistema Solar. A cena pode usar ambas as estrelas como fontes visuais; movimento e órbitas reais continuam N-body, sem evolução estelar ou relatividade.

## Roadmap

Prioridade: completar a jornada do Sistema Solar e as duas ações de destaque descritas no [plano Portfolio v1](docs/superpowers/plans/2026-10-23-astro-sandbox-orchestration.md). Lua/binário segue como bônus existente. Ferramentas laser/spin, MIST, órbita avançada, anéis/enxames, T14–T23, clima preciso e pincel ficam fora do caminho feliz; preserve o código e não amplie esses temas.

## Plataforma e continuidade

Web é a plataforma inicial; Windows e Chrome formam o primeiro ambiente de desenvolvimento. A cena usa WebGL 2 e apresenta fallback acessível quando a inicialização falha. Desktop só será reconsiderado diante de medições que mostrem limites concretos da web. Publicação, push e serviços pagos exigem autorização própria.
