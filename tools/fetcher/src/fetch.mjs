// Network side of the fetcher: reads Horizon, Soroban RPC, frankfurter.dev and,
// for the registry's real-world assets, RedStone on chain and CoinGecko, and
// returns the input bundle that buildSnapshot() consumes. Nothing here needs a
// key; Rumblefish is read only when RUMBLEFISH_API_KEY is set, and the key is
// never written into the bundle.

import { rpc, Account, Address, Contract, TransactionBuilder, BASE_FEE, xdr, scValToNative, nativeToScVal } from "@stellar/stellar-sdk";
import { PASSPHRASES, monthBounds, invoiceCall, legsFor, decimal } from "./snapshot.mjs";
import { REGISTRY, rwaEntry, pricedAs } from "./registry.mjs";

export const ENDPOINTS = {
  testnet: { horizon: "https://horizon-testnet.stellar.org", rpc: "https://soroban-testnet.stellar.org" },
  // SDF runs no public mainnet RPC: set `rpc_url` in the config to read
  // invoice numbers there.
  mainnet: { horizon: "https://horizon.stellar.org", rpc: null },
};

const RATES_API = "https://api.frankfurter.dev/v1";
const COINGECKO_API = "https://api.coingecko.com/api/v3";
const RUMBLEFISH_API = "https://prices-api.sorobanscan.rumblefish.dev/v1";
// The registry's oracles live on mainnet, whatever network the wallets are on.
// A public mainnet RPC; set `mainnet_rpc_url` in the config to use another.
const MAINNET_RPC = "https://mainnet.sorobanrpc.com";
// Simulation needs a source account but does not check that it exists.
const READ_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

async function getJson(url, { headers = {}, backoffMs = 1000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json", ...headers } });
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    if (attempt >= 3 || (res.status < 500 && res.status !== 429)) {
      throw new Error(`${url.split("?")[0]}: HTTP ${res.status}`);
    }
    await new Promise((ok) => setTimeout(ok, backoffMs * attempt));
  }
}

// Pages a Horizon collection newest-first until records are older than `from`.
async function collect(url, from, timeField = "created_at") {
  const out = [];
  let next = url;
  while (next) {
    const page = await getJson(next);
    const records = (page && page._embedded && page._embedded.records) || [];
    for (const r of records) {
      if (new Date(r[timeField]) < from) return out;
      out.push(r);
    }
    next = records.length ? page._links.next.href : null;
  }
  return out;
}

async function fetchAccount(horizon, address, from) {
  const base = `${horizon}/accounts/${address}`;
  const acct = await getJson(base);
  const q = "order=desc&limit=200";
  const [payments, transactions, operations, trades] = await Promise.all([
    collect(`${base}/payments?${q}&join=transactions`, from),
    collect(`${base}/transactions?${q}&include_failed=true`, from),
    collect(`${base}/operations?${q}`, from),
    collect(`${base}/trades?${q}`, from, "ledger_close_time"),
  ]);
  // The payments feed does not say how much an account merge moved; its
  // effects do.
  for (const r of payments) {
    if (r.type !== "account_merge") continue;
    const effects = await getJson(`${horizon}/operations/${r.id}/effects?limit=50`);
    const credited = ((effects && effects._embedded.records) || []).find((e) => e.type === "account_credited");
    if (credited) r.merged_amount = credited.amount;
  }
  return {
    exists: acct !== null,
    balances: acct ? acct.balances : [],
    payments,
    transactions,
    operations,
    trades,
  };
}

async function invoiceNumber(server, network, contractId, hashHex) {
  const tx = new TransactionBuilder(new Account(READ_SOURCE, "0"), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASES[network],
  })
    .addOperation(new Contract(contractId).call("get_invoice", xdr.ScVal.scvBytes(Buffer.from(hashHex, "hex"))))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result) return null;
  return scValToNative(sim.result.retval).invoice_number;
}

async function simulate(server, network, contractId, fn, ...args) {
  const tx = new TransactionBuilder(new Account(READ_SOURCE, "0"), { fee: BASE_FEE, networkPassphrase: PASSPHRASES[network] })
    .addOperation(new Contract(contractId).call(fn, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result) return null;
  return scValToNative(sim.result.retval);
}

// An i128 with `decimals` implied decimals, as an exact decimal string.
export function scaled(value, decimals) {
  const v = BigInt(value);
  const unit = 10n ** BigInt(decimals);
  const frac = (v % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${v / unit}.${frac}` : `${v / unit}`;
}

// RedStone's last readings (at most 10, about three days) for one token, oldest first.
async function redstoneReadings(server, token) {
  const oracle = REGISTRY.oracles.redstone_sep40;
  const asset = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Stellar"), new Address(token).toScVal()]);
  const list = await simulate(server, oracle.network, oracle.contract, "prices", asset, nativeToScVal(10, { type: "u32" }));
  return (list || [])
    .map((r) => ({ price: scaled(r.price, oracle.decimals), time: new Date(Number(r.timestamp) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") }))
    .sort((a, b) => (a.time < b.time ? -1 : 1));
}

// CoinGecko's daily price (00:00 UTC) for a day; its keyless tier allows a few calls a minute.
async function coingeckoDay(id, day) {
  const [y, m, d] = day.split("-");
  const body = await getJson(`${COINGECKO_API}/coins/${id}/history?date=${d}-${m}-${y}&localization=false`, { backoffMs: 20_000 });
  const usd = body && body.market_data && body.market_data.current_price && body.market_data.current_price.usd;
  return usd != null ? decimal(usd, 8) : null;
}

// Rumblefish daily closes over [from, to), by day.
async function rumblefishDays(id, from, to, key) {
  const q = `granularity=1d&base_currency=USD&start=${from.toISOString()}&end=${to.toISOString()}`;
  const body = await getJson(`${RUMBLEFISH_API}/assets/${encodeURIComponent(id)}/ohlcv?${q}`, { headers: { "x-api-key": key } });
  const out = {};
  for (const c of (body && body.data) || []) if (c.timestamp && c.close != null) out[c.timestamp.slice(0, 10)] = decimal(c.close, 8);
  return out;
}

// Prices for every registry asset the wallets held or moved this month, by the
// id of the entry that values it: { redstone: [...], coingecko: {day: usd}, rumblefish: {day: usd} }.
async function fetchPrices(config, accounts, start, end, closingDay, log) {
  const wanted = new Map(); // entry id -> { entry, days }
  for (const [address, a] of Object.entries(accounts)) {
    const touched = [];
    for (const b of a.balances) if (b.asset_issuer) touched.push({ asset: { code: b.asset_code, issuer: b.asset_issuer }, day: closingDay });
    for (const l of legsFor(address, a, config.invoice_contract).legs) {
      const t = new Date(l.time);
      if (t >= start && t < end) touched.push({ asset: l.asset, day: l.time.slice(0, 10) });
    }
    for (const { asset, day } of touched) {
      const entry = rwaEntry(config.network, asset);
      if (!entry) continue;
      const twin = pricedAs(entry);
      if (!wanted.has(twin.id)) wanted.set(twin.id, { entry: twin, days: new Set([closingDay]) });
      wanted.get(twin.id).days.add(day);
    }
  }
  const prices = {};
  if (!wanted.size) return prices;
  const server = new rpc.Server(config.mainnet_rpc_url || MAINNET_RPC);
  const key = process.env.RUMBLEFISH_API_KEY;
  for (const [id, { entry, days }] of wanted) {
    const got = (prices[id] = {});
    const kinds = new Map((entry.sources || []).map((s) => [s.kind, s]));
    if (kinds.has("redstone_sep40")) {
      try {
        got.redstone = await redstoneReadings(server, kinds.get("redstone_sep40").asset);
      } catch (e) {
        log(`RedStone could not be read for ${entry.code}: ${e.message}`);
      }
    }
    // Daily sources fill the days the on-chain readings do not reach.
    const covered = got.redstone && got.redstone.length ? got.redstone[0].time.slice(0, 10) : "9999";
    const older = [...days].filter((d) => d < covered).sort();
    if (older.length && kinds.has("coingecko")) {
      got.coingecko = {};
      for (const d of older) {
        try {
          const usd = await coingeckoDay(kinds.get("coingecko").id, d);
          if (usd) got.coingecko[d] = usd;
        } catch (e) {
          log(`CoinGecko could not be read for ${entry.code} on ${d}: ${e.message}`);
        }
      }
    }
    if (older.length && key && kinds.has("rumblefish")) {
      try {
        got.rumblefish = await rumblefishDays(kinds.get("rumblefish").id, start, end, key);
      } catch (e) {
        log(`Rumblefish could not be read for ${entry.code}: ${e.message}`);
      }
    }
  }
  return prices;
}

async function ratesFor(date) {
  const [usd, eur] = await Promise.all([
    getJson(`${RATES_API}/${date}?base=USD&symbols=JPY`),
    getJson(`${RATES_API}/${date}?base=EUR&symbols=USD,JPY`),
  ]);
  return {
    USD: usd && { JPY: usd.rates.JPY, date: usd.date },
    EUR: eur && { USD: eur.rates.USD, JPY: eur.rates.JPY, date: eur.date },
  };
}

// Returns the bundle buildSnapshot() takes. `now` is injectable for tests.
export async function fetchInput(config, month, { rates = true, now = new Date(), log = (m) => console.error(m) } = {}) {
  const ep = ENDPOINTS[config.network];
  if (!ep) throw new Error(`network must be testnet or mainnet: ${config.network}`);
  const horizon = config.horizon_url || ep.horizon;
  const { start, end } = monthBounds(month);

  const accounts = {};
  for (const w of config.wallets) accounts[w.address] = await fetchAccount(horizon, w.address, start);

  const invoices = {};
  if (config.invoice_contract) {
    const url = config.rpc_url || ep.rpc;
    if (!url) throw new Error("invoice_contract on mainnet needs rpc_url in the config");
    const server = new rpc.Server(url);
    for (const a of Object.values(accounts)) {
      for (const r of a.payments) {
        const h = invoiceCall(r, config.invoice_contract);
        if (h && !(h in invoices)) invoices[h] = await invoiceNumber(server, config.network, config.invoice_contract, h);
      }
    }
  }

  const fetchedAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const closingDay = new Date(Math.min(end.getTime() - 1000, new Date(fetchedAt).getTime())).toISOString().slice(0, 10);
  const rateTable = {};
  let prices = {};
  if (rates) {
    prices = await fetchPrices(config, accounts, start, end, closingDay, log);
    const days = new Set([closingDay]);
    for (const [address, a] of Object.entries(accounts)) {
      for (const l of legsFor(address, a, config.invoice_contract).legs) {
        const t = new Date(l.time);
        if (t >= start && t < end) days.add(l.time.slice(0, 10));
      }
    }
    for (const d of [...days].sort()) rateTable[d] = await ratesFor(d);
  }

  return {
    config,
    month,
    fetched_at: fetchedAt,
    accounts,
    invoices,
    rates: rateTable,
    prices,
  };
}
