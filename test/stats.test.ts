import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { championsStats, loadStatsDeriver, pinnedShowdownSha } from "../src/stats.ts";
import { generate } from "../src/generate.ts";
import { ValidationError } from "../src/errors.ts";
import { validate } from "../src/validate.ts";
import { STATS, type StatBlock } from "../src/parse.ts";

const PIN = "9fb3a5b99f1a0bea17f495c5cc1bfe04fdd19c3e";

// The CommonJS build exposes its exports under `default` when imported from ESM.
async function showdown(): Promise<{ Battle: any; Dex: any }> {
  const mod = await import("pokemon-showdown");
  return mod.default ?? mod;
}
const FORMAT = "gen9championsvgc2026regmcbo3";

test("the pin is a full SHA", () => {
  assert.equal(pinnedShowdownSha(), PIN);
});

test("championsStats by hand: Salamence-Mega Timid 2/0/0/32/0/32", () => {
  const base = { hp: 95, atk: 145, def: 130, spa: 120, spd: 90, spe: 120 };
  assert.deepEqual(championsStats(base, "Timid", { hp: 2, atk: 0, def: 0, spa: 32, spd: 0, spe: 32 }), {
    hp: 172,  // 95 + 2 + 75
    atk: 148, // trunc(165 * 0.9 = 148.5)
    def: 150, // 130 + 0 + 20
    spa: 172, // 120 + 32 + 20
    spd: 110,
    spe: 189, // trunc(172 * 1.1 = 189.2)
  });
  assert.deepEqual(championsStats(base, "Hardy", { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }), { hp: 170, atk: 165, def: 150, spa: 140, spd: 110, spe: 140 });
  assert.throws(() => championsStats(base, "Brash", { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }), ValidationError);
});

// A fixed sample: every stat boosted and lowered at least once, several species, a Mega, formes.
const SAMPLE: { species: string; nature: string; sp: StatBlock }[] = [
  { species: "Rillaboom", nature: "Adamant", sp: { hp: 32, atk: 32, def: 0, spa: 0, spd: 2, spe: 0 } },
  { species: "Rillaboom", nature: "Sassy", sp: { hp: 32, atk: 0, def: 4, spa: 0, spd: 30, spe: 0 } },
  { species: "Salamence-Mega", nature: "Timid", sp: { hp: 2, atk: 0, def: 0, spa: 32, spd: 0, spe: 32 } },
  { species: "Salamence-Mega", nature: "Modest", sp: { hp: 13, atk: 0, def: 0, spa: 15, spd: 20, spe: 18 } },
  { species: "Indeedee-F", nature: "Bold", sp: { hp: 32, atk: 0, def: 32, spa: 0, spd: 2, spe: 0 } },
  { species: "Indeedee-F", nature: "Relaxed", sp: { hp: 32, atk: 0, def: 32, spa: 0, spd: 2, spe: 0 } },
  { species: "Kommo-o", nature: "Quiet", sp: { hp: 32, atk: 0, def: 2, spa: 32, spd: 0, spe: 0 } },
  { species: "Incineroar", nature: "Careful", sp: { hp: 32, atk: 0, def: 2, spa: 0, spd: 32, spe: 0 } },
  { species: "Incineroar", nature: "Impish", sp: { hp: 32, atk: 0, def: 32, spa: 0, spd: 2, spe: 0 } },
  { species: "Urshifu-Rapid-Strike", nature: "Jolly", sp: { hp: 0, atk: 32, def: 0, spa: 0, spd: 2, spe: 32 } },
  { species: "Calyrex-Shadow", nature: "Brave", sp: { hp: 32, atk: 32, def: 2, spa: 0, spd: 0, spe: 0 } },
  { species: "Arcanine-Hisui", nature: "Lonely", sp: { hp: 11, atk: 11, def: 11, spa: 11, spd: 11, spe: 11 } },
  { species: "Sirfetch'd", nature: "Gentle", sp: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 } },
  { species: "Charizard-Mega-Y", nature: "Mild", sp: { hp: 1, atk: 2, def: 3, spa: 31, spd: 5, spe: 24 } },
  { species: "Garchomp-Mega-Z", nature: "Naughty", sp: { hp: 32, atk: 32, def: 0, spa: 0, spd: 0, spe: 2 } },
  { species: "Gengar-Mega", nature: "Naive", sp: { hp: 0, atk: 0, def: 0, spa: 32, spd: 2, spe: 32 } },
  { species: "Sneasler", nature: "Hasty", sp: { hp: 0, atk: 32, def: 0, spa: 0, spd: 2, spe: 32 } },
  { species: "Chi-Yu", nature: "Rash", sp: { hp: 4, atk: 0, def: 0, spa: 32, spd: 0, spe: 30 } },
  { species: "Amoonguss", nature: "Lax", sp: { hp: 32, atk: 0, def: 30, spa: 0, spd: 4, spe: 0 } },
  { species: "Flutter Mane", nature: "Serious", sp: { hp: 32, atk: 0, def: 0, spa: 32, spd: 0, spe: 2 } },
];

test("acceptance 2: derived stats equal what a Champions Reg M-C Battle reports at the pin", async () => {
  const deriver = await loadStatsDeriver(FORMAT);
  assert.equal(deriver.showdownSha, PIN);
  const { Battle, Dex } = await showdown();
  assert.equal(Dex.formats.get(FORMAT).mod, "champions");

  const toSet = (s: (typeof SAMPLE)[number]) => ({
    name: s.species, species: s.species, ability: "", item: "", moves: ["tackle"], nature: s.nature,
    evs: s.sp, ivs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, level: 50,
  });
  // Six per side per battle.
  for (let i = 0; i < SAMPLE.length; i += 6) {
    const chunk = SAMPLE.slice(i, i + 6);
    const battle = new Battle({ formatid: FORMAT, p1: { name: "p1", team: chunk.map(toSet) }, p2: { name: "p2", team: [toSet(SAMPLE[0]!)] } });
    assert.equal(battle.ruleTable.has("levelclausemod"), false);
    assert.equal(battle.dex.currentMod, "champions");
    chunk.forEach((s, j) => {
      const mon = battle.p1.pokemon[j]!;
      assert.equal(mon.species.exists, true, s.species);
      assert.equal(mon.level, 50);
      const reported: StatBlock = { ...mon.baseStoredStats };
      const derived = deriver.derive(s.species, s.nature, s.sp);
      assert.deepEqual(derived, reported, `${s.species} ${s.nature} ${STATS.map((k) => s.sp[k]).join("/")}`);
      assert.equal(mon.maxhp, derived!.hp);
    });
  }
});

test("exhaustive single-stat sweep against Showdown's own spreadModify", async () => {
  const { Battle, Dex } = await showdown();
  const filler = { name: "Rillaboom", species: "Rillaboom", ability: "", item: "", moves: ["tackle"], nature: "Hardy", evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, ivs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, level: 50 };
  const battle = new Battle({ formatid: FORMAT, p1: { name: "p1", team: [filler] }, p2: { name: "p2", team: [filler] } });
  const dex = Dex.mod("champions");
  for (const species of ["Rillaboom", "Blissey", "Shuckle", "Deoxys-Attack", "Regieleki"]) {
    const base = dex.species.get(species).baseStats;
    for (const nature of ["Adamant", "Bold", "Timid", "Modest", "Calm", "Brave", "Relaxed", "Sassy", "Quiet", "Hardy"]) {
      for (let v = 0; v <= 32; v += 4) {
        const sp = { hp: v, atk: v, def: v, spa: v, spd: v, spe: v };
        const set = { name: species, species, ability: "", item: "", moves: [], nature, evs: sp, ivs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }, level: 50 };
        assert.deepEqual(championsStats({ ...base }, nature, sp), battle.spreadModify(base, set), `${species} ${nature} ${v}`);
      }
    }
  }
});

test("unknown species derive to null; non-Champions formats are refused; unknown formats warn", async () => {
  const deriver = await loadStatsDeriver(FORMAT);
  assert.equal(deriver.derive("Notapokemon", "Hardy", { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }), null);
  assert.ok(deriver.derive("Farfetch'd", "Hardy", { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }), "straight apostrophe resolves");
  await assert.rejects(loadStatsDeriver("gen9ou"), (e: unknown) => e instanceof ValidationError && /mod 'gen9'/.test(e.message));
  const warnings: string[] = [];
  const d = await loadStatsDeriver("gen9championsvgc2019regz", (l) => warnings.push(l));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /not a format at the pinned Showdown/);
  assert.ok(d.derive("Rillaboom", "Hardy", { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }));
});

test("generate --stats on the fixture: stats in spreads and summary, showdown_sha in the manifest", async () => {
  const out = mkdtempSync(join(tmpdir(), "vgc-usage-stats-"));
  after(() => rmSync(out, { recursive: true, force: true }));
  const raw = readFileSync(new URL("./fixtures/chaos-small.json", import.meta.url));
  const stats = await loadStatsDeriver(FORMAT);
  const { dir, manifest } = await generate({
    target: { month: "2026-09", format: FORMAT, cutoff: 1760 }, raw, out, summary: true, stats,
    source: { url: null, path: "x", fetched_at: null, http_last_modified: null, http_etag: null },
  });
  assert.equal(manifest.showdown_sha, PIN);
  assert.equal(manifest.options.stats, true);
  const mega = JSON.parse(readFileSync(join(dir, "spreads/salamencemega.json"), "utf8"));
  validate("spreads", mega);
  assert.equal(mega.spreads[0].spread, "Timid:2/0/0/32/0/32");
  assert.deepEqual(mega.spreads[0].stats, { hp: 172, atk: 148, def: 150, spa: 172, spd: 110, spe: 189 });
  const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  validate("summary", summary);
  const megaSummary = summary.species.find((s: { id: string }) => s.id === "salamencemega");
  assert.equal(megaSummary.stats.overall.spe.max, 189);
  assert.equal(megaSummary.stats.by_nature.Timid.spa.min, 172);
});
