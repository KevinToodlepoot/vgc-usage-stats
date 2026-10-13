import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.ts";

const run = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/vgc-usage-stats.js", import.meta.url));
const small = fileURLToPath(new URL("./fixtures/chaos-small.json", import.meta.url));
const invalid = fileURLToPath(new URL("./fixtures/chaos-invalid.json", import.meta.url));

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "vgc-usage-stats-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [bin, ...args]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

test("generate --raw through the real entry point", async () => {
  const out = tmp();
  const r = await cli("generate", "--raw", small, "--month", "2026-09", "--format", "gen9championsvgc2026regmcbo3", "--cutoff", "1760", "--out", out, "--summary", "--min-share", "0.1");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /wrote .*gen9championsvgc2026regmcbo3-1760 \(4 species, 15 spreads, 4 dropped by floor\)/);
  assert.ok(existsSync(join(out, "2026-09", "gen9championsvgc2026regmcbo3-1760", "summary.json")));
  assert.ok(existsSync(join(out, "2026-09", "gen9championsvgc2026regmcbo3-1760", "spreads", "rillaboom.json")));
});

test("exit codes: 2 for bad arguments, 5 for a validation failure", async () => {
  const out = tmp();
  const bad = await cli("generate", "--month", "2026-09", "--out", out);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--format is required/);
  assert.match(bad.stderr, /usage:/);
  assert.equal((await cli("generate", "--raw", small, "--month", "2026-09", "--format", "a", "--format", "b", "--cutoff", "0", "--out", out)).code, 2);
  assert.equal((await cli("generate", "--raw", small, "--month", "2026-09", "--format", "a", "--cutoff", "0", "--out", out, "--min-share", "7")).code, 2);
  assert.equal((await cli("generate", "--raw", small, "--month", "2026-9", "--format", "a", "--cutoff", "0", "--out", out)).code, 2);
  assert.equal((await cli("generate", "--bogus")).code, 2);
  assert.equal((await cli("frobnicate")).code, 2);
  assert.equal((await cli()).code, 2);
  assert.equal((await cli("--help")).code, 0);

  const v = await cli("generate", "--raw", invalid, "--month", "2026-09", "--format", "gen9championsvgc2026regmcbo3", "--cutoff", "1760", "--out", out);
  assert.equal(v.code, 5);
  assert.match(v.stderr, /error: 1 spread\(s\) rejected: Rillaboom 'Adamant:32\/32\/0\/0\/2\/40' \(40 exceeds 32 per stat\)/);
  assert.ok(!existsSync(join(out, "2026-09")), "nothing written on failure");
});

test("main() is callable in-process with captured output", async () => {
  const out = tmp();
  const err: string[] = [];
  const code = await main(["generate", "--raw", small, "--month", "2026-09", "--format", "f", "--cutoff", "0", "--out", out], { stderr: (s) => err.push(s), stdout: () => {} });
  assert.equal(code, 0, err.join("\n"));
  assert.ok(existsSync(join(out, "2026-09", "f-0", "index.json")));
});
