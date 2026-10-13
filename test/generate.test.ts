import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generate, sha256, type SourceInfo } from "../src/generate.ts";
import { ValidationError } from "../src/errors.ts";
import { validate, OUTPUT_KINDS, type OutputKind } from "../src/validate.ts";
import { STATS } from "../src/parse.ts";

const fixturePath = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const raw = (name: string) => readFileSync(fixturePath(name));
const target = { month: "2026-09", format: "gen9championsvgc2026regmcbo3", cutoff: 1760 };
const rawSource: SourceInfo = { url: null, path: "chaos-small.json", fetched_at: null, http_last_modified: null, http_etag: null };
const EPS = 1e-9;

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "vgc-usage-stats-"));
  test.after?.(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  ).sort();
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

test("writes the §4.1 layout and the invariants of a spreads file hold", async () => {
  const out = tmp();
  const { dir, manifest } = await generate({ target, raw: raw("chaos-small.json"), source: rawSource, out, summary: true });
  assert.equal(dir, join(out, "2026-09", "gen9championsvgc2026regmcbo3-1760"));
  assert.deepEqual(listFiles(dir), [
    "index.json", "manifest.json", "spreads/indeedeef.json", "spreads/kommoo.json",
    "spreads/rillaboom.json", "spreads/salamencemega.json", "summary.json",
  ]);
  assert.equal(manifest.quality.species, 4);
  assert.equal(manifest.quality.spreads_parsed, 15);
  assert.equal(manifest.showdown_sha, null);
  assert.deepEqual(manifest.options, { stats: false, summary: true, min_share: 0 });

  const index = readJson(join(dir, "index.json"));
  assert.deepEqual(index.species.map((s: { id: string }) => s.id), ["salamencemega", "indeedeef", "rillaboom", "kommoo"]);
  for (const s of index.species) {
    const f = readJson(join(dir, s.file));
    assert.equal(f.id, s.id);
    assert.equal(f.spreads.length, s.n_spreads);
    assert.equal(f.min_share, 0);
    assert.deepEqual(f.dropped, { count: 0, weight: 0 });
    const kept = f.spreads.reduce((a: number, r: { weight: number }) => a + r.weight, 0);
    assert.ok(Math.abs(kept + f.dropped.weight - f.total_weight) < EPS);
    const idx = Object.values(f.by_nature as Record<string, number[]>).flat().sort((a, b) => a - b);
    assert.deepEqual(idx, f.spreads.map((_: unknown, i: number) => i), "by_nature partitions spreads");
    for (const [nature, is] of Object.entries(f.by_nature as Record<string, number[]>)) {
      for (const i of is) assert.equal(f.spreads[i].nature, nature);
    }
    for (let i = 1; i < f.spreads.length; i++) assert.ok(f.spreads[i - 1].weight >= f.spreads[i].weight);
    assert.equal("stats" in f.spreads[0], false);
  }
  const summary = readJson(join(dir, "summary.json"));
  assert.equal(summary.species.length, 4);
});

test("--min-share drops spreads and accounts for them", async () => {
  const out = tmp();
  const { dir, manifest } = await generate({ target, raw: raw("chaos-small.json"), source: rawSource, out, minShare: 0.2 });
  assert.ok(!existsSync(join(dir, "summary.json")));
  const rilla = readJson(join(dir, "spreads/rillaboom.json"));
  // Rillaboom shares: 0.374, 0.265, 0.194, 0.167, 0 -> two kept
  assert.equal(rilla.min_share, 0.2);
  assert.equal(rilla.spreads.length, 2);
  assert.equal(rilla.dropped.count, 3);
  assert.ok(Math.abs(rilla.spreads[0].weight + rilla.spreads[1].weight + rilla.dropped.weight - rilla.total_weight) < EPS);
  assert.deepEqual(rilla.by_nature, { Adamant: [1], Sassy: [0] });
  const index = readJson(join(dir, "index.json"));
  assert.equal(index.species.find((s: { id: string }) => s.id === "rillaboom").n_spreads, 2);
  assert.equal(manifest.quality.spreads_dropped_by_floor, 3 + 2 + 1 + 0); // Rillaboom, Salamence-Mega, Indeedee-F, Kommo-o
  assert.ok(manifest.quality.weight_dropped_by_floor > 0);
});

test("acceptance 3: byte-identical rerun", async () => {
  const a = tmp();
  const b = tmp();
  const bytes = raw("chaos-small.json");
  const fetched = (t: string): SourceInfo => ({ url: "https://www.smogon.com/stats/2026-09/chaos/x.json", path: null, fetched_at: t, http_last_modified: "Thu, 01 Oct 2026 14:40:21 GMT", http_etag: "W/\"abc\"" });
  const ra = await generate({ target, raw: bytes, source: fetched("2026-10-13T10:00:00.000Z"), out: a, summary: true, now: () => new Date("2026-10-13T10:00:01Z") });
  const rb = await generate({ target, raw: bytes, source: fetched("2026-10-14T10:00:00.000Z"), out: b, summary: true, now: () => new Date("2026-10-14T10:00:01Z") });
  assert.deepEqual(listFiles(ra.dir), listFiles(rb.dir));
  for (const f of listFiles(ra.dir)) {
    if (f === "manifest.json") continue;
    assert.ok(readFileSync(join(ra.dir, f)).equals(readFileSync(join(rb.dir, f))), `${f} identical`);
  }
  const ma = readJson(join(ra.dir, "manifest.json"));
  const mb = readJson(join(rb.dir, "manifest.json"));
  assert.notEqual(ma.generated_at, mb.generated_at);
  assert.notEqual(ma.source.fetched_at, mb.source.fetched_at);
  const strip = (m: Record<string, unknown>) => ({ ...m, generated_at: null, source: { ...(m.source as object), fetched_at: null } });
  assert.deepEqual(strip(ma), strip(mb));
});

test("acceptance 6: every written file validates, and the schemas reject bad data", async () => {
  const out = tmp();
  const { dir } = await generate({ target, raw: raw("chaos-small.json"), source: rawSource, out, summary: true });
  for (const f of listFiles(dir)) {
    const kind: OutputKind = f.startsWith("spreads/") ? "spreads" : (f.replace(".json", "") as OutputKind);
    assert.ok(OUTPUT_KINDS.includes(kind));
    validate(kind, readJson(join(dir, f)), f);
  }
  const spreads = readJson(join(dir, "spreads/rillaboom.json"));
  assert.throws(() => validate("spreads", { ...spreads, extra: 1 }), ValidationError);
  assert.throws(() => validate("spreads", { ...spreads, spreads: [{ ...spreads.spreads[0], sp: { ...spreads.spreads[0].sp, hp: 40 } }] }), ValidationError);
  assert.throws(() => validate("spreads", { ...spreads, id: "Rilla-boom" }), ValidationError);
  const manifest = readJson(join(dir, "manifest.json"));
  assert.throws(() => validate("manifest", { ...manifest, quality: { ...manifest.quality, spreads_rejected: 1 } }), ValidationError);
  assert.throws(() => validate("index", { ...readJson(join(dir, "index.json")), species: [{ name: "x" }] }), ValidationError);
  assert.throws(() => validate("summary", { ...readJson(join(dir, "summary.json")), species: [{ name: "x" }] }), ValidationError);
});

test("acceptance 7: manifest integrity", async () => {
  const out = tmp();
  const bytes = raw("chaos-small.json");
  const { dir } = await generate({ target, raw: bytes, source: rawSource, out, summary: true });
  const manifest = readJson(join(dir, "manifest.json"));
  assert.equal(manifest.source.sha256, sha256(bytes));
  assert.equal(manifest.source.bytes, bytes.byteLength);
  const listed = manifest.outputs.map((o: { path: string }) => o.path).sort();
  assert.deepEqual(listed, listFiles(dir).filter((f) => f !== "manifest.json"));
  for (const o of manifest.outputs) {
    const content = readFileSync(join(dir, o.path));
    assert.equal(sha256(content), o.sha256, o.path);
    assert.equal(statSync(join(dir, o.path)).size, o.bytes, o.path);
  }
  assert.equal(manifest.generator.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
});

test("acceptance 9: a failed run writes nothing and leaves an earlier output intact", async () => {
  const out = tmp();
  await assert.rejects(
    generate({ target, raw: raw("chaos-invalid.json"), source: rawSource, out }),
    (e: unknown) => e instanceof ValidationError && e.exitCode === 5 && /rejected/.test(e.message) && /40 exceeds 32/.test(e.message),
  );
  assert.deepEqual(readdirSync(out), [], "nothing under --out");

  // A good run, then a failing rerun into the same --out: the good output survives untouched.
  const { dir } = await generate({ target, raw: raw("chaos-small.json"), source: rawSource, out });
  const before = listFiles(dir).map((f) => [f, sha256(readFileSync(join(dir, f)))]);
  const broken = JSON.parse(readFileSync(fixturePath("chaos-small.json"), "utf8"));
  broken.data["Rillaboom"].Abilities.grassysurge *= 2; // weight mismatch
  await assert.rejects(
    generate({ target, raw: Buffer.from(JSON.stringify(broken)), source: rawSource, out }),
    (e: unknown) => e instanceof ValidationError && /differ by/.test(e.message),
  );
  await assert.rejects(generate({ target, raw: Buffer.from("not json"), source: rawSource, out }), ValidationError);
  await assert.rejects(generate({ target, raw: Buffer.from('{"info":{}}'), source: rawSource, out }), ValidationError);
  await assert.rejects(generate({ target, raw: raw("chaos-small.json"), source: rawSource, out, minShare: 2 }), ValidationError);
  assert.deepEqual(listFiles(dir).map((f) => [f, sha256(readFileSync(join(dir, f)))]), before);
  assert.deepEqual(readdirSync(join(out, "2026-09")), ["gen9championsvgc2026regmcbo3-1760"], "no temp directories left behind");
});

test("stats deriver output lands in spreads and summary, and unresolved species fail the run", async () => {
  const out = tmp();
  const derive = (name: string, _nature: string, sp: Record<string, number>) =>
    name === "Kommo-o" ? null : Object.fromEntries(STATS.map((s) => [s, sp[s]! + 100])) as never;
  await assert.rejects(
    generate({ target, raw: raw("chaos-small.json"), source: rawSource, out, stats: { showdownSha: "9fb3a5b99f1a0bea17f495c5cc1bfe04fdd19c3e", derive } }),
    (e: unknown) => e instanceof ValidationError && /Kommo-o/.test(e.message),
  );
  const { dir, manifest } = await generate({
    target, raw: raw("chaos-small.json"), source: rawSource, out, summary: true,
    stats: { showdownSha: "9fb3a5b99f1a0bea17f495c5cc1bfe04fdd19c3e", derive: (n, nat, sp) => derive(n === "Kommo-o" ? "x" : n, nat, sp) },
  });
  assert.equal(manifest.showdown_sha, "9fb3a5b99f1a0bea17f495c5cc1bfe04fdd19c3e");
  assert.equal(manifest.options.stats, true);
  const rilla = readJson(join(dir, "spreads/rillaboom.json"));
  assert.deepEqual(rilla.spreads[0].stats, { hp: 132, atk: 100, def: 104, spa: 100, spd: 130, spe: 100 });
  const summary = readJson(join(dir, "summary.json"));
  assert.equal(summary.species[0].stats.overall.hp.min, summary.species[0].sp.overall.hp.min + 100);
});
