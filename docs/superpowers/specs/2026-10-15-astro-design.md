# Astro — design do produto

**Data:** 2026-10-15  
**Estado:** aprovado pelo usuário; plataforma web-first atualizada em 2026-10-15  
**Fonte do processo:** `C:\Users\fabio\Desktop\toolkits\vibe-coding-toolkit`, revisão local presente em 2026-10-15.

## Intenção

Astro será um simulador espacial sandbox inspirado no conjunto de recursos de Universe Sandbox. Deve permitir explorar sistemas astronômicos, criar corpos celestes e alterar propriedades físicas para observar consequências na simulação. O projeto será desenvolvido com apoio de agentes de IA; suas instruções e verificações devem tornar mudanças compreensíveis e revisáveis por agentes diferentes.

## Público e resultado

- Público principal: entusiastas de astronomia.
- Público secundário: estudantes de programação que testarão a aplicação.
- Resultado: abrir uma simulação, experimentar livremente alterações e observar efeitos físicos e visuais; salvar e compartilhar o resultado como arquivo.

## Experiência e plataforma

- Primeira plataforma: aplicação web no navegador, acessível no computador sem instalar editor ou engine de jogos.
- Otimizar o núcleo e medir desempenho no navegador. Considerar uma versão desktop somente se medições mostrarem que a web não atende aos cenários necessários.
- Windows e Chrome formam o primeiro ambiente de desenvolvimento e validação; buscar suporte aos principais navegadores desktop conforme compatibilidade e desempenho.
- A simulação inicial é o Sistema Solar.
- A pessoa pode alterar objetos e parâmetros sem um fluxo obrigatório ou uma tarefa prescrita.
- Simulações podem ser salvas, exportadas, importadas e enviadas como arquivos. Serviço de nuvem ou contas não fazem parte do escopo definido.

## Escopo de recursos

O objetivo de longo prazo é cobrir o conjunto de recursos de Universe Sandbox, organizado em entregas incrementais:

1. **Sistemas e gravidade:** criar estrelas, planetas, luas, anéis, cometas, buracos negros e sistemas; simular gravidade N-body newtoniana; controlar passagem do tempo e órbitas.
2. **Edição livre:** alterar massa, tamanho, composição, temperatura, rotação, inclinação, órbita e parâmetros globais da física; criar, duplicar, remover e editar vários objetos.
3. **Colisões e evolução:** impactos, aquecimento, crateras, fragmentação, marés, evolução e explosões estelares, flares e efeitos de buracos negros.
4. **Clima e superfícies:** temperatura local, atmosfera, água e vapor em movimento, gelo e outras fases materiais, estações, terraformação e visualização dos dados de superfície.
5. **Criação e exploração:** objetos e galáxias procedurais, simulações históricas, ferramentas de interação, câmeras, órbitas, overlays, gráficos e informação dos corpos.
6. **Apresentação e distribuição:** gráficos 3D, som, acessibilidade, localização e suporte a VR serão avaliados como partes da paridade, respeitando plataforma e viabilidade. Nesta fase, compartilhamento ocorre por arquivo.

Esta lista descreve o objetivo completo, não promete que todas as físicas terão a mesma precisão ou entrarão numa única versão. Cada fenômeno deve declarar suas simplificações; parâmetros e unidades devem ser visíveis e editáveis. A implementação define fases, com cada etapa executável e verificável.

## Referência observada

O site oficial descreve gravidade N-body newtoniana, colisões, criação de sistemas, clima, evolução estelar, eventos históricos e materiais. A documentação oficial de superfícies descreve temperatura local, níveis e fluxo de água, vapor e estados como neve e gelo. O roadmap oficial separa recursos em desenvolvimento, como simulação de vida e suporte móvel, do conjunto já lançado. Astro usará essas páginas para mapear capacidades, sem copiar código, marca, interface, conteúdo ou ativos.

- https://www.universesandbox.com/
- https://www.universesandbox.com/faq/
- https://universesandbox.com/blog/2019/11/update-24/
- https://universesandbox.com/blog/2026/03/universe-sandbox-roadmap-2026/
- https://universesandbox.com/blog/category/update/
- https://nextjs.org/docs/app/getting-started
- https://threejs.org/docs/#api/en/renderers/webgpu/WebGPURenderer
- https://github.com/mrdoob/three.js/blob/dev/src/renderers/webgpu/WebGPURenderer.js

## Decisões técnicas

- **Stack web:** Next.js App Router, TypeScript strict e Three.js. Seguir o bootstrap web do toolkit e validar as versões estáveis resolvidas antes de instalar. Usar um limite cliente pequeno para a cena interativa; manter documentação e conteúdo fora do canvas.
- **Renderização:** começar com WebGL 2 para compatibilidade. Manter WebGPU como opção medida para evolução. A documentação do Three.js descreve fallback WebGL 2 no `WebGPURenderer`, mas compute shaders não têm equivalente no backend WebGL 2; não depender de compute WebGPU no caminho funcional inicial.
- **Física astronômica:** tratar simulação orbital como domínio próprio, com precisão numérica, escalas e integração temporal escolhidas para os requisitos. Não delegar gravidade astronômica ao motor de física visual.
- **Concorrência:** avaliar Web Worker para que cálculo N-body não bloqueie a interface; medir antes de introduzir otimização de GPU.
- **Dados e persistência:** começar sem servidor. Salvar/exportar arquivo local versionado, validado na entrada e documentado; esquema exato e compatibilidade futura ficam para o plano.
- **Desktop futuro:** manter a física separada da renderização para facilitar uma possível versão desktop sem comprometer primeiro a entrega web.
- **Licenciamento e dados astronômicos:** verificar licença e proveniência de catálogo, texturas, sons e datasets antes de incorporá-los. Não usar extração de ativos do produto de referência.

## Fora do escopo desta fase

- Construção de spacecraft ou megastructures e simulação de vida, pois aparecem como roadmap futuro de Universe Sandbox e não como requisito confirmado para o primeiro corte de paridade.
- Contas, sincronização em nuvem, comunidade online, marketplace ou conteúdo pago.
- Garantir paridade numérica exata ou precisão científica profissional em todo fenômeno.
- Publicar, fazer push, contratar serviços ou criar custos recorrentes sem decisão específica.

## Critérios de aceitação do produto

- A aplicação web abre uma simulação do Sistema Solar no navegador suportado.
- O usuário pode criar e editar corpos e parâmetros, avançar/pausar o tempo e observar órbitas.
- Alterações de temperatura produzem efeitos simulados observáveis, não apenas uma mudança de rótulo ou cor.
- As leis físicas podem ser alteradas pelo usuário; a simulação informa quando um modelo é simplificado.
- Uma simulação pode ser exportada, importada e retomada sem perder propriedades suportadas pelo arquivo.
- A arquitetura e os documentos permitem a agentes futuros entenderem escopo, comandos, decisões e limites antes de editar.
- Os recursos do escopo maior são rastreados em fases, sem apresentá-los como entregues antes de estarem implementados.

## Perguntas de implementação para o plano

1. Verificação de versões estáveis, peers e compatibilidade entre Next.js, React, TypeScript e Three.js antes da instalação.
2. Estratégia de precisão e escala astronômica, integrador numérico, controle de tempo e limites de desempenho.
3. Fonte e licença dos dados para o Sistema Solar inicial.
4. Formato de arquivo, validação, versionamento e compatibilidade.
5. Marcos verticais que entreguem primeiro uma sandbox útil e ampliem a cobertura sem afirmar paridade ainda inexistente.
6. Desempenho de referência e critério mensurável para considerar alternativa desktop ou cálculo acelerado por GPU.

## Próxima etapa

Próximo: executar o plano web aprovado pelo fluxo do toolkit, configurar documentação e instruções de agentes, verificar stack com fontes oficiais atuais, implementar o primeiro marco e validar comandos reais.
