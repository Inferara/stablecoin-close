import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildSnapshot, validateSnapshot, toStroops, fromStroops, opIndex, sacContractId,
} from "../src/snapshot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, "fixtures", name), "utf8"));

const TREASURY = "GB4SLTFQR4BPHQSEK3L2HAURRMF2L5YNZU2ZPBIKRANYLBJS3OYKCZ4G";
const PAYROLL = "GCNWK6IDAWJVBTASSSE62CB2UWO4QIYRCPN5MM3EQLSSPZZ6IYKJTQIL";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const EURC_ISSUER = "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO";
const CUSTOMER = "GDZDOY2F4QUCIQMBOHC32JARTYQ2F336IANXJOKQDB2V7SMBONBAX3L4";
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const wallet = (s, name) => s.wallets.find((w) => w.name === name);
const asset = (w, code) => w.assets.find((a) => a.asset.code === code);

// --- recorded testnet data (October 2026, the round trip in the README) ---

test("replaying the recorded testnet month reproduces the committed snapshot", () => {
  const snapshot = buildSnapshot(fixture("testnet-2026-10.input.json"));
  assert.deepEqual(snapshot, fixture("testnet-2026-10.snapshot.json"));
  assert.deepEqual(validateSnapshot(snapshot), []);
});

test("pay_invoice transfers carry the invoice number from the configured contract only", () => {
  const s = buildSnapshot(fixture("testnet-2026-10.input.json"));
  const usdc = asset(wallet(s, "Treasury"), "USDC");
  assert.equal(usdc.asset.contract, USDC_SAC);
  // The first three were paid through earlier deployments that the config
  // does not name, so they carry no invoice reference.
  assert.deepEqual(
    usdc.movements.map((m) => [m.kind, m.direction, m.amount, m.invoice_ref, m.invoice_ref_source]),
    [
      ["sac_transfer", "in", "12.5000000", null, null],
      ["sac_transfer", "in", "5.0000000", null, null],
      ["sac_transfer", "in", "12.5000000", null, null],
      ["sac_transfer", "in", "12.5000000", "INV-DEMO-0001", "contract"],
    ],
  );
  assert.equal(s.source.kind, "horizon+rpc");
});

test("transfers between the company's own wallets are internal on both legs", () => {
  const s = buildSnapshot(fixture("testnet-2026-10.input.json"));
  const inLeg = asset(wallet(s, "Treasury"), "USDC").movements[0];
  const outLeg = asset(wallet(s, "Payroll"), "USDC").movements.find((m) => m.tx_hash === inLeg.tx_hash);
  assert.deepEqual([inLeg.internal, inLeg.counterparty_wallet], [true, "w-2"]);
  assert.deepEqual([outLeg.internal, outLeg.counterparty_wallet, outLeg.direction], [true, "w-1", "out"]);
});

test("the same transfers are external when only one wallet is registered", () => {
  const input = fixture("testnet-2026-10.input.json");
  input.config = { ...input.config, wallets: input.config.wallets.slice(0, 1) };
  const s = buildSnapshot(input);
  for (const m of asset(wallet(s, "Treasury"), "USDC").movements) {
    assert.equal(m.internal, false);
    assert.equal(m.counterparty_wallet, null);
    assert.equal(m.counterparty, PAYROLL);
  }
});

test("a path payment to oneself is a conversion: two legs, own address, not internal", () => {
  const s = buildSnapshot(fixture("testnet-2026-10.input.json"));
  const w = wallet(s, "Payroll");
  const legs = w.assets.flatMap((a) =>
    a.movements.filter((m) => m.kind === "path_payment").map((m) => [a.asset.code, m.direction, m.amount, m.counterparty, m.internal]));
  assert.deepEqual(legs, [
    ["XLM", "out", "100.0000000", PAYROLL, false],
    ["USDC", "in", "88.1426867", PAYROLL, false],
  ]);
});

test("fees are XLM out, op 0, one per transaction, never internal", () => {
  const s = buildSnapshot(fixture("testnet-2026-10.input.json"));
  const fees = asset(wallet(s, "Payroll"), "XLM").movements.filter((m) => m.kind === "fee");
  assert.equal(fees.length, 6);
  for (const f of fees) assert.deepEqual([f.direction, f.op_index, f.internal], ["out", 0, false]);
  assert.equal(new Set(fees.map((f) => f.tx_hash)).size, fees.length);
});

test("USDC is valued at par with the JPY rate of the day; XLM is unpriced", () => {
  const s = buildSnapshot(fixture("testnet-2026-10.input.json"));
  const m = asset(wallet(s, "Treasury"), "USDC").movements[0];
  assert.equal(m.rate.usd, "1");
  assert.match(m.rate.source, /^par;frankfurter\.dev /);
  assert.ok(Number(m.rate.jpy) > 0);
  const x = asset(wallet(s, "Treasury"), "XLM").movements[0];
  assert.deepEqual(x.rate, { usd: "0", jpy: "0", source: "unpriced;unpriced-jpy" });
});

// --- synthetic month: a past month with activity after it ---

let seq = 0;
function op(type, time, fields, tx = {}) {
  seq += 1;
  const toid = BigInt(seq) << 32n;
  return {
    id: String(toid + 1n),
    paging_token: String(toid + 1n),
    transaction_successful: true,
    type,
    created_at: time,
    transaction_hash: `${seq}`.padStart(64, "0"),
    transaction: { memo_type: tx.memo ? "text" : "none", memo: tx.memo ?? null },
    ...fields,
  };
}
const usdc = { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER };
const eurc = { asset_type: "credit_alphanum4", asset_code: "EURC", asset_issuer: EURC_ISSUER };

function syntheticInput(extra = {}) {
  const payments = [
    op("payment", "2026-09-03T10:00:00Z", { ...usdc, from: CUSTOMER, to: TREASURY, amount: "1200.0000000" }, { memo: "paid INV1001" }),
    op("payment", "2026-09-04T10:00:00Z", { ...eurc, from: CUSTOMER, to: TREASURY, amount: "800.0000000" }, { memo: "INV-1002" }),
    op("payment", "2026-09-05T10:00:00Z", { ...usdc, from: TREASURY, to: TREASURY, amount: "1.0000000" }),
    op("payment", "2026-09-06T10:00:00Z", { ...usdc, from: CUSTOMER, to: TREASURY, amount: "300.0000000" }),
    // after the month: must be taken out of today's balance, not reported
    op("payment", "2026-10-02T10:00:00Z", { ...usdc, from: TREASURY, to: CUSTOMER, amount: "30.0000000" }),
    ...(extra.payments || []),
  ];
  return {
    config: {
      company: "demo",
      network: "testnet",
      wallets: [{ id: "w-1", name: "Treasury", purpose: "receivables", address: TREASURY, gl_account: "Stablecoins" }],
    },
    month: "2026-09",
    fetched_at: "2026-10-20T00:00:00Z",
    accounts: {
      [TREASURY]: {
        exists: true,
        balances: [
          { asset_type: "native", balance: "50.0000000" },
          { ...usdc, balance: "1500.0000000" },
          { ...eurc, balance: "800.0000000" },
        ],
        payments,
        transactions: [],
        operations: extra.operations || [],
        trades: [],
      },
    },
    invoices: {},
    rates: {
      "2026-09-03": { USD: { JPY: 147.5, date: "2026-09-03" }, EUR: { USD: 1.17, JPY: 172.6, date: "2026-09-03" } },
      "2026-09-04": { USD: { JPY: 148, date: "2026-09-04" }, EUR: { USD: 1.168, JPY: 172.9, date: "2026-09-04" } },
    },
  };
}

test("a past month is worked back from today's balance through later activity", () => {
  const s = buildSnapshot(syntheticInput());
  assert.deepEqual(validateSnapshot(s), []);
  const u = asset(wallet(s, "Treasury"), "USDC");
  // today 1500, +30 sent out in October => closing 1530; minus 1500 received => opening 30
  assert.deepEqual([u.opening, u.closing], ["30.0000000", "1530.0000000"]);
  assert.deepEqual(u.movements.map((m) => m.amount), ["1200.0000000", "300.0000000"]);
  assert.equal(s.source.balances, "reconstructed");
  assert.match(s.source.notes[0], /worked back/);
});

test("memo references are parsed and marked low confidence", () => {
  const s = buildSnapshot(syntheticInput());
  const u = asset(wallet(s, "Treasury"), "USDC").movements;
  assert.deepEqual([u[0].invoice_ref, u[0].invoice_ref_source], ["INV-1001", "memo"]);
  assert.deepEqual([u[1].invoice_ref, u[1].invoice_ref_source], [null, null]);
  const e = asset(wallet(s, "Treasury"), "EURC").movements[0];
  assert.deepEqual([e.invoice_ref, e.invoice_ref_source], ["INV-1002", "memo"]);
});

test("EURC is valued at par with EUR at that day's rate", () => {
  const s = buildSnapshot(syntheticInput());
  const e = asset(wallet(s, "Treasury"), "EURC").movements[0];
  assert.deepEqual(e.rate, { usd: "1.168", jpy: "172.9", source: "par-eur;frankfurter.dev 2026-09-04" });
  // no rate for the 6th: USDC stays at par, JPY unknown
  const u = asset(wallet(s, "Treasury"), "USDC").movements[1];
  assert.deepEqual(u.rate, { usd: "1", jpy: "0", source: "par;unpriced-jpy" });
});

test("a payment to oneself moves nothing and is left out", () => {
  const s = buildSnapshot(syntheticInput());
  const all = wallet(s, "Treasury").assets.flatMap((a) => a.movements);
  assert.ok(!all.some((m) => m.counterparty === TREASURY));
});

test("DEX offers in the window put a caveat on every asset and mark the file incomplete", () => {
  const s = buildSnapshot(syntheticInput({
    operations: [{ type: "manage_sell_offer", created_at: "2026-09-10T00:00:00Z" }],
  }));
  assert.equal(s.source.balances, "incomplete");
  for (const a of wallet(s, "Treasury").assets) assert.match(a.caveat, /traded on the DEX/);
});

test("offers before the month do not count", () => {
  const s = buildSnapshot(syntheticInput({
    operations: [{ type: "manage_sell_offer", created_at: "2026-08-10T00:00:00Z" }],
  }));
  assert.equal(s.source.balances, "reconstructed");
});

test("an operation the tool cannot read is a caveat, not a silent gap", () => {
  const s = buildSnapshot(syntheticInput({
    payments: [op("account_merge", "2026-09-07T00:00:00Z", { account: CUSTOMER, into: TREASURY })],
  }));
  assert.match(asset(wallet(s, "Treasury"), "XLM").caveat, /could not be read/);
});

test("a negative worked-back balance is flagged", () => {
  const input = syntheticInput();
  input.accounts[TREASURY].balances[1].balance = "0.0000000";
  const s = buildSnapshot(input);
  const u = asset(wallet(s, "Treasury"), "USDC");
  assert.equal(u.opening.startsWith("-"), true);
  assert.match(u.caveat, /negative/);
});

// --- helpers and the validator ---

test("amounts round-trip as exact 7-decimal strings", () => {
  for (const v of ["0.0000000", "1.0000001", "88.1426867", "922337203685.4775807"]) {
    assert.equal(fromStroops(toStroops(v)), v);
  }
  assert.equal(toStroops("12.5"), 125000000n);
  assert.throws(() => toStroops("1.00000001"));
});

test("operation ids decode to the operation's index in its transaction", () => {
  assert.equal(opIndex("22751305055383553"), 0);
  assert.equal(opIndex(String((5n << 32n) + 3n)), 2);
});

test("the SAC id is derived from the classic asset", () => {
  assert.equal(sacContractId("USDC", USDC_ISSUER, "testnet"), USDC_SAC);
});

test("the validator catches a file that does not add up", () => {
  const s = buildSnapshot(syntheticInput());
  asset(wallet(s, "Treasury"), "USDC").closing = "1.0000000";
  assert.deepEqual(validateSnapshot(s), ["w-1 USDC: opening + in - out != closing"]);
});

test("the CLI replays a recorded input to the same file", () => {
  const out = execFileSync(process.execPath, [
    join(here, "..", "bin", "fetch-month.mjs"),
    "--replay", join(here, "fixtures", "testnet-2026-10.input.json"),
  ], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), fixture("testnet-2026-10.snapshot.json"));
});

// --- recorded demo month (tools/demo/bin/stage-testnet.mjs, staged 2026-10-25) ---
// Four company wallets, invoices on the redeployed InvoiceSettlement, and a
// wallet holding Etherfuse's sandbox CETES, a tokenised bond.

const LCR_TREASURY = "GC2GL5AFJ5DVP6C3GL5RGPC2C4V34LLXKJ7RFXNCHG6PENZLXXSX5ZML";
const LCR_INVEST = "GCNK6K4YKICNTETUO5DDY6HALMEP635AIHXW2SDQBZHF3ITCRHWK23CX";
const lcr = () => buildSnapshot(fixture("testnet-lcr-2026-10.input.json"));

test("replaying the recorded demo month reproduces the committed snapshot", () => {
  assert.deepEqual(lcr(), fixture("testnet-lcr-2026-10.snapshot.json"));
  assert.deepEqual(validateSnapshot(lcr()), []);
});

test("sandbox CETES is a bond priced as its mainnet twin, at a market basis", () => {
  const cetes = asset(wallet(lcr(), "Treasury investments"), "CETES");
  assert.equal(cetes.asset.class, "bond");
  assert.deepEqual(cetes.asset.priced_as, {
    network: "mainnet", code: "CETES", issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC",
  });
  for (const rate of [cetes.closing_rate, ...cetes.movements.map((m) => m.rate)]) {
    assert.equal(rate.basis, "market");
    assert.match(rate.source, /^mainnet-twin;/);
    assert.ok(Number(rate.usd) > 0);
  }
});

test("buying CETES is a conversion inside the wallet; funding it from the Treasury is internal", () => {
  const w = wallet(lcr(), "Treasury investments");
  const legs = w.assets.flatMap((a) => a.movements.filter((m) => m.kind !== "fee")
    .map((m) => [a.asset.code, m.direction, m.kind, m.counterparty, m.internal]));
  assert.deepEqual(legs, [
    ["XLM", "in", "create_account", LCR_TREASURY, true],
    ["XLM", "out", "path_payment", LCR_INVEST, false],
    ["CETES", "in", "path_payment", LCR_INVEST, false],
  ]);
});

test("the demo Treasury: INV-1001 from the contract, 3 USDC unexplained, two internal transfers", () => {
  const usdc = asset(wallet(lcr(), "Treasury"), "USDC");
  assert.deepEqual(usdc.movements.map((m) => [m.direction, m.amount, m.invoice_ref, m.invoice_ref_source, m.internal]), [
    ["in", "12.0000000", "INV-1001", "contract", false],
    ["in", "3.0000000", null, null, false],
    ["out", "5.0000000", null, null, true],
    ["out", "2.0000000", null, null, true],
  ]);
});

test("the example in docs/examples is the recorded demo month", () => {
  const example = JSON.parse(readFileSync(join(here, "..", "..", "..", "docs", "examples", "lisbon-coffee-roasters-2026-10.json"), "utf8"));
  assert.deepEqual(example, fixture("testnet-lcr-2026-10.snapshot.json"));
});
