import * as THREE from "three";
import type { CelestialBody } from "@/simulation/types";

const WIDTH = 256;
const HEIGHT = 128;
const TAU = Math.PI * 2;

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0) / 4294967295 * TAU;
}

function surfaceColor(id: string, kind: CelestialBody["kind"], longitude: number, latitude: number): [number, number, number] {
  const phase = hash(id);
  const turbulence = Math.sin(longitude * 3 + phase + Math.sin(latitude * 8) * 0.7)
    + Math.sin(longitude * 7 - latitude * 5 + phase * 2) * 0.42
    + Math.cos(longitude * 13 + latitude * 11 - phase) * 0.18;

  if (kind === "star") {
    const granulation = (Math.sin(longitude * 48 + Math.sin(latitude * 34 + phase)) + Math.sin(latitude * 72 - phase)) * 0.5;
    const heat = Math.max(0, Math.min(1, 0.55 + turbulence * 0.16 + granulation * 0.12));
    return [255, 112 + heat * 105, 35 + heat * 40];
  }

  if (id === "earth") {
    const continent = Math.sin(longitude * 2.1 + phase) + Math.cos(longitude * 3.7 + latitude * 5)
      + Math.sin(latitude * 8 - longitude * 1.4) + turbulence * 0.3;
    if (Math.abs(latitude) > 1.28) return [202, 222, 220];
    return continent > 0.34
      ? [82 + turbulence * 18, 119 + turbulence * 22, 67 + turbulence * 11]
      : [23 + turbulence * 9, 93 + turbulence * 19, 155 + turbulence * 24];
  }

  if (id === "jupiter" || id === "saturn") {
    const band = Math.sin(latitude * 30 + Math.sin(longitude * 4 + phase) * 1.4 + phase);
    const storm = Math.exp(-((longitude - phase % TAU) ** 2 * 7 + (latitude + 0.12) ** 2 * 36));
    const light = band > 0 ? 1 : 0.66;
    const base = id === "jupiter" ? [194, 137, 91] : [209, 187, 133];
    return [base[0]! * light + storm * 48, base[1]! * light + storm * 19, base[2]! * light + storm * 5];
  }

  if (id === "uranus" || id === "neptune") {
    const bands = Math.sin(latitude * 19 + Math.sin(longitude * 3 + phase) * 0.45) * 0.5 + 0.5;
    return id === "uranus"
      ? [42 + bands * 35, 142 + bands * 45, 166 + bands * 47]
      : [29 + bands * 30, 67 + bands * 45, 151 + bands * 66];
  }

  const cratered = id === "moon" || id === "mercury";
  const relief = turbulence + (cratered ? Math.sin(longitude * 22 + phase) * Math.cos(latitude * 31) * 0.45 : 0);
  if (id === "venus") return [196 + relief * 22, 137 + relief * 18, 74 + relief * 12];
  if (id === "mars") return [163 + relief * 25, 67 + relief * 18, 44 + relief * 14];
  if (cratered) return [126 + relief * 42, 126 + relief * 40, 119 + relief * 38];
  return [116 + relief * 28, 139 + relief * 30, 145 + relief * 31];
}

export function createSurfaceTexture(bodyId: string, kind: CelestialBody["kind"]): THREE.DataTexture {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    const latitude = (y / (HEIGHT - 1) - 0.5) * Math.PI;
    for (let x = 0; x < WIDTH; x += 1) {
      const longitude = x / WIDTH * TAU;
      const offset = (y * WIDTH + x) * 4;
      const [red, green, blue] = surfaceColor(bodyId, kind, longitude, latitude);
      data[offset] = Math.max(0, Math.min(255, red));
      data[offset + 1] = Math.max(0, Math.min(255, green));
      data[offset + 2] = Math.max(0, Math.min(255, blue));
      data[offset + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, WIDTH, HEIGHT, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
