// The open registry of tokenised real-world assets on Stellar
// (registry/stellar-rwa.json): which tokens they are, their class, and where a
// real value for them comes from. Data only; see registry/README.md.

import { readFileSync } from "node:fs";

export const REGISTRY = JSON.parse(readFileSync(new URL("../../../registry/stellar-rwa.json", import.meta.url), "utf8"));

const byId = new Map(REGISTRY.assets.map((e) => [e.id, e]));

// The registry entry for a held asset, by network, code AND issuer: anyone can
// issue an asset of any code, so a code alone never matches.
export function rwaEntry(network, asset) {
  if (!asset.issuer) return null;
  return REGISTRY.assets.find((e) => e.network === network && e.code === asset.code && e.issuer === asset.issuer) || null;
}

// The entry whose sources value `entry`: its mainnet twin for a testnet token,
// otherwise itself.
export function pricedAs(entry) {
  return entry.price_as ? byId.get(entry.price_as) : entry;
}
