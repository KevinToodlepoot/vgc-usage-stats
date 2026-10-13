// The git-pinned pokemon-showdown ships no declarations (its `build` step emits JS only), so the
// handful of entry points used here are declared loosely. `stats.ts` narrows what it needs.
declare module "pokemon-showdown" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Dex: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const Battle: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _default: { Dex: any; Battle: any } | undefined;
  export default _default;
}
