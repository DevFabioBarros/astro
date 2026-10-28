import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const sourcePath = ".vitest/solar-research/00100M.track.eep";
const outputPath = "src/simulation/solar-track-v1.json";
const expectedTrackSha256 = "a962600501741588e17ac133d60040ca686c62a2e5f07100f9eeeec3be1bc4f3";
const sourceArchiveSha256 = "a445d926c1765e951eb1bf6811dbfb14635725efcf63aaaa883d02f36cc58741";
const primaryEeps = [1, 202, 353, 454, 605, 631, 707, 808, 1409, 1710];

const text = await readFile(sourcePath, "utf8");
const hash = createHash("sha256").update(text).digest("hex");
if (hash !== expectedTrackSha256) throw new Error(`Unexpected MIST source SHA-256: ${hash}`);
const lines = text.split(/\r?\n/);
const headerIndex = lines.findIndex((line) => line.split(/\s+/).includes("star_age") && line.split(/\s+/).includes("star_mass"));
if (headerIndex < 0) throw new Error("MIST numeric header not found.");
const columns = lines[headerIndex].replace(/^\s*#\s*/, "").trim().split(/\s+/);
const required = ["star_age", "star_mass", "log_L", "log_R", "phase"];
const offsets = Object.fromEntries(required.map((name) => [name, columns.indexOf(name)]));
if (Object.values(offsets).some((index) => index < 0)) throw new Error("Required MIST columns are missing.");
const rows = [];
for (const line of lines.slice(headerIndex + 1)) {
  if (!line.trim() || line.trimStart().startsWith("#")) continue;
  const values = line.trim().split(/\s+/).map(Number);
  if (values.length !== columns.length || values.some((value) => !Number.isFinite(value))) continue;
  rows.push(required.map((name) => values[offsets[name]]));
}
if (rows.length !== 1710 || rows.some((row, index) => index > 0 && row[0] <= rows[index - 1][0])) {
  throw new Error(`Unexpected MIST row count/order: ${rows.length}`);
}

const data = {
  metadata: {
    modelId: "mist-v1.2-solar-1msun-nonrotating",
    modelVersion: "1.2",
    sourceUrl: "https://mist.science/data/tarballs_v1.2/MIST_v1.2_feh_p0.00_afe_p0.0_vvcrit0.0_EEPS.txz",
    sourceArchiveSha256,
    sourceMember: "MIST_v1.2_feh_p0.00_afe_p0.0_vvcrit0.0_EEPS/00100M.track.eep",
    sourceTrackSha256: expectedTrackSha256,
    sourceHeader: { initialMassSolar: 1, pointCount: 1710, eepCount: 10, columnCount: 77, metallicityFeH: 0, alphaFe: 0, rotationVcrit: 0 },
    sourceColumns: required,
    rowLayout: ["star_age_years", "star_mass_solar", "log10_luminosity_solar", "log10_radius_solar", "fsps_phase"],
    primaryEeps,
  },
  rows,
};
await writeFile(outputPath, `${JSON.stringify(data)}\n`);
console.log(`Wrote ${rows.length} track knots to ${outputPath}; source SHA-256 ${hash}`);
