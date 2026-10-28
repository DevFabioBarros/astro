import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { updateSurfaceMaterialColor } from "./surface-material";

describe("updateSurfaceMaterialColor", () => {
  it("makes ice rougher than the default surface", () => {
    const material = new THREE.MeshStandardMaterial({ color: 0x65b8a5, roughness: 0.82, metalness: 0.02 });

    updateSurfaceMaterialColor(material, 0x65b8a5, 250, 1);

    expect(material.roughness).toBeCloseTo(0.96);
    expect(material.color.getHex()).not.toBe(0x65b8a5);
  });

  it("makes liquid smoother while keeping its base opacity", () => {
    const material = new THREE.MeshStandardMaterial({ color: 0x65b8a5, roughness: 0.82, metalness: 0.02 });

    updateSurfaceMaterialColor(material, 0x65b8a5, 300, 1);

    expect(material.roughness).toBeCloseTo(0.18);
    expect(material.metalness).toBeCloseTo(0.08);
    expect(material.opacity).toBe(1);
    expect(material.transparent).toBe(false);
  });

  it("makes vapor translucent in proportion to water fraction", () => {
    const material = new THREE.MeshStandardMaterial({ color: 0x65b8a5, roughness: 0.82, metalness: 0.02 });

    updateSurfaceMaterialColor(material, 0x65b8a5, 400, 0.5);

    expect(material.opacity).toBe(0.675);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
  });

  it("keeps modeled vapor in the cloud layer without fading the dry surface", () => {
    const material = new THREE.MeshStandardMaterial({ color: 0x65b8a5, roughness: 0.82, metalness: 0.02 });

    updateSurfaceMaterialColor(material, 0x65b8a5, 400, 0, { phase: "vapor", vaporFraction: 0.6 });

    expect(material.color.getHex()).toBe(0x65b8a5);
    expect(material.opacity).toBe(1);
    expect(material.transparent).toBe(false);
    expect(material.depthWrite).toBe(true);
  });

  it("restores default PBR properties when water is absent", () => {
    const material = new THREE.MeshStandardMaterial({ color: 0x65b8a5, roughness: 0.82, metalness: 0.02 });
    updateSurfaceMaterialColor(material, 0x65b8a5, 400, 1);

    updateSurfaceMaterialColor(material, 0x65b8a5, 400, 0);

    expect(material.color.getHex()).toBe(0x65b8a5);
    expect(material.roughness).toBe(0.82);
    expect(material.metalness).toBe(0.02);
    expect(material.opacity).toBe(1);
    expect(material.transparent).toBe(false);
    expect(material.depthWrite).toBe(true);
  });

  it("leaves the Sun's unlit material properties unchanged", () => {
    const material = new THREE.MeshBasicMaterial({ color: 0xe7ac64 });
    const initial = { color: material.color.getHex(), opacity: material.opacity, transparent: material.transparent };

    updateSurfaceMaterialColor(material, 0xe7ac64, 400, 0);

    expect({ color: material.color.getHex(), opacity: material.opacity, transparent: material.transparent }).toEqual(initial);
  });
});
