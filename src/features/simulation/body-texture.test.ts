import { expect, it } from "vitest";
import * as THREE from "three";
import { createSurfaceTexture } from "./body-texture";

it("creates deterministic, varied equirectangular textures for each body", () => {
  const earth = createSurfaceTexture("earth", "planet");
  const mars = createSurfaceTexture("mars", "planet");
  const jupiter = createSurfaceTexture("jupiter", "planet");
  const sun = createSurfaceTexture("sun", "star");

  expect(earth.image).toMatchObject({ width: 256, height: 128 });
  expect(earth.image.data).toBeInstanceOf(Uint8Array);
  expect(earth.colorSpace).toBe(THREE.SRGBColorSpace);
  expect(earth.wrapS).toBe(THREE.RepeatWrapping);
  expect(earth.version).toBeGreaterThan(0);
  expect(createSurfaceTexture("earth", "planet").image.data).toEqual(earth.image.data);
  expect(earth.image.data).not.toEqual(mars.image.data);
  expect(jupiter.image.data).not.toEqual(earth.image.data);
  expect(sun.image.data).not.toEqual(earth.image.data);
});
