import * as THREE from "three";
import { DEFAULT_ENVIRONMENT_SEED_V1, isEnvironmentSeed } from "@/simulation/world-seed";

const STARFIELD_RADIUS = 260_000;
const STAR_COUNT = 4200;
export const STARFIELD_ALGORITHM_ID = "seeded-starfield-v1";

export function createStarfieldData(seed: number): { positions: Float32Array; colors: Float32Array } {
  if (!isEnvironmentSeed(seed)) throw new RangeError("Environment seed must be an unsigned 32-bit integer.");
  let state = seed;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const positions = new Float32Array(STAR_COUNT * 3), colors = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i += 1) {
    const z = random() * 2 - 1, angle = random() * Math.PI * 2;
    const spread = Math.sqrt(1 - z * z) * STARFIELD_RADIUS;
    positions[i * 3] = Math.cos(angle) * spread;
    positions[i * 3 + 1] = Math.sin(angle) * spread;
    positions[i * 3 + 2] = z * STARFIELD_RADIUS;
    const color = new THREE.Color(random() < 0.5 ? 0xa6c9ff : 0xffd2a0);
    color.multiplyScalar(0.35 + random() * 0.8);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  return { positions, colors };
}

export function createCelestialEnvironment(scene: THREE.Scene, highResolution = true, seed = DEFAULT_ENVIRONMENT_SEED_V1): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  const { positions, colors } = createStarfieldData(seed);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({ size: 1.15, sizeAttenuation: false, transparent: true, opacity: 0.88, vertexColors: true, depthWrite: false });
  const stars = new THREE.Points(geometry, material);
  stars.frustumCulled = false;
  group.add(stars);

  scene.add(group);
  scene.background = new THREE.Color(0x020309);
  let active = true, background: THREE.Texture | undefined;
  new THREE.TextureLoader().load(highResolution ? "/textures/milky-way.jpg" : "/textures/milky-way-2k.jpg", (texture) => {
    if (!active) { texture.dispose(); return; }
    background = texture;
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    scene.background = texture;
    scene.backgroundIntensity = 4;
    scene.backgroundRotation.set(0, 0.45, 0.02);
  }, undefined, () => { /* The local star field remains visible without the sky map. */ });
  return { group, dispose: () => {
    active = false; background?.dispose(); geometry.dispose(); material.dispose();
  } };
}
