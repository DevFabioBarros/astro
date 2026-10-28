# Astro — revisão da sandbox imersiva

## Solicitação

O usuário rejeitou a experiência estática e os tamanhos artificiais. Solicitou movimento perceptível, proporções físicas, órbitas, Terra com textura melhor, fundo espacial e interface simples em unidades astronômicas. Referências: Universe Sandbox e Sandbox Universe no Yandex Games. Esta revisão amplia a primeira fatia já entregue; não substitui o histórico do plano original.

## Direção adotada

- Cena 3D em tela ampla, Terra enquadrada ao abrir, céu estrelado e Via Láctea discreta. Sol ilumina os planetas; Terra possui mapa diurno, luzes noturnas, nuvens e atmosfera.
- Tempo começa em movimento, com um dia simulado por segundo. Controle oferece uma hora, um dia, uma semana e um mês por segundo. O movimento é resultado da gravidade N-body, integrado por velocity-Verlet com passo adaptativo e orçamento finito.
- Mesma conversão linear para posições e raios no modo de escala real. Marcadores e nomes permitem localizar corpos pequenos. Visão do sistema e foco em um astro são ações explícitas; seleção não aumenta o raio.
- Órbitas previstas são curvas osculantes calculadas a partir do estado atual. Elas não substituem a trajetória N-body e mudam quando o usuário altera o mundo.
- Interface com navegação por planetas, painel compacto e transporte temporal. Raio em km, distâncias em UA, velocidade em km/s, temperatura em °C, água em porcentagem e massa em notação científica. SI permanece apenas no domínio interno e nos arquivos versionados.
- Arquivos locais, edição segura, revisão de mundo e fallback WebGL continuam disponíveis. Movimento reduzido restringe decoração; o usuário pediu movimento da simulação e pode pausá-lo.

## Estilo

Espaço preto `#02040b`, painéis navy `#0a1327`, texto `#eef4ff`, destaque azul `#80bfff` e Sol `#ffcc80`. A cena é a peça principal; tipografia sans, hierarquia clara e poucos contornos. Evitar rótulos técnicos na tela principal.

## Ativos e limites

GLB UV local preservado. Mapas Solar System Scope / INOVE usados com atribuição CC BY 4.0; origem e arquivos em `public/textures/ATTRIBUTION.md`. Dados de massa, raio e estado inicial JPL/NASA preservados. Não há colisões, clima completo, relatividade nem equivalência de recursos com Universe Sandbox. Intervalos extremos devem falhar com mensagem e preservar estado válido.

## Aceite

Ao abrir, a pessoa vê a Terra texturizada em movimento e tempo avançando. Pode visualizar sistema e órbitas, escolher outro astro, pausar e retomar, editar em unidades legíveis e importar/exportar. Tamanhos reais mantêm relações físicas verificáveis. Testes devem provar estabilidade orbital, conversões e recuperação, além de navegação Chrome e revisão visual em desktop/mobile.
