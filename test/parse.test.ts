import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseChaos, parseSpreadKey, toID, ParseError } from "../src/parse.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("toID matches Showdown's transform", () => {
  assert.equal(toID("Rillaboom"), "rillaboom");
  assert.equal(toID("Salamence-Mega"), "salamencemega");
  assert.equal(toID("Indeedee-F"), "indeedeef");
  assert.equal(toID("Kommo-o"), "kommoo");
  assert.equal(toID("Mr. Mime"), "mrmime");
  assert.equal(toID("Flabébé"), "flabb");
});

test("parseSpreadKey accepts valid keys and rejects each §5.3 rule", () => {
  assert.deepEqual(parseSpreadKey("Adamant:32/32/0/0/2/0"), {
    nature: "Adamant", sp: { hp: 32, atk: 32, def: 0, spa: 0, spd: 2, spe: 0 },
  });
  assert.deepEqual(parseSpreadKey("Hardy:0/0/0/0/0/0").sp, { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 });
  for (const bad of [
    "Adamantt:32/32/0/0/2/0", // unknown nature
    "Adamant:32/32/0/0/2",    // five values
    "Adamant:32/32/0/0/2/0/0",// seven values
    "Adamant:32/32/0/0/2/40", // > 32 per stat
    "Adamant:32/32/0/0/32/0", // total > 66
    "Adamant:32/32/0/0/-2/0", // not an integer
    "Adamant:32/32/0/0/2.5/0",
    "32/32/0/0/2/0",          // no nature
  ]) {
    assert.throws(() => parseSpreadKey(bad), ParseError, bad);
  }
});

test("acceptance 1: fixture parses to the expected spread table", () => {
  const parsed = parseChaos(fixture("chaos-small.json"));
  const expected: { species: string; spread: string; nature: string; sp: object; weight: number; share: number }[] =
    fixture("expected-spreads.json");

  const rows = parsed.species.flatMap((s) =>
    s.spreads.map((sp) => ({ species: s.name, spread: sp.spread, nature: sp.nature, sp: sp.sp, weight: sp.weight, share: sp.weight / s.total_weight })),
  );
  assert.equal(rows.length, expected.length);
  // Species order is by total_weight desc; within a species by weight desc then key asc.
  assert.deepEqual(parsed.species.map((s) => s.name), ["Salamence-Mega", "Indeedee-F", "Rillaboom", "Kommo-o"]);
  const byKey = new Map(expected.map((r) => [`${r.species}|${r.spread}`, r]));
  for (const row of rows) {
    const exp = byKey.get(`${row.species}|${row.spread}`);
    assert.ok(exp, `unexpected row ${row.species} ${row.spread}`);
    assert.equal(row.nature, exp.nature);
    assert.deepEqual(row.sp, exp.sp);
    assert.equal(row.weight, exp.weight);
    assert.ok(Math.abs(row.share - exp.share) < 1e-12);
  }
  for (const s of parsed.species) {
    assert.equal(s.rejected.length, 0);
    assert.ok(s.rel_weight_mismatch < 1e-9, `${s.name} mismatch ${s.rel_weight_mismatch}`);
    assert.equal(s.id, toID(s.name));
    for (let i = 1; i < s.spreads.length; i++) assert.ok(s.spreads[i - 1]!.weight >= s.spreads[i]!.weight);
  }
  const rilla = parsed.species.find((s) => s.name === "Rillaboom")!;
  assert.equal(rilla.raw_count, 262229);
  assert.equal(rilla.usage, 0.5409664);
  assert.equal(rilla.spreads.at(-1)!.weight, 0, "zero-weight spreads are kept");
});

test("acceptance 1: the invalid spread is rejected and the rest still parses", () => {
  const parsed = parseChaos(fixture("chaos-invalid.json"));
  const rilla = parsed.species.find((s) => s.name === "Rillaboom")!;
  assert.deepEqual(rilla.rejected, [
    { species: "Rillaboom", spread: "Adamant:32/32/0/0/2/40", weight: 1.5, reason: "40 exceeds 32 per stat" },
  ]);
  assert.equal(rilla.spreads.length, 5);
  assert.ok(rilla.rel_weight_mismatch < 1e-9, "rejected weight still counts toward the ability check");
  assert.equal(parsed.species.flatMap((s) => s.rejected).length, 1);
});

test("structural problems throw ParseError", () => {
  assert.throws(() => parseChaos(null), ParseError);
  assert.throws(() => parseChaos({ info: {} }), ParseError);
  assert.throws(() => parseChaos({ info: {}, data: { X: { "Raw count": 1, usage: 0.1, Spreads: {}, Abilities: "no" } } }), ParseError);
  assert.throws(() => parseChaos({ info: {}, data: { X: { "Raw count": 1, usage: 0.1, Spreads: { "Hardy:0/0/0/0/0/0": "1" }, Abilities: {} } } }), ParseError);
});
