// Fetching chaos files from Smogon with retries and a local gzipped cache (SPEC §2, §6.3, §6.4),
// and listing what a month has.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { FetchError, NotFoundError } from "./errors.ts";
import type { SourceInfo } from "./generate.ts";
import { sha256 } from "./generate.ts";
import type { Target } from "./outputs.ts";

export const SMOGON_STATS_ROOT = "https://www.smogon.com/stats/";
export const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "vgc-usage-stats");
export const FETCH_ATTEMPTS = 3;

export interface HttpOptions {
  root?: string;
  fetchImpl?: typeof fetch;
  /** Base backoff in ms; attempt n waits backoffMs × 2^(n-1). */
  backoffMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface CacheOptions extends HttpOptions {
  cacheDir?: string;
  refresh?: boolean;
}

export interface FetchResult {
  bytes: Uint8Array;
  source: SourceInfo;
  fromCache: boolean;
}

export function chaosUrl(target: Target, root = SMOGON_STATS_ROOT): string {
  return `${root}${target.month}/chaos/${target.format}-${target.cutoff}.json`;
}

export function monthUrl(month: string, root = SMOGON_STATS_ROOT): string {
  return `${root}${month}/chaos/`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with up to FETCH_ATTEMPTS tries on 5xx, timeouts and network errors. 404 is a NotFoundError at once. */
export async function httpGet(url: string, opts: HttpOptions = {}, headers: Record<string, string> = {}): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const backoff = opts.backoffMs ?? 1000;
  let lastError = "";
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
      if (res.status === 404) throw new NotFoundError(`${url} does not exist (HTTP 404)`);
      if (res.status >= 500) {
        lastError = `HTTP ${res.status}`;
      } else {
        return res;
      }
    } catch (e) {
      if (e instanceof NotFoundError) throw e;
      lastError = e instanceof Error ? e.message : String(e);
    }
    opts.log?.(`fetch ${url}: attempt ${attempt} failed (${lastError})`);
    if (attempt < FETCH_ATTEMPTS) await sleep(backoff * 2 ** (attempt - 1));
  }
  throw new FetchError(`${url}: failed after ${FETCH_ATTEMPTS} attempts (${lastError})`);
}

interface CacheMeta {
  url: string;
  fetched_at: string;
  http_etag: string | null;
  http_last_modified: string | null;
  sha256: string;
  bytes: number;
}

function cachePaths(cacheDir: string, target: Target) {
  const base = join(cacheDir, target.month, `${target.format}-${target.cutoff}`);
  return { gz: `${base}.json.gz`, meta: `${base}.meta.json` };
}

function readCache(cacheDir: string, target: Target): { bytes: Uint8Array; meta: CacheMeta } | null {
  const p = cachePaths(cacheDir, target);
  if (!existsSync(p.gz) || !existsSync(p.meta)) return null;
  const meta: CacheMeta = JSON.parse(readFileSync(p.meta, "utf8"));
  const bytes = gunzipSync(readFileSync(p.gz));
  if (sha256(bytes) !== meta.sha256) return null; // corrupt cache entry: refetch
  return { bytes, meta };
}

function writeCache(cacheDir: string, target: Target, bytes: Uint8Array, meta: CacheMeta, keepPrev: boolean): void {
  const p = cachePaths(cacheDir, target);
  mkdirSync(join(cacheDir, target.month), { recursive: true });
  if (keepPrev) {
    for (const f of [p.gz, p.meta]) if (existsSync(f)) renameSync(f, `${f}.prev`);
  }
  writeFileSync(p.gz, gzipSync(bytes));
  writeFileSync(p.meta, JSON.stringify(meta, null, 2) + "\n");
}

/**
 * Get the chaos file for a target: from the cache when present (unless `refresh`), else from Smogon.
 * A refresh that yields different bytes is reported through `log` and the old entry is kept as `.prev`.
 */
export async function fetchChaos(target: Target, opts: CacheOptions = {}): Promise<FetchResult> {
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  const url = chaosUrl(target, opts.root);
  const cached = readCache(cacheDir, target);
  const toSource = (meta: CacheMeta): SourceInfo => ({
    url: meta.url, path: null, fetched_at: meta.fetched_at, http_last_modified: meta.http_last_modified, http_etag: meta.http_etag,
  });

  if (cached && !opts.refresh) return { bytes: cached.bytes, source: toSource(cached.meta), fromCache: true };

  const headers: Record<string, string> = {};
  if (cached?.meta.http_etag) headers["If-None-Match"] = cached.meta.http_etag;
  const res = await httpGet(url, opts, headers);
  if (res.status === 304 && cached) {
    opts.log?.(`${url}: not modified (ETag ${cached.meta.http_etag})`);
    return { bytes: cached.bytes, source: toSource(cached.meta), fromCache: true };
  }
  if (!res.ok) throw new FetchError(`${url}: HTTP ${res.status}`);

  const bytes = new Uint8Array(await res.arrayBuffer());
  const meta: CacheMeta = {
    url,
    fetched_at: new Date().toISOString(),
    http_etag: res.headers.get("etag"),
    http_last_modified: res.headers.get("last-modified"),
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
  };
  if (cached && cached.meta.sha256 !== meta.sha256) {
    opts.log?.(`${url}: content changed since ${cached.meta.fetched_at}: was sha256 ${cached.meta.sha256}, now ${meta.sha256}; previous copy kept as .prev`);
  }
  writeCache(cacheDir, target, bytes, meta, Boolean(cached && cached.meta.sha256 !== meta.sha256));
  return { bytes, source: toSource(meta), fromCache: false };
}

/** Read a local chaos file for `--raw`. A `.gz` path (such as a cache entry) is gunzipped. */
export function readRaw(path: string): { bytes: Uint8Array; source: SourceInfo } {
  const file = readFileSync(path);
  const bytes = path.endsWith(".gz") ? gunzipSync(file) : file;
  return { bytes, source: { url: null, path, fetched_at: null, http_last_modified: null, http_etag: null } };
}

export interface ChaosListing {
  format: string;
  cutoff: number;
  file: string;
  url: string;
}

/** The chaos files Smogon lists for a month, parsed from the directory listing. */
export async function listChaos(month: string, opts: HttpOptions & { filter?: string } = {}): Promise<ChaosListing[]> {
  const url = monthUrl(month, opts.root);
  const res = await httpGet(url, opts);
  if (!res.ok) throw new FetchError(`${url}: HTTP ${res.status}`);
  const html = await res.text();
  const out: ChaosListing[] = [];
  for (const m of html.matchAll(/href="([^"/]+)-(\d+)\.json"/g)) {
    const [, format, cutoff] = m as unknown as [string, string, string];
    if (opts.filter && !format.includes(opts.filter)) continue;
    out.push({ format, cutoff: Number(cutoff), file: `${format}-${cutoff}.json`, url: `${url}${format}-${cutoff}.json` });
  }
  return out.sort((a, b) => (a.format < b.format ? -1 : a.format > b.format ? 1 : a.cutoff - b.cutoff));
}
