// JSON Schema validation of every output object (SPEC §4.6, §11.6).

import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { ValidationError } from "./errors.ts";

export type OutputKind = "index" | "summary" | "spreads" | "manifest";
export const OUTPUT_KINDS: readonly OutputKind[] = ["index", "summary", "spreads", "manifest"];

export const SCHEMA_VERSION = "1.0.0";

export function schemaPath(kind: OutputKind): URL {
  return new URL(`../schemas/${kind}.schema.json`, import.meta.url);
}

export function loadSchema(kind: OutputKind): Record<string, unknown> {
  return JSON.parse(readFileSync(schemaPath(kind), "utf8"));
}

const ajv = new Ajv2020({ allErrors: false, strict: true });
const compiled = new Map<OutputKind, ValidateFunction>();

function validator(kind: OutputKind): ValidateFunction {
  const cached = compiled.get(kind);
  if (cached) return cached;
  const v: ValidateFunction = ajv.compile(loadSchema(kind));
  compiled.set(kind, v);
  return v;
}

/** Throws ValidationError describing the first schema violation. */
export function validate(kind: OutputKind, obj: unknown, label: string = kind): void {
  const v = validator(kind);
  if (v(obj)) return;
  const err = v.errors?.[0];
  const where = err?.instancePath || "/";
  throw new ValidationError(`${label} does not match the ${kind} schema at ${where}: ${err?.message ?? "unknown error"}`);
}
