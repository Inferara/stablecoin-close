// Network side of the fetcher: reads Horizon, Soroban RPC and frankfurter.dev
// and returns the input bundle that buildSnapshot() consumes. Nothing here
// needs a key: every service read is public.

import { rpc, Account, Contract, TransactionBuilder, BASE_FEE, xdr, scValToNative } from "@stellar/stellar-sdk";
import { PASSPHRASES, monthBounds, invoiceCall, legsFor } from "./snapshot.mjs";

export const ENDPOINTS = {
  testnet: { horizon: "https://horizon-testnet.stellar.org", rpc: "https://soroban-testnet.stellar.org" },
  // SDF runs no public mainnet RPC: set `rpc_url` in the config to read
  // invoice numbers there.
  mainnet: { horizon: "https://horizon.stellar.org", rpc: null },
};

const RATES_API = "https://api.frankfurter.dev/v1";
// Simulation needs a source account but does not check that it exists.
const READ_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    if (attempt >= 3 || (res.status < 500 && res.status !== 429)) {
      throw new Error(`${url}: HTTP ${res.status}`);
    }
    await new Promise((ok) => setTimeout(ok, 1000 * attempt));
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
export async function fetchInput(config, month, { rates = true, now = new Date() } = {}) {
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

  const rateTable = {};
  if (rates) {
    const days = new Set();
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
    fetched_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    accounts,
    invoices,
    rates: rateTable,
  };
}
