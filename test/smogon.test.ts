import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { fetchChaos, listChaos, readRaw, chaosUrl, httpGet } from "../src/smogon.ts";
import { generate, sha256 } from "../src/generate.ts";
import { FetchError, NotFoundError } from "../src/errors.ts";

const fixture = readFileSync(new URL("./fixtures/chaos-small.json", import.meta.url));
const target = { month: "2026-09", format: "gen9championsvgc2026regmcbo3", cutoff: 1760 };
const FILE = "/stats/2026-09/chaos/gen9championsvgc2026regmcbo3-1760.json";

// A stand-in for Smogon: serves the fixture with ETag and Last-Modified, a directory listing,
// and lets a test script failures.
let body = fixture;
let failNext: number[] = [];
const requests: { path: string; headers: Record<string, string | string[] | undefined> }[] = [];
const server: Server = createServer((req, res) => {
  requests.push({ path: req.url!, headers: req.headers });
  const status = failNext.shift();
  if (status) { res.writeHead(status); res.end("boom"); return; }
  const etag = `W/"${sha256(body).slice(0, 12)}"`;
  if (req.url === FILE) {
    if (req.headers["if-none-match"] === etag) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json", etag, "last-modified": "Thu, 01 Oct 2026 14:40:21 GMT" });
    res.end(body);
  } else if (req.url === "/stats/2026-09/chaos/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><a href="../">Parent</a><a href="gen9championsvgc2026regmc-0.json">x</a>
      <a href="gen9championsvgc2026regmcbo3-1760.json">y</a><a href="gen9vgc2026regmc-1500.json">z</a>
      <a href="gen9championsvgc2026regmc-1500.json">w</a></body></html>`);
  } else {
    res.writeHead(404); res.end("nope");
  }
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const root = `http://127.0.0.1:${port}/stats/`;
const http = { root, backoffMs: 1 };
after(() => server.close());

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "vgc-usage-stats-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("chaosUrl builds Smogon's path", () => {
  assert.equal(chaosUrl(target), "https://www.smogon.com/stats/2026-09/chaos/gen9championsvgc2026regmcbo3-1760.json");
});

test("fetch populates the cache; a second call does not touch the network", async () => {
  const cacheDir = tmp();
  requests.length = 0;
  const a = await fetchChaos(target, { ...http, cacheDir });
  assert.equal(a.fromCache, false);
  assert.ok(Buffer.from(a.bytes).equals(fixture));
  assert.equal(a.source.url, `${root}2026-09/chaos/gen9championsvgc2026regmcbo3-1760.json`);
  assert.equal(a.source.http_last_modified, "Thu, 01 Oct 2026 14:40:21 GMT");
  assert.match(a.source.http_etag!, /^W\//);
  assert.ok(a.source.fetched_at);
  assert.deepEqual(readdirSync(join(cacheDir, "2026-09")).sort(), [
    "gen9championsvgc2026regmcbo3-1760.json.gz", "gen9championsvgc2026regmcbo3-1760.meta.json",
  ]);
  assert.ok(gunzipSync(readFileSync(join(cacheDir, "2026-09", "gen9championsvgc2026regmcbo3-1760.json.gz"))).equals(fixture));
  const meta = JSON.parse(readFileSync(join(cacheDir, "2026-09", "gen9championsvgc2026regmcbo3-1760.meta.json"), "utf8"));
  assert.equal(meta.sha256, sha256(fixture));
  assert.equal(meta.bytes, fixture.byteLength);

  const b = await fetchChaos(target, { ...http, cacheDir });
  assert.equal(b.fromCache, true);
  assert.deepEqual(b.source, a.source, "the cached source keeps the original fetch metadata");
  assert.equal(requests.length, 1);
});

test("--refresh sends If-None-Match, keeps the cache on 304, and keeps .prev when content changes", async () => {
  const cacheDir = tmp();
  const log: string[] = [];
  await fetchChaos(target, { ...http, cacheDir });
  requests.length = 0;
  const same = await fetchChaos(target, { ...http, cacheDir, refresh: true, log: (l) => log.push(l) });
  assert.equal(requests.length, 1);
  assert.ok(requests[0]!.headers["if-none-match"]);
  assert.equal(same.fromCache, true);
  assert.match(log.at(-1)!, /not modified/);

  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(fixture.toString()), info: { changed: true } }));
  body = changed;
  try {
    const r = await fetchChaos(target, { ...http, cacheDir, refresh: true, log: (l) => log.push(l) });
    assert.equal(r.fromCache, false);
    assert.ok(Buffer.from(r.bytes).equals(changed));
    assert.match(log.at(-1)!, new RegExp(`was sha256 ${sha256(fixture)}, now ${sha256(changed)}`));
    const files = readdirSync(join(cacheDir, "2026-09")).sort();
    assert.ok(files.includes("gen9championsvgc2026regmcbo3-1760.json.gz.prev"));
    assert.ok(files.includes("gen9championsvgc2026regmcbo3-1760.meta.json.prev"));
    assert.ok(gunzipSync(readFileSync(join(cacheDir, "2026-09", "gen9championsvgc2026regmcbo3-1760.json.gz.prev"))).equals(fixture));
    const again = await fetchChaos(target, { ...http, cacheDir });
    assert.ok(Buffer.from(again.bytes).equals(changed), "the new content is what the cache now serves");
  } finally {
    body = fixture;
  }
});

test("404 is NotFoundError at once; 5xx retries then FetchError", async () => {
  const cacheDir = tmp();
  await assert.rejects(fetchChaos({ ...target, cutoff: 9999 }, { ...http, cacheDir }), (e: unknown) => e instanceof NotFoundError && e.exitCode === 3);
  await assert.rejects(listChaos("2020-01", http), NotFoundError);

  requests.length = 0;
  failNext = [500, 503];
  const r = await fetchChaos(target, { ...http, cacheDir });
  assert.equal(r.fromCache, false);
  assert.equal(requests.length, 3, "two failures then success");

  requests.length = 0;
  failNext = [500, 500, 500];
  const log: string[] = [];
  await assert.rejects(httpGet(`${root}2026-09/chaos/x-0.json`, { ...http, log: (l) => log.push(l) }), (e: unknown) => e instanceof FetchError && e.exitCode === 4);
  assert.equal(requests.length, 3);
  assert.equal(log.length, 3);
  failNext = [];
});

test("list parses the month's chaos directory", async () => {
  const all = await listChaos("2026-09", http);
  assert.deepEqual(all.map((f) => `${f.format}-${f.cutoff}`), [
    "gen9championsvgc2026regmc-0", "gen9championsvgc2026regmc-1500", "gen9championsvgc2026regmcbo3-1760", "gen9vgc2026regmc-1500",
  ]);
  assert.equal(all[0]!.url, `${root}2026-09/chaos/gen9championsvgc2026regmc-0.json`);
  const champions = await listChaos("2026-09", { ...http, filter: "champions" });
  assert.equal(champions.length, 3);
});

test("acceptance 4: offline (--raw on the cached file) equals online", async () => {
  const cacheDir = tmp();
  const outOnline = tmp();
  const outOffline = tmp();
  const online = await fetchChaos(target, { ...http, cacheDir });
  const a = await generate({ target, raw: online.bytes, source: online.source, out: outOnline, summary: true });

  const cached = join(cacheDir, "2026-09", "gen9championsvgc2026regmcbo3-1760.json.gz");
  const offline = readRaw(cached);
  assert.deepEqual(offline.source, { url: null, path: cached, fetched_at: null, http_last_modified: null, http_etag: null });
  const b = await generate({ target, raw: offline.bytes, source: offline.source, out: outOffline, summary: true });

  // Spreads and summary are byte-identical. index.json carries the source URL or path (§4.2), so
  // it is compared with those two fields masked.
  const files = (dir: string) => ["summary.json", ...readdirSync(join(dir, "spreads")).map((f) => `spreads/${f}`)];
  assert.deepEqual(files(a.dir), files(b.dir));
  for (const f of files(a.dir)) assert.ok(readFileSync(join(a.dir, f)).equals(readFileSync(join(b.dir, f))), f);
  const index = (dir: string) => { const i = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")); i.source.url = i.source.path = null; return i; };
  assert.deepEqual(index(a.dir), index(b.dir));
  assert.equal(a.manifest.source.sha256, b.manifest.source.sha256);
  const outputs = (o: { path: string; sha256: string }[]) => o.filter((x) => x.path !== "index.json");
  assert.deepEqual(outputs(a.manifest.outputs), outputs(b.manifest.outputs));
  assert.deepEqual(a.manifest.quality, b.manifest.quality);
  assert.ok(!existsSync(join(outOffline, "2026-09", ".gen9championsvgc2026regmcbo3-1760.tmp")));
});
