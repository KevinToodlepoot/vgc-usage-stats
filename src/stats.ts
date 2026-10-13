// Derived final stats with the pinned pokemon-showdown (SPEC §5.2). Filled in by step 6.

import type { StatsDeriver } from "./generate.ts";
import { UsageError } from "./errors.ts";

export async function loadStatsDeriver(): Promise<StatsDeriver> {
  throw new UsageError("--stats is not implemented yet");
}
