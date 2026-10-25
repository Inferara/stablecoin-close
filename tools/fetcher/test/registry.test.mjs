import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, validateSnapshot, sacContractId, decimal } from "../src/snapshot.mjs";
import { REGISTRY, rwaEntry, pricedAs } from "../src/registry.mjs";
import { scaled } from "../src/fetch.mjs";

const TREASURY = "GB4SLTFQR4BPHQSEK3L2HAURRMF2L5YNZU2ZPBIKRANYLBJS3OYKCZ4G";
const SELLER = "GDZDOY2F4QUCIQMBOHC32JARTYQ2F336IANXJOKQDB2V7SMBONBAX3L4";
const ETHERFUSE = "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC";
const SANDBOX = "GC3CW7EDYRTWQ635VDIGY6S4ZUF5L6TQ7AA4MWS7LEQDBLUSZXV7UPS4";
const BENJI_ISSUER = "GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5";
const COPYCAT = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

// --- the registry file itself ---

test("every registry entry is well formed, and every classic one names its own SAC", () => {
  const ids = new Set();
  for (const e of REGISTRY.assets) {
    assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
    ids.add(e.id);
    assert.ok(["mainnet", "testnet"].includes(e.network), e.id);
    assert.ok(["fund_share", "bond", "commodity"].includes(e.class), e.id);
    assert.ok(["nav", "fixed_nav", "market"].includes(e.valuation), e.id);
    if (e.token === "classic") assert.equal(e.contract, sacContractId(e.code, e.issuer, e.network), e.id);
    if (e.price_as) {
      const twin = pricedAs(e);
      assert.ok(twin && twin.network === "mainnet" && !twin.price_as, `${e.id} is priced as a mainnet entry`);
      assert.equal(twin.code, e.code);
    } else {
      assert.ok(e.sources.length > 0, `${e.id} has a value source`);
      for (const s of e.sources) assert.ok(["fixed", "redstone_sep40", "redstone_feed", "chainlink", "coingecko", "rumblefish"].includes(s.kind), `${e.id}: ${s.kind}`);
    }
  }
});

test("an asset is found by network, code and issuer, never by code alone", () => {
  assert.equal(rwaEntry("mainnet", { code: "CETES", issuer: ETHERFUSE }).id, "cetes");
  assert.equal(rwaEntry("testnet", { code: "CETES", issuer: SANDBOX }).id, "cetes-testnet");
  assert.equal(rwaEntry("testnet", { code: "CETES", issuer: ETHERFUSE }), null);
  assert.equal(rwaEntry("mainnet", { code: "CETES", issuer: COPYCAT }), null);
  assert.equal(rwaEntry("mainnet", { code: "XLM", issuer: null }), null);
});

test("oracle integers and products become plain decimal strings", () => {
  assert.equal(scaled(115086560n, 8), "1.1508656");
  assert.equal(scaled(100000000n, 8), "1");
  assert.equal(scaled(401566000000n, 8), "4015.66");
  assert.equal(decimal(0.063628 * 152.1, 6), "9.677819");
});

// --- valuation in a snapshot ---

let seq = 0;
function pay(time, code, issuer, from, to, amount) {
  seq += 1;
  const toid = BigInt(seq) << 32n;
  return {
    id: String(toid + 1n), paging_token: String(toid + 1n), transaction_successful: true, type: "payment",
    created_at: time, transaction_hash: `${seq}`.padStart(64, "a"), transaction: { memo_type: "none", memo: null },
    asset_type: "credit_alphanum12", asset_code: code, asset_issuer: issuer, from, to, amount,
  };
}

function holding({ network = "testnet", code = "CETES", issuer = SANDBOX, prices = {}, fetchedAt = "2026-10-25T13:00:00Z" } = {}) {
  return {
    config: { company: "lcr", network, wallets: [{ id: "w-4", name: "Treasury investments", purpose: "treasury", address: TREASURY, gl_account: "Short-term investments" }] },
    month: "2026-10",
    fetched_at: fetchedAt,
    accounts: {
      [TREASURY]: {
        exists: true,
        balances: [{ asset_type: "native", balance: "20.0000000" }, { asset_type: "credit_alphanum12", asset_code: code, asset_issuer: issuer, balance: "284.0000000" }],
        payments: [pay("2026-10-10T10:00:00Z", code, issuer, SELLER, TREASURY, "284.0000000")],
        transactions: [], operations: [], trades: [],
      },
    },
    invoices: {},
    rates: {
      "2026-10-10": { USD: { JPY: 151.2, date: "2026-10-09" }, EUR: { USD: 1.17, JPY: 177, date: "2026-10-09" } },
      "2026-10-25": { USD: { JPY: 152.1, date: "2026-10-23" }, EUR: { USD: 1.16, JPY: 176.4, date: "2026-10-23" } },
    },
    prices,
  };
}

const CETES_PRICES = {
  cetes: {
    redstone: [{ price: "0.0636", time: "2026-10-24T21:05:00Z" }, { price: "0.063628", time: "2026-10-25T09:05:00Z" }],
    coingecko: { "2026-10-10": "0.0635" },
  },
};

test("a testnet sandbox bond is valued as its mainnet twin: daily history for the movement, the oracle at close", () => {
  const s = buildSnapshot(holding({ prices: CETES_PRICES }));
  assert.deepEqual(validateSnapshot(s), []);
  const cetes = s.wallets[0].assets.find((a) => a.asset.code === "CETES");
  assert.equal(cetes.asset.class, "bond");
  assert.deepEqual(cetes.asset.priced_as, { network: "mainnet", code: "CETES", issuer: ETHERFUSE });
  assert.deepEqual(cetes.movements[0].rate, {
    usd: "0.0635", jpy: "9.6012", basis: "market",
    source: "mainnet-twin;market;coingecko cetes 2026-10-10;frankfurter.dev 2026-10-09",
  });
  assert.deepEqual(cetes.closing_rate, {
    usd: "0.063628", jpy: "9.677819", basis: "market",
    source: "mainnet-twin;market;redstone 2026-10-25T09:05:00Z;frankfurter.dev 2026-10-23",
  });
  assert.ok(s.source.notes.includes("Etherfuse CETES (testnet sandbox) is valued at the price of Etherfuse CETES on mainnet: there is no testnet market."));
  assert.equal(s.source.kind, "horizon+rpc");
  // XLM is not a registry asset and stays as it was.
  assert.equal(s.wallets[0].assets.find((a) => a.asset.code === "XLM").closing_rate.source, "unpriced;unpriced-jpy");
});

test("an oracle reading older than the staleness limit is not used", () => {
  const prices = { cetes: { redstone: [{ price: "0.0630", time: "2026-10-20T09:05:00Z" }] } };
  const s = buildSnapshot(holding({ prices }));
  const cetes = s.wallets[0].assets.find((a) => a.asset.code === "CETES");
  assert.deepEqual(cetes.closing_rate, { usd: "0", jpy: "0", source: "mainnet-twin;unpriced;unpriced-jpy" });
});

test("a fixed-NAV fund share is 1.00 at any date, with no price fetched", () => {
  const s = buildSnapshot(holding({ network: "mainnet", code: "BENJI", issuer: BENJI_ISSUER }));
  const benji = s.wallets[0].assets.find((a) => a.asset.code === "BENJI");
  assert.equal(benji.asset.class, "fund_share");
  assert.equal(benji.asset.priced_as, undefined);
  assert.deepEqual(benji.movements[0].rate, { usd: "1", jpy: "151.2", basis: "fixed_nav", source: "fixed_nav;fixed-nav;frankfurter.dev 2026-10-09" });
  assert.equal(s.source.kind, "horizon");
});

test("the same code from another issuer is neither classed nor valued", () => {
  const s = buildSnapshot(holding({ network: "mainnet", issuer: COPYCAT, prices: CETES_PRICES }));
  const copy = s.wallets[0].assets.find((a) => a.asset.code === "CETES");
  assert.equal(copy.asset.class, undefined);
  assert.deepEqual(copy.closing_rate, { usd: "0", jpy: "0", source: "unpriced;unpriced-jpy" });
});
