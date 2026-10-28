import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'public', 'models', 'astro-sphere.glb');
const segments = 64;
const rings = 32;
const positions = [];
const normals = [];
const uvs = [];
const indices = [];

for (let y = 0; y <= rings; y += 1) {
  const v = y / rings;
  const theta = v * Math.PI;
  for (let x = 0; x <= segments; x += 1) {
    const u = x / segments;
    const phi = u * Math.PI * 2;
    const nx = Math.sin(theta) * Math.cos(phi);
    const ny = Math.cos(theta);
    const nz = Math.sin(theta) * Math.sin(phi);
    positions.push(nx, ny, nz);
    normals.push(nx, ny, nz);
    uvs.push(u, 1 - v);
  }
}

for (let y = 0; y < rings; y += 1) {
  for (let x = 0; x < segments; x += 1) {
    const a = y * (segments + 1) + x;
    const b = a + segments + 1;
    const c = b + 1;
    const d = a + 1;
    indices.push(a, d, b, d, c, b);
  }
}

const parts = [
  { values: Float32Array.from(positions), componentType: 5126, type: 'VEC3', target: 34962 },
  { values: Float32Array.from(normals), componentType: 5126, type: 'VEC3', target: 34962 },
  { values: Float32Array.from(uvs), componentType: 5126, type: 'VEC2', target: 34962 },
  { values: Uint16Array.from(indices), componentType: 5123, type: 'SCALAR', target: 34963 },
];
const binaryParts = [];
const bufferViews = [];
const accessors = [];
let byteOffset = 0;

for (const [index, part] of parts.entries()) {
  const bytes = Buffer.from(part.values.buffer);
  const padding = (4 - (byteOffset % 4)) % 4;
  if (padding) {
    binaryParts.push(Buffer.alloc(padding));
    byteOffset += padding;
  }
  bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, target: part.target });
  const accessor = {
    bufferView: index,
    componentType: part.componentType,
    count: part.values.length / (part.type === 'VEC3' ? 3 : part.type === 'VEC2' ? 2 : 1),
    type: part.type,
  };
  if (index === 0) {
    accessor.min = [-1, -1, -1];
    accessor.max = [1, 1, 1];
  }
  accessors.push(accessor);
  binaryParts.push(bytes);
  byteOffset += bytes.length;
}

const binary = Buffer.concat(binaryParts);
const gltf = {
  asset: { version: '2.0', generator: 'Astro deterministic UV sphere' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
  materials: [{ name: 'White', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
  buffers: [{ byteLength: binary.length }],
  bufferViews,
  accessors,
};
const json = Buffer.from(JSON.stringify(gltf), 'utf8');
const jsonPadding = (4 - (json.length % 4)) % 4;
const paddedJson = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]);
const binaryPadding = (4 - (binary.length % 4)) % 4;
const paddedBinary = Buffer.concat([binary, Buffer.alloc(binaryPadding)]);
const totalLength = 12 + 8 + paddedJson.length + 8 + paddedBinary.length;
const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(totalLength, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(paddedJson.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(paddedBinary.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);
const glb = Buffer.concat([header, jsonHeader, paddedJson, binHeader, paddedBinary]);

// Validate the generated GLB container and the mesh contract before writing it.
if (glb.toString('ascii', 0, 4) !== 'glTF' || glb.readUInt32LE(4) !== 2 || glb.readUInt32LE(8) !== glb.length) {
  throw new Error('Invalid GLB header');
}
let chunkOffset = 12;
const chunks = [];
while (chunkOffset < glb.length) {
  const length = glb.readUInt32LE(chunkOffset);
  const type = glb.readUInt32LE(chunkOffset + 4);
  chunks.push({ type, data: glb.subarray(chunkOffset + 8, chunkOffset + 8 + length) });
  chunkOffset += 8 + length;
}
if (chunks.length !== 2 || chunks[0].type !== 0x4e4f534a || chunks[1].type !== 0x004e4942 || chunkOffset !== glb.length) {
  throw new Error('Invalid GLB chunks');
}
const checked = JSON.parse(chunks[0].data.toString('utf8'));
const expectedVertices = (segments + 1) * (rings + 1);
const expectedIndices = segments * rings * 6;
if (
  checked.asset?.version !== '2.0' ||
  checked.accessors?.[0]?.count !== expectedVertices ||
  checked.accessors?.[1]?.count !== expectedVertices ||
  checked.accessors?.[2]?.count !== expectedVertices ||
  checked.accessors?.[3]?.count !== expectedIndices ||
  checked.meshes?.[0]?.primitives?.[0]?.attributes?.POSITION !== 0 ||
  checked.meshes?.[0]?.primitives?.[0]?.attributes?.NORMAL !== 1 ||
  checked.meshes?.[0]?.primitives?.[0]?.attributes?.TEXCOORD_0 !== 2 ||
  checked.meshes?.[0]?.primitives?.[0]?.indices !== 3 ||
  checked.buffers?.[0]?.byteLength !== chunks[1].data.length - binaryPadding
) {
  throw new Error('Invalid GLB accessor counts or mesh attributes');
}

await mkdir(dirname(output), { recursive: true });
await writeFile(output, glb);
console.log(`Wrote ${output} (${glb.length} bytes; ${expectedVertices} vertices; ${expectedIndices} indices)`);
