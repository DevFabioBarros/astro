import { ASTRONOMICAL_UNIT_M, formatPhysicalMeasure } from "./astronomy-units";
import { getOrbitalElements } from "@/simulation/orbital-analysis";
import type { CelestialBody, PhysicsSettings, Vector3 } from "@/simulation/types";

type OrbitalReadoutProps = {
  body: CelestialBody;
  primary: CelestialBody;
  settings: PhysicsSettings;
};

const dot = (a: Vector3, b: Vector3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vector3, b: Vector3): Vector3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (vector: Vector3, magnitude: number): Vector3 => [vector[0] / magnitude, vector[1] / magnitude, vector[2] / magnitude];

function distanceLabel(distanceM: number): string {
  if (!Number.isFinite(distanceM)) return "Sem limite";
  return Math.abs(distanceM) < 0.01 * ASTRONOMICAL_UNIT_M
    ? `${formatPhysicalMeasure(distanceM / 1000)} km`
    : `${formatPhysicalMeasure(distanceM / ASTRONOMICAL_UNIT_M)} UA`;
}

function periodLabel(seconds: number): string {
  if (seconds < 60) return `${formatPhysicalMeasure(seconds)} s`;
  if (seconds < 3600) return `${formatPhysicalMeasure(seconds / 60)} min`;
  if (seconds < 86_400) return `${formatPhysicalMeasure(seconds / 3600)} h`;
  if (seconds < 31_557_600) return `${formatPhysicalMeasure(seconds / 86_400)} dias`;
  return `${formatPhysicalMeasure(seconds / 31_557_600)} anos`;
}

export function OrbitalReadout({ body, primary, settings }: OrbitalReadoutProps) {
  const elements = getOrbitalElements(body, primary, settings);
  if (!elements || !Number.isFinite(elements.eccentricity)) return null;

  const relativePosition: Vector3 = [0, 1, 2].map((axis) => body.positionM[axis]! - primary.positionM[axis]!) as unknown as Vector3;
  const relativeVelocity: Vector3 = [0, 1, 2].map((axis) => body.velocityMs[axis]! - primary.velocityMs[axis]!) as unknown as Vector3;
  const radius = Math.hypot(...relativePosition);
  const angularMomentum = cross(relativePosition, relativeVelocity);
  const angularMomentumMagnitude = Math.hypot(...angularMomentum);
  const mu = settings.gravitationalConstant * (body.massKg + primary.massKg);
  const semiMajorAxis = elements.semiMajorAxisM;
  const bound = elements.bound && semiMajorAxis > 0 && Number.isFinite(semiMajorAxis) && elements.eccentricity < 1;
  const semiMinorAxis = bound ? semiMajorAxis * Math.sqrt(Math.max(0, 1 - elements.eccentricity ** 2)) : 0;
  const period = bound && mu > 0 ? 2 * Math.PI * Math.sqrt(semiMajorAxis ** 3 / mu) : 0;
  const inclinationDegrees = angularMomentumMagnitude > 0
    ? Math.acos(Math.max(-1, Math.min(1, angularMomentum[2] / angularMomentumMagnitude))) * 180 / Math.PI
    : null;

  let diagram: { cx: number; cy: number; rx: number; ry: number; currentX: number; currentY: number; periX: number; apoX: number } | null = null;
  if (bound && radius > 0 && angularMomentumMagnitude > 0 && semiMinorAxis > 0) {
    const eccentricityVector: Vector3 = relativePosition.map((component, axis) =>
      ((dot(relativeVelocity, relativeVelocity) - mu / radius) * component - dot(relativePosition, relativeVelocity) * relativeVelocity[axis]!) / mu,
    ) as unknown as Vector3;
    const eccentricity = Math.hypot(...eccentricityVector);
    const axisX = eccentricity > 1e-8 ? unit(eccentricityVector, eccentricity) : unit(relativePosition, radius);
    const normal = unit(angularMomentum, angularMomentumMagnitude);
    const rawAxisY = cross(normal, axisX);
    const rawAxisYMagnitude = Math.hypot(...rawAxisY);
    if (rawAxisYMagnitude > 0 && Number.isFinite(eccentricity)) {
      const axisY = unit(rawAxisY, rawAxisYMagnitude);
      const scale = Math.min(78 / (semiMajorAxis * (1 + elements.eccentricity)), 31 / semiMinorAxis);
      const cx = 110;
      const cy = 43;
      const ellipseCenterX = cx - semiMajorAxis * elements.eccentricity * scale;
      diagram = {
        cx: ellipseCenterX,
        cy,
        rx: semiMajorAxis * scale,
        ry: semiMinorAxis * scale,
        currentX: cx + dot(relativePosition, axisX) * scale,
        currentY: cy - dot(relativePosition, axisY) * scale,
        periX: cx + elements.periapsisM * scale,
        apoX: cx - elements.apoapsisM * scale,
      };
    }
  }

  const mutualPair = body.kind === "star" && primary.kind === "star" && body.massKg === primary.massKg;

  return (
    <details className="orbital-readout">
      <summary>Órbita estimada · {primary.name}</summary>
      {diagram ? <svg className="orbital-diagram" viewBox="0 0 220 86" role="img" aria-label={`Órbita relativa de ${body.name} em torno de ${primary.name}; ponto dourado é o primário e ponto azul é o astro atual.`}>
        <ellipse cx={diagram.cx} cy={diagram.cy} rx={diagram.rx} ry={diagram.ry} />
        <line className="orbital-radius-line" x1={110} y1={diagram.cy} x2={diagram.currentX} y2={diagram.currentY} />
        <circle className="orbital-apsis" cx={diagram.periX} cy={diagram.cy} r={2.2} />
        <circle className="orbital-apsis" cx={diagram.apoX} cy={diagram.cy} r={2.2} />
        <circle className="orbital-primary-dot" cx={110} cy={diagram.cy} r={3.5} />
        <circle className="orbital-current-dot" cx={diagram.currentX} cy={diagram.currentY} r={4} />
      </svg> : <p className="orbital-open-trajectory">{elements.bound ? "Plano orbital degenerado; diagrama indisponível." : "Trajetória aberta; não há elipse fechada para desenhar."}</p>}
      <dl className="orbital-facts">
        <div><dt>Estado</dt><dd>{elements.bound ? "Órbita ligada" : "Trajetória aberta"}</dd></div>
        <div><dt>Excentricidade</dt><dd>{formatPhysicalMeasure(elements.eccentricity)}</dd></div>
        <div><dt>Periastro</dt><dd>{distanceLabel(elements.periapsisM)}</dd></div>
        <div><dt>Apoastro</dt><dd>{distanceLabel(elements.apoapsisM)}</dd></div>
        {period > 0 && Number.isFinite(period) ? <div><dt>Período estimado</dt><dd>{periodLabel(period)}</dd></div> : null}
        {inclinationDegrees !== null ? <div><dt>Inclinação ao plano XY</dt><dd>{formatPhysicalMeasure(inclinationDegrees)}°</dd></div> : null}
      </dl>
      <p className="experiment-note">Guia osculante instantânea; a simulação continua N-body.{mutualPair ? " Em binárias, a separação relativa é desenhada; as duas estrelas orbitam o baricentro." : ""}</p>
    </details>
  );
}
