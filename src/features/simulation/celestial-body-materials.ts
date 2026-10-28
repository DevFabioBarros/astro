import * as THREE from "three";
import type { AtmosphereMetrics } from "@/simulation/atmosphere-model";
import type { CelestialBody } from "@/simulation/types";
import { getBodyType } from "@/simulation/body-catalog";
import { stellarColorTemperature } from "./body-appearance";
import type { SceneEclipseLight } from "./scene-lighting";

const MAX_SCENE_ECLIPSE_LIGHTS = 4;
const ATMOSPHERE_RENDER_SHELL_THICKNESS_SCALE = 4;

export function installEclipseLighting(material: THREE.MeshStandardMaterial): (lights: readonly SceneEclipseLight[]) => void {
  const lightCountUniform: THREE.IUniform<number> = { value: 0 };
  const distanceFactors = new Float32Array(MAX_SCENE_ECLIPSE_LIGHTS);
  const sourceRadii = new Float32Array(MAX_SCENE_ECLIPSE_LIGHTS);
  const blockerRadii = new Float32Array(MAX_SCENE_ECLIPSE_LIGHTS);
  const sourcePositions = Array.from({ length: MAX_SCENE_ECLIPSE_LIGHTS }, () => new THREE.Vector3());
  const blockerPositions = Array.from({ length: MAX_SCENE_ECLIPSE_LIGHTS }, () => new THREE.Vector3());
  const previousCompile = material.onBeforeCompile;
  const previousProgramKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.astroEclipseLightCount = lightCountUniform;
    shader.uniforms.astroEclipseDistanceFactor = { value: distanceFactors };
    shader.uniforms.astroEclipseSourcePosition = { value: sourcePositions };
    shader.uniforms.astroEclipseSourceRadius = { value: sourceRadii };
    shader.uniforms.astroEclipseBlockerPosition = { value: blockerPositions };
    shader.uniforms.astroEclipseBlockerRadius = { value: blockerRadii };
    const common = `#include <common>
      uniform int astroEclipseLightCount;
      uniform float astroEclipseDistanceFactor[4];
      uniform vec3 astroEclipseSourcePosition[4];
      uniform float astroEclipseSourceRadius[4];
      uniform vec3 astroEclipseBlockerPosition[4];
      uniform float astroEclipseBlockerRadius[4];
      varying vec3 vAstroWorldPosition;
      float astroEclipseShadowMask(int index, vec3 fragmentPosition) {
        vec3 toSource = astroEclipseSourcePosition[index] - fragmentPosition;
        vec3 toBlocker = astroEclipseBlockerPosition[index] - fragmentPosition;
        float sourceDistance = length(toSource);
        float blockerDistance = length(toBlocker);
        if (astroEclipseBlockerRadius[index] <= 0.0 || astroEclipseSourceRadius[index] <= 0.0
          || blockerDistance <= 1e-6 || sourceDistance <= blockerDistance) return 1.0;
        float sourceAngularRadius = asin(clamp(astroEclipseSourceRadius[index] / max(sourceDistance, 1e-6), 0.0, 1.0));
        float blockerAngularRadius = asin(clamp(astroEclipseBlockerRadius[index] / max(blockerDistance, 1e-6), 0.0, 1.0));
        float separation = acos(clamp(dot(toSource, toBlocker) / max(sourceDistance * blockerDistance, 1e-6), -1.0, 1.0));
        float coverage = min(1.0, pow(blockerAngularRadius / max(sourceAngularRadius, 1e-6), 2.0));
         float overlap = 1.0 - smoothstep(abs(blockerAngularRadius - sourceAngularRadius), blockerAngularRadius + sourceAngularRadius, separation);
        return 1.0 - coverage * overlap;
      }`;
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vAstroWorldPosition;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvAstroWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", common);
    const lightsChunk = "#include <lights_fragment_begin>";
    if (shader.fragmentShader.includes(lightsChunk)) {
      shader.fragmentShader = shader.fragmentShader.replace(lightsChunk, THREE.ShaderChunk.lights_fragment_begin);
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      "getPointLightInfo( pointLight, geometryPosition, directLight );",
      `getPointLightInfo( pointLight, geometryPosition, directLight );
        if ( UNROLLED_LOOP_INDEX < astroEclipseLightCount ) {
          directLight.color *= astroEclipseDistanceFactor[ UNROLLED_LOOP_INDEX ] * astroEclipseShadowMask( UNROLLED_LOOP_INDEX, vAstroWorldPosition );
        }`,
    );
  };
  material.customProgramCacheKey = () => `${previousProgramKey}-astro-spatial-eclipse-v4`;
  const setPosition = (target: THREE.Vector3, position: readonly [number, number, number]) => {
    if (position.every(Number.isFinite)) target.set(position[0], position[1], position[2]);
    else target.set(0, 0, 0);
  };
  return (lights) => {
    lightCountUniform.value = Math.min(MAX_SCENE_ECLIPSE_LIGHTS, lights.length);
    for (let index = 0; index < MAX_SCENE_ECLIPSE_LIGHTS; index += 1) {
      const light = lights[index];
      distanceFactors[index] = light && Number.isFinite(light.distanceFactor) ? THREE.MathUtils.clamp(light.distanceFactor, 0, 4) : 1;
      sourceRadii[index] = light && Number.isFinite(light.sourceRadius) ? Math.max(0, light.sourceRadius) : 0;
      blockerRadii[index] = light && Number.isFinite(light.blockerRadius) ? Math.max(0, light.blockerRadius) : 0;
      setPosition(sourcePositions[index]!, light?.sourcePosition ?? [0, 0, 0]);
      setPosition(blockerPositions[index]!, light?.blockerPosition ?? [0, 0, 0]);
    }
  };
}

export function blackHoleDiskMaterial(seed: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { diskTime: { value: 0 }, diskSeed: { value: seed } }, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec2 vUv; varying vec3 vPosition; void main(){ vUv=uv; vPosition=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform float diskTime; uniform float diskSeed; varying vec2 vUv; varying vec3 vPosition;
      void main(){ float r=length(vPosition.xy); float a=atan(vPosition.y,vPosition.x); float flow=sin(a*2.2-r*0.16-diskTime*0.55+diskSeed);
      float turbulence=sin(a*3.4+r*0.27-diskTime*0.42)*sin(a*1.7-r*0.13+diskTime*0.3);
      float inner=1.0-smoothstep(8.1,10.5,r); float outer=1.0-smoothstep(29.0,32.0,r);
      float asymmetry=0.68+0.32*cos(a-0.6); float bands=0.88+0.10*flow+0.06*turbulence; float alpha=(1.0-inner)*outer*bands*asymmetry;
      vec3 hot=mix(vec3(1.0,0.16,0.025),vec3(1.0,0.86,0.54),smoothstep(11.0,18.0,r));
      hot=mix(hot,vec3(0.8,0.08,0.018),smoothstep(22.0,32.0,r));
      gl_FragColor=vec4(hot*(0.94+0.12*flow)*alpha,alpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  });
}

export function proceduralStellarMaterial(body: CelestialBody, visualId: string): THREE.ShaderMaterial {
  const color = stellarColorTemperature(body.surfaceTemperatureK);
  const compact = getBodyType(body) === "white-dwarf" || getBodyType(body) === "neutron-star";
  const surfaceActivity = compact ? 0 : visualId === "sun" ? 0.34 : 0.12;
  return new THREE.ShaderMaterial({
    uniforms: { baseColor: { value: new THREE.Color().setRGB(color.r, color.g, color.b, THREE.SRGBColorSpace) }, surfaceTime: { value: 0 }, surfaceActivity: { value: surfaceActivity }, surfaceBrightness: { value: 1 }, compactRemnant: { value: compact ? 1 : 0 }, compactNeutron: { value: getBodyType(body) === "neutron-star" ? 1 : 0 }, temperatureMapBlend: { value: 0 }, surfaceMap: { value: null }, hasSurfaceMap: { value: 0 } },
    vertexShader: `varying vec3 vNormalView; varying vec3 vViewDirection; varying vec3 vSurfacePosition; varying vec2 vSurfaceUv;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vNormalView = normalize(normalMatrix * normal);
        vViewDirection = normalize(-viewPosition.xyz);
        vSurfacePosition = position;
        vSurfaceUv = uv;
        gl_Position = projectionMatrix * viewPosition;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `uniform vec3 baseColor; uniform float surfaceTime; uniform float surfaceActivity; uniform float surfaceBrightness; uniform float compactRemnant; uniform float compactNeutron; uniform float temperatureMapBlend; uniform sampler2D surfaceMap; uniform float hasSurfaceMap;
      varying vec3 vNormalView; varying vec3 vViewDirection; varying vec3 vSurfacePosition; varying vec2 vSurfaceUv;
      #include <logdepthbuf_pars_fragment>
      float whiteDwarfHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float whiteDwarfNoise(vec3 p) {
        vec3 cell = floor(p); vec3 local = fract(p); local = local * local * (3.0 - 2.0 * local);
        float c000 = whiteDwarfHash(cell); float c100 = whiteDwarfHash(cell + vec3(1.0, 0.0, 0.0));
        float c010 = whiteDwarfHash(cell + vec3(0.0, 1.0, 0.0)); float c110 = whiteDwarfHash(cell + vec3(1.0, 1.0, 0.0));
        float c001 = whiteDwarfHash(cell + vec3(0.0, 0.0, 1.0)); float c101 = whiteDwarfHash(cell + vec3(1.0, 0.0, 1.0));
        float c011 = whiteDwarfHash(cell + vec3(0.0, 1.0, 1.0)); float c111 = whiteDwarfHash(cell + vec3(1.0, 1.0, 1.0));
        return mix(mix(mix(c000, c100, local.x), mix(c010, c110, local.x), local.y), mix(mix(c001, c101, local.x), mix(c011, c111, local.x), local.y), local.z);
      }
      void main() {
        #include <logdepthbuf_fragment>
        float mu = max(dot(normalize(vNormalView), normalize(vViewDirection)), 0.0);
        float limbDarkening = 0.68 + 0.32 * mu;
        float granulation = 0.55 * sin(vSurfacePosition.x * 47.0 + vSurfacePosition.y * 29.0 + surfaceTime)
          * sin(vSurfacePosition.z * 41.0 - vSurfacePosition.x * 31.0 - surfaceTime * 0.73)
          + 0.35 * sin(vSurfacePosition.y * 83.0 + vSurfacePosition.z * 59.0 + surfaceTime * 0.41);
        float photosphereVariation = 1.0 + surfaceActivity * granulation;
        vec3 mapColor = mix(vec3(1.0), texture2D(surfaceMap, vSurfaceUv).rgb, hasSurfaceMap);
        float mapLuminance = dot(mapColor, vec3(0.2126, 0.7152, 0.0722));
        mapColor = mix(mapColor, vec3(mapLuminance), temperatureMapBlend);
        float whiteDwarfCore = smoothstep(0.14, 0.92, mu);
        float whiteDwarfLimb = pow(1.0 - mu, 0.78);
        float whiteDwarfGranulation = 0.92 + 0.62 * (0.78 * whiteDwarfNoise(vSurfacePosition * 3.5) + 0.22 * whiteDwarfNoise(vSurfacePosition * 8.0) - 0.5);
        vec3 whiteDwarfColor = (mix(baseColor * 0.12, mix(baseColor * 0.82, vec3(1.0), 0.36), whiteDwarfCore) + vec3(0.2, 0.34, 0.62) * whiteDwarfLimb * 0.48) * limbDarkening * whiteDwarfGranulation;
        float neutronCore = smoothstep(0.38, 0.97, mu);
        float neutronLimb = pow(1.0 - mu, 0.38);
        vec3 neutronColor = mix(baseColor * 0.1, vec3(1.0), neutronCore) + vec3(0.08, 0.34, 1.0) * neutronLimb * 1.08;
        vec3 compactColor = mix(whiteDwarfColor, neutronColor * photosphereVariation, compactNeutron);
        vec3 ordinaryColor = baseColor * mapColor * limbDarkening * photosphereVariation;
        gl_FragColor = vec4(mix(ordinaryColor, compactColor, compactRemnant) * surfaceBrightness, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

export function solarCoronaMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { coronaColor: { value: new THREE.Color(0xff8a38) }, coronaIntensity: { value: 1 }, surfaceTime: { value: 0 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vNormalView; varying vec3 vViewDirection; varying vec3 vSurfacePosition;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vNormalView = normalize(normalMatrix * normal);
        vViewDirection = normalize(-viewPosition.xyz);
        vSurfacePosition = position;
        gl_Position = projectionMatrix * viewPosition;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `uniform vec3 coronaColor; uniform float coronaIntensity; uniform float surfaceTime;
      varying vec3 vNormalView; varying vec3 vViewDirection; varying vec3 vSurfacePosition;
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        float mu = abs(dot(normalize(vNormalView), normalize(vViewDirection)));
        float radial = max(0.0, 1.0 - mu);
        float rim = radial * radial * (1.0 - 0.35 * radial);
        float angle = atan(vSurfacePosition.y, vSurfacePosition.x);
        float streamers = 0.78 + 0.22 * pow(0.5 + 0.5 * sin(angle * 11.0 + sin(angle * 3.0 + surfaceTime * 0.18)), 5.0);
        float prominences = pow(max(0.0, cos(angle * 3.0 + 0.7 + surfaceTime * 0.12)), 16.0) * pow(radial, 0.8);
        float glow = rim * streamers * 0.22 + prominences * 0.24;
        gl_FragColor = vec4(coronaColor, glow * coronaIntensity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

export function saturnRingMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: 0xe8d4b1, emissive: 0x302014, emissiveIntensity: 0.06, transparent: true, opacity: 0.82, side: THREE.DoubleSide, roughness: 0.96, metalness: 0, depthWrite: false });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vRingPosition; varying vec3 vRingPointWorld; varying vec3 vRingCenterWorld; varying float vRingPlanetRadius;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vRingPosition = position;
        vRingPointWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        vRingCenterWorld = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vRingPlanetRadius = length((modelMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);`);
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vRingPosition; varying vec3 vRingPointWorld; varying vec3 vRingCenterWorld; varying float vRingPlanetRadius;")
      .replace("#include <lights_fragment_begin>", `float astroRingPlanetShadow = 1.0;
        ${THREE.ShaderChunk.lights_fragment_begin.replace(
        "getPointLightInfo( pointLight, geometryPosition, directLight );",
        `getPointLightInfo( pointLight, geometryPosition, directLight );
          if ( UNROLLED_LOOP_INDEX < astroEclipseLightCount ) {
            vec3 ringOffsetFromPlanet = vRingPointWorld - vRingCenterWorld;
            vec3 ringToLight = normalize(astroEclipseSourcePosition[ UNROLLED_LOOP_INDEX ] - vRingPointWorld);
            float ringShadowAlong = dot(ringOffsetFromPlanet, ringToLight);
            float ringShadowDistance = sqrt(max(0.0, dot(ringOffsetFromPlanet, ringOffsetFromPlanet) - ringShadowAlong * ringShadowAlong));
            float planetShadow = 1.0 - (1.0 - smoothstep(0.92, 1.12, ringShadowDistance / max(vRingPlanetRadius, 1e-6))) * step(ringShadowAlong, -1e-6);
            astroRingPlanetShadow = min(astroRingPlanetShadow, planetShadow);
            directLight.color *= planetShadow;
          }`,
      )}`)
      .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>
        reflectedLight.indirectDiffuse *= mix(0.04, 1.0, astroRingPlanetShadow);`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float ringRadius = length(vRingPosition.xy);
        float innerBand = smoothstep(1.34, 1.42, ringRadius) * (1.0 - smoothstep(1.78, 1.86, ringRadius));
        float outerBand = smoothstep(2.0, 2.05, ringRadius) * (1.0 - smoothstep(2.17, 2.24, ringRadius));
        float broadTexture = 0.12 * sin(ringRadius * 24.0 + sin(ringRadius * 8.0));
        float fineTexture = 0.004 * sin(ringRadius * 171.0 + sin(ringRadius * 49.0)) + 0.002 * sin(ringRadius * 293.0);
        float division = 1.0 - 0.96 * (1.0 - smoothstep(0.012, 0.032, abs(ringRadius - 1.95)));
        float edgeFade = smoothstep(1.24, 1.31, ringRadius) * (1.0 - smoothstep(2.25, 2.32, ringRadius));
        vec3 warmBeige = vec3(1.08, 0.91, 0.69);
        vec3 mutedTaupe = vec3(0.70, 0.58, 0.45);
        diffuseColor.rgb *= mix(mutedTaupe, warmBeige, innerBand) * (0.96 - 0.2 * outerBand + broadTexture + fineTexture);
        diffuseColor.a *= edgeFade * 0.9 * division;`);
  };
  material.customProgramCacheKey = () => "astro-saturn-ring-bands-shadow-v12";
  return material;
}

export function atmosphereMaterial(opacity = 0): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { opacity: { value: THREE.MathUtils.clamp(opacity, 0, 1) }, shellRatio: { value: 0 } },
    vertexShader: `varying vec3 vNormal; varying vec3 vView;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() { vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); vNormal = normalize(normalMatrix * normal); vView = normalize(-mvPosition.xyz); gl_Position = projectionMatrix * mvPosition;
      #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `varying vec3 vNormal; varying vec3 vView; uniform float opacity;
      #include <logdepthbuf_pars_fragment>
      void main() {
      #include <logdepthbuf_fragment>
      float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 3.5);
      float alpha = opacity * mix(0.2, 1.0, rim);
      gl_FragColor = vec4(0.15, 0.46, 1.0, alpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      }`,
  });
}

export function updateAtmosphereMaterial(material: THREE.ShaderMaterial, metrics: AtmosphereMetrics): number {
  const shellRatio = THREE.MathUtils.clamp(metrics.scaleHeightToRadiusRatio * ATMOSPHERE_RENDER_SHELL_THICKNESS_SCALE, 0, 0.05);
  material.uniforms.opacity.value = THREE.MathUtils.clamp(metrics.visualOpacityFraction, 0, 1);
  material.uniforms.shellRatio.value = shellRatio;
  return 1 + shellRatio;
}

export function glowTexture(falloff = 3): THREE.DataTexture {
  const size = 128, bytes = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const distance = Math.hypot((x - 63.5) / 63.5, (y - 63.5) / 63.5);
    const offset = (y * size + x) * 4;
    const alpha = Math.round(Math.max(0, 1 - distance) ** falloff * 180);
    bytes.set([255, 255, 255, alpha], offset);
  }
  const texture = new THREE.DataTexture(bytes, size, size);
  texture.needsUpdate = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
