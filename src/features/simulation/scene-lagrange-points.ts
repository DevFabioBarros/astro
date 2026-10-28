import * as THREE from "three";
import type { CelestialBody, Vector3 } from "@/simulation/types";
import type { SceneViewport } from "./scene-labels";
import { toScenePosition } from "./scene-scale";
import type { LagrangePoint, LagrangePointId } from "./lagrange-points";

const POINT_IDS: readonly LagrangePointId[] = ["L1", "L2", "L3", "L4", "L5"];
const TRIANGLE_EDGES = [["primary", "secondary"], ["primary", "L4"], ["secondary", "L4"], ["primary", "L5"], ["secondary", "L5"]] as const;
type ScreenPoint = { x: number; y: number; z: number };

export function createLagrangePointMarkers(parent: HTMLElement, onCreateComet: (point: LagrangePoint) => void) {
  const layer = document.createElement("div");
  layer.className = "scene-lagrange-overlay";
  layer.setAttribute("role", "group");
  layer.hidden = true;
  const guides = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  guides.setAttribute("aria-hidden", "true");
  guides.classList.add("scene-lagrange-guides");
  const lines = TRIANGLE_EDGES.map(() => {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    guides.appendChild(line);
    return line;
  });
  layer.appendChild(guides);
  const currentPoints = new Map<LagrangePointId, LagrangePoint>();
  const buttons = new Map<LagrangePointId, HTMLButtonElement>();
  for (const id of POINT_IDS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `scene-lagrange-marker is-${id.toLowerCase()}`;
    button.dataset.lagrangePoint = id;
    button.title = `Criar cometa em ${id}, usando uma aproximação orbital circular`;
    button.setAttribute("aria-label", `Criar cometa em ${id}, ponto aproximado de Lagrange`);
    const core = document.createElement("span");
    core.className = "scene-lagrange-core";
    core.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "scene-lagrange-label";
    label.textContent = id;
    const add = document.createElement("span");
    add.className = "scene-lagrange-add";
    add.textContent = "+";
    add.setAttribute("aria-hidden", "true");
    button.append(core, label, add);
    button.addEventListener("click", () => {
      const point = currentPoints.get(id);
      if (point) onCreateComet(point);
    });
    layer.appendChild(button);
    buttons.set(id, button);
  }
  parent.appendChild(layer);

  const project = (positionM: Vector3, originM: Vector3, camera: THREE.Camera, width: number, height: number): ScreenPoint | null => {
    const point = new THREE.Vector3(...toScenePosition(positionM, originM)).project(camera);
    if (![point.x, point.y, point.z].every(Number.isFinite)) return null;
    return { x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2, z: point.z };
  };
  const hide = () => {
    layer.hidden = true;
    currentPoints.clear();
  };

  return {
    update(points: readonly LagrangePoint[], primary: CelestialBody, secondary: CelestialBody, originM: Vector3, camera: THREE.Camera, width: number, height: number, viewport: SceneViewport) {
      if (points.length !== POINT_IDS.length || width <= 0 || height <= 0) { hide(); return; }
      layer.hidden = false;
      layer.setAttribute("aria-label", `Pontos de Lagrange aproximados de ${secondary.name} e ${primary.name}. Clique em um ponto para criar um cometa.`);
      currentPoints.clear();
      points.forEach((point) => currentPoints.set(point.id, point));
      const projected = new Map<string, ScreenPoint | null>([
        ["primary", project(primary.positionM, originM, camera, width, height)],
        ["secondary", project(secondary.positionM, originM, camera, width, height)],
        ...points.map((point) => [point.id, project(point.positionM, originM, camera, width, height)] as const),
      ]);
      for (const [index, [from, to]] of TRIANGLE_EDGES.entries()) {
        const start = projected.get(from), end = projected.get(to), line = lines[index]!;
        if (!start || !end || start.z < -1 || start.z > 1 || end.z < -1 || end.z > 1) { line.style.display = "none"; continue; }
        line.style.display = "block";
        line.setAttribute("x1", `${start.x}`); line.setAttribute("y1", `${start.y}`);
        line.setAttribute("x2", `${end.x}`); line.setAttribute("y2", `${end.y}`);
      }
      for (const id of POINT_IDS) {
        const button = buttons.get(id)!, point = projected.get(id);
        const visible = point !== null && point !== undefined && point.z >= -1 && point.z <= 1
          && point.x >= viewport.left + 18 && point.x <= viewport.right - 18
          && point.y >= viewport.top + 18 && point.y <= viewport.bottom - 18;
        button.style.display = visible ? "inline-flex" : "none";
        if (visible && point) { button.style.left = `${point.x}px`; button.style.top = `${point.y}px`; }
      }
    },
    hide,
    dispose() { layer.remove(); },
  };
}
