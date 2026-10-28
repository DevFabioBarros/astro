import type { SimulationSnapshot } from "@/simulation/types";

export function translateSimulationError(error: string): string {
  return /^Acceleration exceeds the supported .+ m\/s² timestep envelope\.$/.test(error)
    ? "Afaste a câmera para posicionar este astro com segurança."
    : error;
}

export function getSimulationErrorNotice(snapshot: Pick<SimulationSnapshot, "status" | "error">): { heading: string; message: string } | null {
  if (snapshot.status === "running" || snapshot.status === "paused" && !snapshot.error) return null;
  return {
    heading: snapshot.status === "paused" ? "Simulação pausada" : "Simulação interrompida",
    message: translateSimulationError(snapshot.error ?? "Falha no motor de simulação."),
  };
}

export function SimulationErrorNotice({ notice }: { notice: ReturnType<typeof getSimulationErrorNotice> }) {
  return notice ? <div className="scene-error" role="alert"><strong>{notice.heading}</strong><span>{notice.message}</span></div> : null;
}
