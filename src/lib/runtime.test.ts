import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { z } from "zod";

describe("dependências do núcleo", () => {
  it("executa operações vetoriais do Three.js no ambiente de testes", () => {
    expect(new Vector3(3, 4, 0).length()).toBe(5);
  });

  it("rejeita números não finitos na fronteira de validação", () => {
    const finite = z.number().finite();
    expect(finite.safeParse(1).success).toBe(true);
    expect(finite.safeParse(Infinity).success).toBe(false);
    expect(finite.safeParse(NaN).success).toBe(false);
  });
});
