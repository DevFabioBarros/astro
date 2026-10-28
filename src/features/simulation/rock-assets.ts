import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export type RockSurfaceAssets = {
  bennuGeometry?: THREE.BufferGeometry;
  bennuMaterial?: THREE.MeshStandardMaterial;
  diffuse?: THREE.Texture;
  roughness?: THREE.Texture;
  dispose: () => void;
};

function loadTexture(path: string, color: boolean): Promise<THREE.Texture | undefined> {
  return new Promise((resolve) => new THREE.TextureLoader().load(path, (texture) => {
    texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    resolve(texture);
  }, undefined, () => resolve(undefined)));
}

function normalizeGeometry(source: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry | undefined {
  const geometry = source.clone();
  geometry.applyMatrix4(matrix);
  const positions = geometry.getAttribute("position");
  if (!positions || positions.count === 0) { geometry.dispose(); return undefined; }
  const center = new THREE.Vector3();
  for (let index = 0; index < positions.count; index += 1) center.add(new THREE.Vector3().fromBufferAttribute(positions, index));
  center.multiplyScalar(1 / positions.count);
  let radius = 0;
  for (let index = 0; index < positions.count; index += 1) {
    const point = new THREE.Vector3().fromBufferAttribute(positions, index).sub(center);
    positions.setXYZ(index, point.x, point.y, point.z);
    radius = Math.max(radius, point.length());
  }
  if (!(radius > 0 && Number.isFinite(radius))) { geometry.dispose(); return undefined; }
  for (let index = 0; index < positions.count; index += 1) positions.setXYZ(index, positions.getX(index) / radius, positions.getY(index) / radius, positions.getZ(index) / radius);
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.userData.sharedAsset = true;
  return geometry;
}

function disposeModel(gltf: Awaited<ReturnType<GLTFLoader["loadAsync"]>> | undefined): void {
  if (!gltf) return;
  const textures = new Set<THREE.Texture>();
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      material.dispose();
    }
  });
  textures.forEach((texture) => texture.dispose());
}

export async function loadRockSurfaceAssets(anisotropy = 1): Promise<RockSurfaceAssets | undefined> {
  const modelPromise = new GLTFLoader().loadAsync("/models/bennu.glb").catch(() => undefined);
  const [gltf, diffuse, roughness] = await Promise.all([
    modelPromise,
    loadTexture("/textures/rock-ground-diff-1k.jpg", true),
    loadTexture("/textures/rock-ground-rough-1k.jpg", false),
  ]);
  if (diffuse) diffuse.anisotropy = anisotropy;
  if (roughness) roughness.anisotropy = anisotropy;
  let bennuGeometry: THREE.BufferGeometry | undefined;
  let bennuMaterial: THREE.MeshStandardMaterial | undefined;
  const disposeBennuGeometry = () => bennuGeometry?.dispose();
  const disposeTextures = () => { diffuse?.dispose(); roughness?.dispose(); };
  if (gltf) {
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((object) => {
      if (bennuGeometry || !(object instanceof THREE.Mesh)) return;
      bennuGeometry = normalizeGeometry(object.geometry, object.matrixWorld);
      const source = Array.isArray(object.material) ? object.material[0] : object.material;
      if (source instanceof THREE.MeshStandardMaterial) {
        bennuMaterial = source;
        bennuMaterial.metalness = 0;
        bennuMaterial.roughness = 0.96;
      }
    });
  }
  if (!bennuGeometry && !diffuse && !roughness) {
    disposeModel(gltf);
    return undefined;
  }
  return {
    bennuGeometry, bennuMaterial, diffuse, roughness,
    dispose: () => {
      disposeBennuGeometry(); disposeTextures();
      disposeModel(gltf);
    },
  };
}
