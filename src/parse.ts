// Parse a Smogon chaos JSON file into species and spread records (SPEC §2.1, §5.1, §5.3).
// Pure: no I/O, no game data.

export const STATS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;
export type StatName = (typeof STATS)[number];
export type StatBlock = Record<StatName, number>;

/** The 25 natures with the stat they raise and lower (undefined for neutral natures). */
export const NATURES: Readonly<Record<string, { plus?: StatName; minus?: StatName }>> = {
  Hardy: {}, Lonely: { plus: "atk", minus: "def" }, Brave: { plus: "atk", minus: "spe" },
  Adamant: { plus: "atk", minus: "spa" }, Naughty: { plus: "atk", minus: "spd" },
  Bold: { plus: "def", minus: "atk" }, Docile: {}, Relaxed: { plus: "def", minus: "spe" },
  Impish: { plus: "def", minus: "spa" }, Lax: { plus: "def", minus: "spd" },
  Timid: { plus: "spe", minus: "atk" }, Hasty: { plus: "spe", minus: "def" }, Serious: {},
  Jolly: { plus: "spe", minus: "spa" }, Naive: { plus: "spe", minus: "spd" },
  Modest: { plus: "spa", minus: "atk" }, Mild: { plus: "spa", minus: "def" },
  Quiet: { plus: "spa", minus: "spe" }, Bashful: {}, Rash: { plus: "spa", minus: "spd" },
  Calm: { plus: "spd", minus: "atk" }, Gentle: { plus: "spd", minus: "def" },
  Sassy: { plus: "spd", minus: "spe" }, Careful: { plus: "spd", minus: "spa" }, Quirky: {},
};

export const MAX_SP_PER_STAT = 32;
export const MAX_SP_TOTAL = 66;

/** Showdown ID: lowercase, alphanumerics only. `Salamence-Mega` -> `salamencemega`. */
export function toID(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export interface Spread {
  spread: string;
  nature: string;
  sp: StatBlock;
  weight: number;
}

export interface Rejection {
  species: string;
  spread: string;
  weight: number;
  reason: string;
}

export interface SpeciesData {
  name: string;
  id: string;
  raw_count: number;
  usage: number;
  /** Σ spread weights, including rejected spreads. Shares are normalized against this. */
  total_weight: number;
  /** Σ ability weights, used for the §5.1 consistency check. */
  abilities_weight: number;
  /** |total_weight - abilities_weight| / abilities_weight (0 when both are 0). */
  rel_weight_mismatch: number;
  /** Valid spreads, sorted by weight descending then spread key ascending. */
  spreads: Spread[];
  rejected: Rejection[];
}

export interface ChaosFile {
  info: Record<string, unknown>;
  /** Sorted by total_weight descending, then name ascending. */
  species: SpeciesData[];
}

export class ParseError extends Error {}

/** Parse `Nature:HP/Atk/Def/SpA/SpD/Spe`. Throws ParseError with the reason on an invalid key. */
export function parseSpreadKey(key: string): { nature: string; sp: StatBlock } {
  const colon = key.indexOf(":");
  if (colon < 0) throw new ParseError("missing ':'");
  const nature = key.slice(0, colon);
  if (!Object.hasOwn(NATURES, nature)) throw new ParseError(`unknown nature '${nature}'`);
  const parts = key.slice(colon + 1).split("/");
  if (parts.length !== 6) throw new ParseError(`expected 6 values, got ${parts.length}`);
  const values: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) throw new ParseError(`'${part}' is not an integer`);
    const v = Number(part);
    if (v > MAX_SP_PER_STAT) throw new ParseError(`${v} exceeds ${MAX_SP_PER_STAT} per stat`);
    values.push(v);
  }
  const total = values.reduce((a, b) => a + b, 0);
  if (total > MAX_SP_TOTAL) throw new ParseError(`total ${total} exceeds ${MAX_SP_TOTAL}`);
  const [hp, atk, def, spa, spd, spe] = values as [number, number, number, number, number, number];
  return { nature, sp: { hp, atk, def, spa, spd, spe } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numberMap(v: unknown, what: string): Record<string, number> {
  if (!isRecord(v)) throw new ParseError(`${what} is not an object`);
  for (const [k, w] of Object.entries(v)) {
    if (typeof w !== "number" || !Number.isFinite(w)) throw new ParseError(`${what}['${k}'] is not a finite number`);
  }
  return v as Record<string, number>;
}

function sum(m: Record<string, number>): number {
  let s = 0;
  for (const k in m) s += m[k]!;
  return s;
}

export function compareSpreads(a: Spread, b: Spread): number {
  if (a.weight !== b.weight) return b.weight - a.weight;
  return a.spread < b.spread ? -1 : a.spread > b.spread ? 1 : 0;
}

/** Parse a whole chaos file. Structural problems throw ParseError; invalid spread keys are collected in `rejected`. */
export function parseChaos(raw: unknown): ChaosFile {
  if (!isRecord(raw)) throw new ParseError("chaos file is not an object");
  if (!isRecord(raw.info)) throw new ParseError("'info' is missing");
  if (!isRecord(raw.data)) throw new ParseError("'data' is missing");

  const species: SpeciesData[] = [];
  for (const [name, entry] of Object.entries(raw.data)) {
    if (!isRecord(entry)) throw new ParseError(`data['${name}'] is not an object`);
    const rawCount = entry["Raw count"];
    const usage = entry.usage;
    if (typeof rawCount !== "number") throw new ParseError(`data['${name}']['Raw count'] is missing`);
    if (typeof usage !== "number") throw new ParseError(`data['${name}'].usage is missing`);
    const spreadMap = numberMap(entry.Spreads, `data['${name}'].Spreads`);
    const abilities = numberMap(entry.Abilities, `data['${name}'].Abilities`);

    const spreads: Spread[] = [];
    const rejected: Rejection[] = [];
    for (const [key, weight] of Object.entries(spreadMap)) {
      try {
        const { nature, sp } = parseSpreadKey(key);
        spreads.push({ spread: key, nature, sp, weight });
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        rejected.push({ species: name, spread: key, weight, reason: e.message });
      }
    }
    spreads.sort(compareSpreads);

    const total_weight = sum(spreadMap);
    const abilities_weight = sum(abilities);
    const rel_weight_mismatch =
      abilities_weight === 0 ? (total_weight === 0 ? 0 : Infinity) : Math.abs(total_weight - abilities_weight) / abilities_weight;

    species.push({
      name, id: toID(name), raw_count: rawCount, usage,
      total_weight, abilities_weight, rel_weight_mismatch, spreads, rejected,
    });
  }

  species.sort((a, b) => {
    if (a.total_weight !== b.total_weight) return b.total_weight - a.total_weight;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return { info: raw.info, species };
}
