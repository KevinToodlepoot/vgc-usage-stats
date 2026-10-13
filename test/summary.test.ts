import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseChaos, STATS } from "../src/parse.ts";
import { buildDist, summarizeSpecies, PERCENTILES, type Dist, type SpeciesSummary } from "../src/summary.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const EPS = 1e-9;

test("acceptance 8: nearest-rank percentiles on a synthetic distribution", () => {
  // weights 1,2,3,4 on values 10,20,30,40 -> cum .1, .3, .6, 1
  const d = buildDist([[40, 4], [10, 1], [30, 3], [20, 2]]);
  assert.deepEqual(d.distribution.map((e) => e.value), [10, 20, 30, 40]);
  assert.deepEqual(d.distribution.map((e) => e.weight), [1, 2, 3, 4]);
  assert.deepEqual(d.distribution.map((e) => e.cum), [0.1, 0.3, 0.6, 1]);
  assert.equal(d.p5, 10);   // smallest value with cum >= 0.05
  assert.equal(d.p10, 10);  // cum 0.1 >= 0.10 exactly, no interpolation
  assert.equal(d.p25, 20);
  assert.equal(d.p50, 30);
  assert.equal(d.p75, 40);
  assert.equal(d.p90, 40);
  assert.equal(d.p95, 40);
  assert.equal(d.min, 10);
  assert.equal(d.max, 40);
  assert.equal(d.mean, 30); // (10 + 40 + 90 + 160) / 10
});

test("buildDist aggregates duplicate values and drops zero-weight values", () => {
  const d = buildDist([[5, 1], [5, 2], [7, 0], [9, 1]]);
  assert.deepEqual(d.distribution.map((e) => [e.value, e.weight]), [[5, 3], [9, 1]]);
  assert.equal(d.max, 9);
  assert.equal(d.min, 5);
  assert.equal(d.distribution.at(-1)!.cum, 1);
  assert.throws(() => buildDist([[1, 0]]));
  assert.throws(() => buildDist([]));
});

test("buildDist: single value is every percentile", () => {
  const d = buildDist([[32, 0.001]]);
  for (const k of PERCENTILES) assert.equal(d[`p${k}`], 32);
  assert.equal(d.mean, 32);
});

function checkDist(d: Dist, label: string) {
  assert.ok(Math.abs(d.distribution.at(-1)!.cum - 1) < EPS, `${label}: cum ends at 1`);
  for (let i = 1; i < d.distribution.length; i++) {
    assert.ok(d.distribution[i]!.value > d.distribution[i - 1]!.value, `${label}: values ascending`);
    assert.ok(d.distribution[i]!.cum >= d.distribution[i - 1]!.cum, `${label}: cum non-decreasing`);
  }
  const seq = [d.min, d.p5, d.p10, d.p25, d.p50, d.p75, d.p90, d.p95, d.max];
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i]! >= seq[i - 1]!, `${label}: percentiles monotonic ${seq}`);
  assert.ok(d.mean >= d.min - EPS && d.mean <= d.max + EPS, `${label}: mean within range`);
  for (const e of d.distribution) assert.ok(e.weight > 0, `${label}: no zero-weight entries`);
}

function checkSummary(s: SpeciesSummary) {
  const shareSum = Object.values(s.nature_share).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(shareSum - 1) < EPS, `${s.name}: Σ nature_share = 1 (got ${shareSum})`);
  assert.deepEqual(Object.keys(s.concentration), Object.keys(s.nature_share));
  assert.deepEqual(Object.keys(s.sp.by_nature), Object.keys(s.nature_share));
  for (const [nature, c] of Object.entries(s.concentration)) {
    assert.ok(c.top1 > 0 && c.top1 <= c.top5 + EPS && c.top5 <= 1 + EPS, `${s.name}/${nature}: concentration`);
  }
  for (const stat of STATS) checkDist(s.sp.overall[stat], `${s.name}/overall/${stat}`);
  for (const [nature, block] of Object.entries(s.sp.by_nature)) {
    for (const stat of STATS) checkDist(block[stat], `${s.name}/${nature}/${stat}`);
  }
}

test("acceptance 5: summary invariants hold on the fixture", () => {
  const parsed = parseChaos(fixture("chaos-small.json"));
  for (const species of parsed.species) {
    const s = summarizeSpecies(species);
    checkSummary(s);
    assert.equal(s.stats, undefined);
  }
  // Rillaboom: 137.73 Sassy + 230.89 Adamant, and the zero-weight Adamant spread is not a value.
  const rilla = summarizeSpecies(parsed.species.find((s) => s.name === "Rillaboom")!);
  assert.deepEqual(Object.keys(rilla.nature_share), ["Adamant", "Sassy"]);
  assert.ok(Math.abs(rilla.nature_share.Sassy! - 137.73296986567618 / rilla.total_weight) < EPS);
  assert.equal(rilla.concentration.Sassy!.top1, 1);
  assert.ok(!rilla.sp.overall.spe.distribution.some((e) => e.value === 3), "zero-weight spread with spe=3 is excluded");
  assert.equal(rilla.sp.overall.spe.min, 0);
  assert.equal(rilla.sp.by_nature.Adamant!.atk.max, 31);
  assert.equal(rilla.sp.overall.spd.p95, 30);
});

test("acceptance 5: summary invariants hold on a large synthetic species", () => {
  // Deterministic pseudo-random spreads, including many zero weights and a nature with only zeros.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const natures = ["Adamant", "Jolly", "Timid", "Modest", "Calm"];
  const spreads = [];
  for (let i = 0; i < 5000; i++) {
    const sp = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
    let budget = 66;
    for (const stat of STATS) { const v = Math.min(32, Math.floor(rnd() * 33), budget); sp[stat] = v; budget -= v; }
    const nature = i % 50 === 0 ? "Quirky" : natures[Math.floor(rnd() * natures.length)]!;
    const weight = i % 50 === 0 || rnd() < 0.3 ? 0 : rnd() * 10;
    spreads.push({ spread: `${nature}:${STATS.map((s) => sp[s]).join("/")}`, nature, sp, weight });
  }
  spreads.sort((a, b) => b.weight - a.weight || (a.spread < b.spread ? -1 : 1));
  const total = spreads.reduce((a, s) => a + s.weight, 0);
  const species = { name: "Synth", id: "synth", raw_count: 1, usage: 1, total_weight: total, abilities_weight: total, rel_weight_mismatch: 0, spreads, rejected: [] };
  const stats = spreads.map((s) => ({ hp: s.sp.hp + 175, atk: s.sp.atk + 120, def: s.sp.def + 100, spa: s.sp.spa + 80, spd: s.sp.spd + 90, spe: s.sp.spe + 105 }));
  const s = summarizeSpecies(species, stats);
  checkSummary(s);
  assert.ok(!("Quirky" in s.nature_share), "nature with only zero-weight spreads is absent");
  assert.ok(s.stats);
  for (const stat of STATS) checkDist(s.stats.overall[stat], `stats/${stat}`);
  assert.equal(s.stats.overall.hp.min, s.sp.overall.hp.min + 175);
  assert.throws(() => summarizeSpecies(species, stats.slice(1)));
});
