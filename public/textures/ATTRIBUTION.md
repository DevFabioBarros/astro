# Créditos dos mapas celestes

Mapas por **Solar System Scope / INOVE**, disponibilizados sob [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).

Fonte e descrição do conjunto: [Solar System Scope — Solar Textures](https://www.solarsystemscope.com/textures/).

Os arquivos JPEG foram obtidos em 15 de outubro de 2026 e preservados sem edição. Na renderização, Astro ajusta iluminação, materiais, rotação e intensidade do fundo. Nuvens, atmosfera e anéis recebem tratamentos visuais próprios.

| Arquivo local | Arquivo de origem |
|---|---|
| earth-day.jpg | [8k_earth_daymap.jpg](https://www.solarsystemscope.com/textures/download/8k_earth_daymap.jpg) |
| earth-day-2k.jpg | [2k_earth_daymap.jpg](https://www.solarsystemscope.com/textures/download/2k_earth_daymap.jpg) |
| earth-night.jpg | [2k_earth_nightmap.jpg](https://www.solarsystemscope.com/textures/download/2k_earth_nightmap.jpg) |
| earth-clouds.jpg | [2k_earth_clouds.jpg](https://www.solarsystemscope.com/textures/download/2k_earth_clouds.jpg) |
| sun.jpg | [2k_sun.jpg](https://www.solarsystemscope.com/textures/download/2k_sun.jpg) |
| mercury.jpg | [2k_mercury.jpg](https://www.solarsystemscope.com/textures/download/2k_mercury.jpg) |
| venus.jpg | [2k_venus_atmosphere.jpg](https://www.solarsystemscope.com/textures/download/2k_venus_atmosphere.jpg) |
| moon.jpg | [2k_moon.jpg](https://www.solarsystemscope.com/textures/download/2k_moon.jpg) |
| mars.jpg | [2k_mars.jpg](https://www.solarsystemscope.com/textures/download/2k_mars.jpg) |
| jupiter.jpg | [2k_jupiter.jpg](https://www.solarsystemscope.com/textures/download/2k_jupiter.jpg) |
| saturn.jpg | [2k_saturn.jpg](https://www.solarsystemscope.com/textures/download/2k_saturn.jpg) |
| uranus.jpg | [2k_uranus.jpg](https://www.solarsystemscope.com/textures/download/2k_uranus.jpg) |
| neptune.jpg | [2k_neptune.jpg](https://www.solarsystemscope.com/textures/download/2k_neptune.jpg) |
| milky-way.jpg | [8k_stars_milky_way.jpg](https://www.solarsystemscope.com/textures/download/8k_stars_milky_way.jpg) |
| milky-way-2k.jpg | [2k_stars_milky_way.jpg](https://www.solarsystemscope.com/textures/download/2k_stars_milky_way.jpg) |

O autor informa que os mapas combinam imagens e dados de elevação NASA, com cores ajustadas e preenchimento ilustrativo de regiões sem cobertura. São mapas de visualização, sujeitos a essas limitações; não constituem observações em tempo real.

A esfera `../models/astro-sphere.glb` é gerada pelo próprio projeto e não deriva de modelos externos.

## Mapas lunares NASA — Onda 1 em andamento

Crédito: **NASA SVS / Ernie Wright / Noah Petro**, [NASA SVS Moon Kit](https://svs.gsfc.nasa.gov/4720/). Fontes diretas: [LROC color 2K](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_2k.jpg), [LROC color 16-bit sRGB 4K TIFF](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_16bit_srgb_4k.tif) e [LOLA `ldem_4.tif`](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_4.tif). Saídas locais foram decodificadas para 24 bpp RGB por System.Drawing; os JPEG derivados têm perdas.

| Arquivo local | Tamanho e dimensões | Origem e limite |
|---|---:|---|
| `moon-lroc-color-2k.jpg` | 457.942 bytes; 2048×1024 | `lroc_color_2k.jpg`; mapa de cor LROC. |
| `moon-lroc-color-4k.jpg` | 2.045.247 bytes; 4096×2048 | Derivado de `lroc_color_16bit_srgb_4k.tif` (61.891.324 bytes); cor otimizada para estética. |
| `moon-lola-height-2k.jpg` | 497.496 bytes; 2048×1024 | Derivado de `ldem_4.tif` (4.153.352 bytes), escala relativa de 1.737,4 km. JPEG grayscale com perdas; relevo apenas ilustrativo, não altimetria científica. |

O uso segue as [diretrizes de mídia NASA](https://www.nasa.gov/nasa-brand-center/images-and-media/); NASA não endossa Astro. A tentativa de obter um mapa normal terrestre da Solar System Scope retornou HTTP 403; nenhum novo ativo terrestre foi incorporado. Os mapas existentes permanecem intactos. Os mapas lunares LROC de cor e LOLA de relevo estão integrados ao material da Lua; o relevo usa bump mapping, sem alterar a geometria ou a física.

## Asteroide Bennu e superfície rochosa

O modelo Bennu `../models/bennu.glb` é da **NASA Visualization Technology Applications and Development (VTAD)**, obtido em [NASA Science — Bennu 3D Model](https://science.nasa.gov/resource/bennu-3d-model/). Crédito NASA; uso sujeito às [diretrizes de mídia NASA](https://www.nasa.gov/nasa-brand-center/images-and-media/). NASA não endossa Astro.

Os mapas `rock-ground-diff-1k.jpg` e `rock-ground-rough-1k.jpg` são **Rock Ground**, de [Poly Haven](https://polyhaven.com/a/rock_ground), licenciados sob [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
