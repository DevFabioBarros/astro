import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { orbitalPlacementDraftFromDrag, placementLaunchVelocity, placementPointOnDepth } from "./scene-placement";

describe("placementPointOnDepth", () => {
  it("moves the ghost along the camera-facing plane normal without changing the base point", () => {
    const point = new THREE.Vector3(4, 5, 6);

    expect(placementPointOnDepth(point, new THREE.Vector3(0, 0, 4), 2).toArray()).toEqual([4, 5, 8]);
    expect(point.toArray()).toEqual([4, 5, 6]);
    expect(placementPointOnDepth(point, new THREE.Vector3(0, 0, 1), -3).toArray()).toEqual([4, 5, 3]);
  });
});

describe("orbitalPlacementDraftFromDrag", () => {
  it("converts camera-plane drag into canonical mutation geometry without changing unrelated fields", () => {
    const mutation = { type: "CREATE_ORBITAL_BODY" as const, bodyType: "moon" as const, primaryId: "earth", semiMajorAxisM: 1, planeNormal: [0, 1, 0] as const, radialDirection: [1, 0, 0] as const };
    const draft = orbitalPlacementDraftFromDrag(mutation, new THREE.Vector3(2, 3, 4), new THREE.Vector3(2, 3, 7), new THREE.Vector3(0, 5, 0));

    expect(draft).toEqual({ ...mutation, semiMajorAxisM: 3_000_000_000, planeNormal: [0, 1, 0], radialDirection: [0, 0, 1] });
  });

  it("updates the correct scalar for pair and ring without losing their settings", () => {
    const pair = { type: "SET_ORBITAL_PAIR" as const, firstBodyId: "a", secondBodyId: "b", separationM: 1, planeNormal: [0, 1, 0] as const, radialDirection: [1, 0, 0] as const };
    const ring = { type: "CREATE_ORBITAL_RING" as const, primaryId: "saturn", innerRadiusM: 2, outerRadiusM: 3, representativeCount: 16, totalMassKg: 99, profileId: "water-ice-v1" as const, planeNormal: [0, 1, 0] as const, radialDirection: [1, 0, 0] as const };

    const pairDraft = orbitalPlacementDraftFromDrag(pair, new THREE.Vector3(), new THREE.Vector3(4, 0, 0), new THREE.Vector3(0, 0, 1));
    const ringDraft = orbitalPlacementDraftFromDrag(ring, new THREE.Vector3(), new THREE.Vector3(4, 0, 0), new THREE.Vector3(0, 0, 1));
    expect(pairDraft).toMatchObject({ firstBodyId: "a", secondBodyId: "b" });
    expect(pairDraft?.type === "SET_ORBITAL_PAIR" ? pairDraft.separationM : 0).toBeCloseTo(4_000_000_000, -2);
    expect(ringDraft).toMatchObject({ primaryId: "saturn", innerRadiusM: 2, representativeCount: 16, totalMassKg: 99, profileId: "water-ice-v1" });
    expect(ringDraft?.type === "CREATE_ORBITAL_RING" ? ringDraft.outerRadiusM : 0).toBeCloseTo(4_000_000_000, -2);
  });

  it("rejects zero drag and ring radius inside the inner boundary", () => {
    const ring = { type: "CREATE_ORBITAL_RING" as const, primaryId: "saturn", innerRadiusM: 2_000_000_000, outerRadiusM: 3_000_000_000, representativeCount: 16, totalMassKg: 99, profileId: "water-ice-v1" as const, planeNormal: [0, 1, 0] as const, radialDirection: [1, 0, 0] as const };
    expect(orbitalPlacementDraftFromDrag(ring, new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(0, 0, 1))).toBeNull();
    expect(orbitalPlacementDraftFromDrag(ring, new THREE.Vector3(), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1))).toBeNull();
  });
});

describe("placementLaunchVelocity", () => {
  it("keeps a click stationary regardless of the optional drag speed", () => {
    expect(placementLaunchVelocity(new THREE.Vector3(), new THREE.Vector3(3, 4, 0), 0, 25_000)).toEqual([0, 0, 0]);
  });

  it("uses a chosen speed in km/s converted to m/s along the drag direction", () => {
    const velocity = placementLaunchVelocity(new THREE.Vector3(), new THREE.Vector3(3, 4, 0), 90, 25_000);
    expect(velocity[0]).toBeCloseTo(15_000, 8);
    expect(velocity[1]).toBeCloseTo(20_000, 8);
    expect(velocity[2]).toBe(0);
  });

  it("caps automatic and chosen drag speed at the supported placement limit", () => {
    const start = new THREE.Vector3();
    const end = new THREE.Vector3(0, 0, 1);

    expect(placementLaunchVelocity(start, end, 900)).toEqual([0, 0, 1_000_000]);
    expect(placementLaunchVelocity(start, end, 90, 2_000_000)).toEqual([0, 0, 1_000_000]);
  });
});
