import * as THREE from "three";

const TAIL_LENGTH_RADII = 14;
export const COMET_TAIL_ENVELOPE_RADII = 15.1;

export function cometFocusMetrics(aspect: number): { tailScale: number; envelopeRadii: number } {
  return aspect < 0.8 ? { tailScale: 0.14, envelopeRadii: 3.2 } : { tailScale: 0.24, envelopeRadii: 3.8 };
}

export type CometTailVisual = {
  mesh: THREE.Mesh;
  update: (awayFromStar: THREE.Vector3 | null, relativeVelocity: THREE.Vector3, timeSeconds: number, targetScale: number, animate: boolean) => void;
};

function createTailGeometry(): THREE.BufferGeometry {
  const lengthSegments = 28, widthSegments = 10, positions: number[] = [], uvs: number[] = [], layers: number[] = [], indices: number[] = [];
  const verticesPerLayer = (lengthSegments + 1) * (widthSegments + 1);
  for (let layer = 0; layer < 2; layer += 1) {
    const angle = layer * Math.PI / 2, widthScale = layer === 0 ? 1 : 0.72;
    for (let row = 0; row <= lengthSegments; row += 1) {
      const progress = row / lengthSegments;
      const centerX = -(layer === 0 ? 0.015 : 0.1) * TAIL_LENGTH_RADII * progress * progress;
      const halfWidth = widthScale * 1.15 * (0.08 + 0.92 * Math.pow(progress, 0.76));
      for (let column = 0; column <= widthSegments; column += 1) {
        const across = column / widthSegments;
        const lateral = centerX + (across * 2 - 1) * halfWidth;
        positions.push(Math.cos(angle) * lateral, 0.98 + progress * TAIL_LENGTH_RADII, -Math.sin(angle) * lateral);
        uvs.push(across, progress);
        layers.push(layer);
        if (row < lengthSegments && column < widthSegments) {
          const vertex = layer * verticesPerLayer + row * (widthSegments + 1) + column, nextRow = vertex + widthSegments + 1;
          indices.push(vertex, nextRow, vertex + 1, vertex + 1, nextRow, nextRow + 1);
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("tailLayer", new THREE.Float32BufferAttribute(layers, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function createTailMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { tailTime: { value: 0 } },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: `attribute float tailLayer; varying vec2 vTailUv; varying float vTailLayer;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vTailUv = uv;
        vTailLayer = tailLayer;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `uniform float tailTime; varying vec2 vTailUv; varying float vTailLayer;
      #include <logdepthbuf_pars_fragment>
      void main() {
        float across = abs(vTailUv.x * 2.0 - 1.0);
        float edgeFade = 1.0 - smoothstep(0.28, 1.0, across);
        float rootFade = smoothstep(0.0, 0.08, vTailUv.y);
        float tipFade = 1.0 - smoothstep(0.72, 1.0, vTailUv.y);
        float flow = 0.84 + 0.16 * sin(vTailUv.y * 28.0 - tailTime * 0.32 + across * 2.5);
        float alpha = edgeFade * rootFade * tipFade * flow * mix(0.68, 0.44, vTailLayer);
        vec3 ionColor = vec3(0.06, 0.28, 1.0);
        vec3 dustColor = vec3(1.0, 0.42, 0.12);
        vec3 color = vTailLayer < 0.5 ? mix(ionColor, dustColor, smoothstep(0.48, 0.98, across) * 0.35) : dustColor;
        gl_FragColor = vec4(color, alpha);
        #include <logdepthbuf_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

export function createCometTailVisual(): CometTailVisual {
  const material = createTailMaterial();
  const mesh = new THREE.Mesh(createTailGeometry(), material);
  const forward = new THREE.Vector3(), normal = new THREE.Vector3(), side = new THREE.Vector3(), depth = new THREE.Vector3();
  const orientation = new THREE.Matrix4(), fallbackAxis = new THREE.Vector3(0, 0, 1), fallbackX = new THREE.Vector3(1, 0, 0);
  mesh.name = "comet-tail-illustrative";
  mesh.userData.visualOnly = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.visible = false;
  return {
    mesh,
    update: (awayFromStar, relativeVelocity, timeSeconds, targetScale, animate) => {
      if (!awayFromStar || awayFromStar.lengthSq() < 1e-20) {
        mesh.visible = false;
        return;
      }
      forward.copy(awayFromStar).normalize();
      normal.crossVectors(forward, relativeVelocity);
      if (normal.lengthSq() > 1e-20) {
        normal.normalize();
        side.crossVectors(forward, normal).normalize();
      } else {
        side.copy(fallbackAxis).addScaledVector(forward, -fallbackAxis.dot(forward));
        if (side.lengthSq() < 1e-12) side.copy(fallbackX).addScaledVector(forward, -fallbackX.dot(forward));
        side.normalize();
      }
      depth.crossVectors(side, forward).normalize();
      orientation.makeBasis(side, forward, depth);
      mesh.quaternion.setFromRotationMatrix(orientation);
      mesh.scale.setScalar(animate ? THREE.MathUtils.lerp(mesh.scale.x, targetScale, 0.12) : targetScale);
      material.uniforms.tailTime.value = Number.isFinite(timeSeconds) ? THREE.MathUtils.euclideanModulo(timeSeconds, 4096) : 0;
      mesh.visible = true;
    },
  };
}
