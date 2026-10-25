#!/usr/bin/env node
// stage-testnet: put the "Lisbon Coffee Roasters" demo month on Stellar testnet.
//
//   node bin/stage-testnet.mjs [--prefix lcr] [--company lisbon-coffee-roasters] [--pay-on-page]
//
// Creates the company's wallets, registers its invoices on InvoiceSettlement,
// makes the month's movements and buys a tokenised bond, then writes a fetcher
// config for those wallets. Keys stay in the stellar CLI's own keystore: this
// script builds each transaction, `stellar tx sign` signs it, and the script
// sends it. The one exception is the Treasury's authorization of
// register_invoice, which the CLI cannot sign (see submit()). Running it again
// continues where it stopped and never repeats a step that went through; the
// steps done are kept in out/<prefix>.json.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Asset, Contract, Horizon, Keypair, Memo, Networks, Operation, TransactionBuilder, authorizeEntry, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";

const HORIZON = "https://horizon-testnet.stellar.org";
const RPC = "https://soroban-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const EXPLORER = "https://stellar.expert/explorer/testnet";
const PAYER_PAGE = "https://inferara.github.io/stablecoin-close/pages/payer/";
const PASSPHRASE = Networks.TESTNET;

const DEPLOYMENT = JSON.parse(readFileSync(new URL("../../../deployments/testnet.json", import.meta.url), "utf8"));
const INVOICE_CONTRACT = DEPLOYMENT.contracts.invoice_settlement;
const USDC = new Asset("USDC", DEPLOYMENT.assets.USDC.issuer);
const EURC = new Asset("EURC", DEPLOYMENT.assets.EURC.issuer);
// Etherfuse's sandbox CETES (sand.etherfuse.com), the testnet twin of mainnet
// CETES in registry/stellar-rwa.json. Anyone can hold it; it trades against XLM
// and test USDC on the testnet DEX.
const CETES = new Asset("CETES", "GC3CW7EDYRTWQ635VDIGY6S4ZUF5L6TQ7AA4MWS7LEQDBLUSZXV7UPS4");

// Invoices on the company's A/R aging dated Sep 30. INV-1002 is a EUR invoice
// paid by a plain EURC payment with a memo, so it is not registered on chain.
const INVOICES = [
  { number: "INV-1001", amount: "12", asset: USDC, contract: DEPLOYMENT.assets.USDC.contract },
  { number: "INV-1003", amount: "5", asset: USDC, contract: DEPLOYMENT.assets.USDC.contract },
  { number: "INV-1004", amount: "4", asset: USDC, contract: DEPLOYMENT.assets.USDC.contract },
];
const DUE = Date.UTC(2026, 9, 31) / 1000; // 2026-10-31

function parse(argv) {
  const opts = { prefix: "lcr", company: "lisbon-coffee-roasters", payOnPage: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--prefix") opts.prefix = val();
    else if (a === "--company") opts.company = val();
    else if (a === "--pay-on-page") opts.payOnPage = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!/^[a-z0-9-]+$/.test(opts.prefix)) throw new Error("--prefix takes lowercase letters, digits and dashes");
  return opts;
}

const USAGE = `usage: stage-testnet [--prefix lcr] [--company lisbon-coffee-roasters] [--pay-on-page]

  --prefix       names the stellar CLI keys (<prefix>-treasury, ...) and out/<prefix>.*;
                 a new prefix stages a new company from scratch
  --company      company id used in the invoice hashes and the fetcher config
  --pay-on-page  leave INV-1001 open, to pay it from the payer page instead`;

const opts = parse(process.argv.slice(2));
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

const OUT = new URL("../out/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const STATE_FILE = new URL(`${opts.prefix}.json`, OUT);
const SALT_FILE = new URL(`${opts.prefix}.invoice-salt`, OUT);
const CONFIG_FILE = new URL(`${opts.prefix}.fetcher-config.json`, OUT);

const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { network: "testnet", company: opts.company, wallets: {}, invoices: {}, steps: {} };
if (state.company !== opts.company) throw new Error(`out/${opts.prefix}.json is for company ${state.company}`);
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");

// The invoice salt is secret: it never goes on chain, into a link or into the
// state file. DEMO_INVOICE_SALT lets the books use a salt they already have.
function invoiceSalt() {
  if (process.env.DEMO_INVOICE_SALT) return process.env.DEMO_INVOICE_SALT;
  if (!existsSync(SALT_FILE)) writeFileSync(SALT_FILE, randomBytes(24).toString("hex") + "\n");
  return readFileSync(SALT_FILE, "utf8").trim();
}

const horizon = new Horizon.Server(HORIZON);
const server = new rpc.Server(RPC);
const log = (m) => console.log(m);

// --- stellar CLI: keys and signing ---------------------------------------

function cli(args, input) {
  return execFileSync("stellar", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function keyName(role) {
  return `${opts.prefix}-${role}`;
}

function ensureKey(role) {
  const name = keyName(role);
  try {
    return cli(["keys", "address", name]);
  } catch {
    cli(["keys", "generate", name]);
    return cli(["keys", "address", name]);
  }
}

// --- chain helpers -------------------------------------------------------

async function accountExists(address) {
  try {
    await server.getAccount(address);
    return true;
  } catch {
    return false;
  }
}

async function balance(address, asset) {
  const acct = await horizon.loadAccount(address);
  const b = acct.balances.find((x) =>
    asset.isNative() ? x.asset_type === "native" : x.asset_code === asset.getCode() && x.asset_issuer === asset.getIssuer(),
  );
  return b ? Number(b.balance) : null; // null: no trustline
}

const stroops = (amount) => BigInt(Math.round(Number(amount) * 1e7));
const sevenDp = (n) => n.toFixed(7);

function invoiceHash(salt, inv) {
  const ref = [salt, opts.company, inv.number, stroops(inv.amount).toString(), inv.contract].join("|");
  return createHash("sha256").update(ref).digest("hex");
}

function refusal(sent) {
  const r = sent.errorResult;
  try {
    return r.result().switch().name;
  } catch {
    return JSON.stringify(r ?? sent, (k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 400);
  }
}

function sign(role, tx) {
  const args = ["tx", "sign", "--sign-with-key", keyName(role), "--auto-sign", "--network", "testnet", "--quiet"];
  return TransactionBuilder.fromXDR(cli(args, tx.toXDR()), PASSPHRASE);
}

// Builds, signs with the CLI key of `role`, sends over RPC and waits.
//
// With `payer`, the payer's account is the transaction source and pays the
// fee, and `role` signs only its Soroban authorization. A contract call that
// writes a new entry pays rent for it, which on testnet now runs to hundreds
// of XLM; this keeps that out of the company's wallets and books.
async function submit(role, build, stepId, { payer } = {}) {
  const fresh = async () =>
    new TransactionBuilder(await server.getAccount(state.wallets[payer ?? role]), { fee: "10000", networkPassphrase: PASSPHRASE })
      .setTimeout(120);
  let tx = build(await fresh()).build();
  if (tx.operations.some((op) => op.type === "invokeHostFunction")) tx = await server.prepareTransaction(tx);
  let signed;
  if (payer) {
    // `role` signs its authorization entry, the call is simulated again with
    // the signed entry (checking it costs resources), and the payer signs.
    // `stellar tx sign` does not sign authorization entries, so for this one
    // signature the key is read from the CLI's keystore into memory; it is
    // never printed or written.
    const keypair = Keypair.fromSecret(cli(["keys", "secret", keyName(role)]));
    const { sequence } = await server.getLatestLedger();
    const [op] = tx.operations;
    const auth = await Promise.all(op.auth.map((entry) => authorizeEntry(entry, keypair, sequence + 100, PASSPHRASE)));
    const authorized = (await fresh()).addOperation(Operation.invokeHostFunction({ func: op.func, auth })).build();
    signed = sign(payer, await server.prepareTransaction(authorized));
  } else {
    signed = sign(role, tx);
  }
  const hash = Buffer.from(signed.hash()).toString("hex");
  state.steps[stepId] = { sent: hash, sent_at: new Date().toISOString() };
  save();
  const forget = () => {
    delete state.steps[stepId];
    save();
  };
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") {
    forget();
    throw new Error(`${stepId}: refused: ${refusal(sent)}`);
  }
  const done = await server.pollTransaction(hash, { attempts: 30 });
  if (done.status === "FAILED") forget();
  if (done.status !== "SUCCESS") throw new Error(`${stepId}: ${done.status} (${EXPLORER}/tx/${hash})`);
  return hash;
}

// A step runs once. A step whose transaction was sent but not confirmed (the
// script stopped) is checked on chain before it is tried again.
async function step(id, label, run) {
  const prev = state.steps[id];
  if (prev?.tx || prev?.done) return log(`  done     ${label}`);
  if (prev?.sent) {
    const got = await server.getTransaction(prev.sent);
    if (got.status === "SUCCESS") {
      state.steps[id] = { tx: prev.sent, at: prev.sent_at };
      save();
      return log(`  done     ${label}`);
    }
    if (got.status === "NOT_FOUND" && Date.now() - Date.parse(prev.sent_at) < 180_000) {
      throw new Error(`${id}: a transaction sent at ${prev.sent_at} may still land; run again in a few minutes`);
    }
  }
  const result = await run(id);
  if (result && result.pending) {
    delete state.steps[id];
    save();
    return log(`  waiting  ${label}: ${result.pending}`);
  }
  state.steps[id] = typeof result === "string" ? { tx: result, at: new Date().toISOString() } : { done: true, ...result };
  save();
  log(`  ok       ${label}${typeof result === "string" ? `  ${EXPLORER}/tx/${result}` : ""}`);
}

async function friendbot(role) {
  const res = await fetch(`${FRIENDBOT}?addr=${state.wallets[role]}`);
  if (!res.ok) throw new Error(`friendbot: HTTP ${res.status}`);
  return { funded_by: "friendbot" };
}

const pay = (role, to, asset, amount, memo) => (id) =>
  submit(role, (b) => {
    b.addOperation(Operation.payment({ destination: state.wallets[to], asset, amount }));
    if (memo) b.addMemo(Memo.text(memo));
    return b;
  }, id);

const trust = (role, assets) => (id) =>
  submit(role, (b) => {
    for (const asset of assets) b.addOperation(Operation.changeTrust({ asset }));
    return b;
  }, id);

const create = (role, to, startingBalance) => async (id) =>
  (await accountExists(state.wallets[to]))
    ? { existed: true }
    : submit(role, (b) => b.addOperation(Operation.createAccount({ destination: state.wallets[to], startingBalance })), id);

async function needs(role, asset, amount) {
  const have = await balance(state.wallets[role], asset);
  return have !== null && have >= Number(amount);
}

async function readInvoice(hash) {
  const contract = new Contract(INVOICE_CONTRACT);
  const source = await server.getAccount(state.wallets.funder);
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(contract.call("get_invoice", xdr.ScVal.scvBytes(Buffer.from(hash, "hex"))))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  return rpc.Api.isSimulationError(sim) ? null : sim.result;
}

// --- the month -----------------------------------------------------------

async function main() {
  log(`Staging ${opts.company} on testnet (keys ${opts.prefix}-*, state out/${opts.prefix}.json)`);
  for (const role of ["funder", "customer", "treasury", "payroll", "team", "invest"]) {
    state.wallets[role] = ensureKey(role);
  }
  save();

  log("Wallets");
  // The funder and the customer are not the company's: friendbot funds them.
  // The company's wallets start small, so that XLM does not swamp the USDC.
  await step("fund-funder", "funder from friendbot", async () =>
    (await accountExists(state.wallets.funder)) ? { existed: true } : friendbot("funder"));
  await step("fund-customer", "customer from friendbot", async () =>
    (await accountExists(state.wallets.customer)) ? { existed: true } : friendbot("customer"));
  await step("create-treasury", "Treasury opened with 60 XLM", create("funder", "treasury", "60"));
  await step("create-payroll", "Payroll opened with 5 XLM", create("funder", "payroll", "5"));
  await step("create-team", "Team opened with 5 XLM", create("funder", "team", "5"));

  log("Trustlines");
  await step("trust-treasury", "Treasury: USDC, EURC", trust("treasury", [USDC, EURC]));
  await step("trust-payroll", "Payroll: USDC", trust("payroll", [USDC]));
  await step("trust-team", "Team: USDC", trust("team", [USDC]));
  await step("trust-customer", "customer: USDC, EURC", trust("customer", [USDC, EURC]));

  // Test USDC trades against XLM on the testnet DEX; Circle's faucet has a
  // captcha. EURC has no testnet market, so it comes from the faucet.
  await step("customer-usdc", "customer buys 25 USDC on the DEX", async (id) => {
    const quote = await horizon.strictReceivePaths([Asset.native()], USDC, "25").call();
    const best = quote.records[0];
    if (!best) throw new Error("no XLM to USDC path on the testnet DEX");
    return submit("customer", (b) => b.addOperation(Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: sevenDp(Number(best.source_amount) * 1.1),
      destination: state.wallets.customer,
      destAsset: USDC,
      destAmount: "25",
      path: best.path.map((p) => (p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code, p.asset_issuer))),
    })), id);
  });

  log("Invoices (InvoiceSettlement)");
  const salt = invoiceSalt();
  for (const inv of INVOICES) {
    const hash = invoiceHash(salt, inv);
    state.invoices[inv.number] = { hash, amount: inv.amount, asset: inv.asset.getCode() };
    await step(`register-${inv.number}`, `register ${inv.number}, ${inv.amount} USDC`, async (id) => {
      if (await readInvoice(hash)) return { existed: true };
      return submit("treasury", (b) => b.addOperation(new Contract(INVOICE_CONTRACT).call(
        "register_invoice",
        nativeToScVal(state.wallets.treasury, { type: "address" }),
        nativeToScVal(inv.number, { type: "string" }),
        xdr.ScVal.scvBytes(Buffer.from(hash, "hex")),
        nativeToScVal(inv.contract, { type: "address" }),
        nativeToScVal(stroops(inv.amount), { type: "i128" }),
        nativeToScVal(BigInt(DUE), { type: "u64" }),
      )), id, { payer: "funder" });
    });
  }
  save();

  log("Movements in October");
  if (opts.payOnPage) {
    log("  skipped  INV-1001: pay it from the payer page (link below)");
  } else {
    await step("pay-INV-1001", "1. customer pays INV-1001 through the contract, 12 USDC", (id) =>
      submit("customer", (b) => b.addOperation(new Contract(INVOICE_CONTRACT).call(
        "pay_invoice",
        nativeToScVal(state.wallets.customer, { type: "address" }),
        xdr.ScVal.scvBytes(Buffer.from(state.invoices["INV-1001"].hash, "hex")),
      )), id));
  }
  await step("eurc-INV1002", "2. customer pays 8 EURC, memo INV1002", async (id) => {
    if (!(await needs("customer", EURC, "8"))) {
      return { pending: `get 8+ EURC for ${state.wallets.customer} at https://faucet.circle.com (Stellar testnet), then run again` };
    }
    return pay("customer", "treasury", EURC, "8", "INV1002")(id);
  });
  await step("usdc-unexplained", "3. customer pays 3 USDC, no memo", pay("customer", "treasury", USDC, "3"));
  for (const [id, label, to, amount] of [
    ["treasury-payroll", "4. Treasury to Payroll, 5 USDC", "payroll", "5"],
    ["treasury-team", "5. Treasury to Team, 2 USDC", "team", "2"],
  ]) {
    await step(id, label, async (sid) => {
      if (!(await needs("treasury", USDC, amount))) return { pending: "the Treasury does not hold the USDC yet" };
      return pay("treasury", to, USDC, amount)(sid);
    });
  }

  log("Treasury investments");
  await step("create-invest", "Treasury opens Treasury investments with 40 XLM", create("treasury", "invest", "40"));
  await step("trust-invest", "Treasury investments: sandbox CETES", trust("invest", [CETES]));
  // A path payment from the wallet to itself: a conversion, not income.
  await step("buy-cetes", "Treasury investments buys CETES for 20 XLM", async (id) => {
    const quote = await horizon.strictSendPaths(Asset.native(), "20", [CETES]).call();
    const best = quote.records[0];
    if (!best) throw new Error("no XLM to CETES path on the testnet DEX");
    return submit("invest", (b) => b.addOperation(Operation.pathPaymentStrictSend({
      sendAsset: Asset.native(),
      sendAmount: "20",
      destination: state.wallets.invest,
      destAsset: CETES,
      destMin: sevenDp(Number(best.destination_amount) * 0.95),
      path: best.path.map((p) => (p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code, p.asset_issuer))),
    })), id);
  });

  const config = {
    company: opts.company,
    reporting_currency: "USD",
    network: "testnet",
    invoice_contract: INVOICE_CONTRACT,
    wallets: [
      { id: "w-1", name: "Treasury", purpose: "receivables", address: state.wallets.treasury, gl_account: "USDC Treasury" },
      { id: "w-2", name: "Payroll", purpose: "payroll", address: state.wallets.payroll, gl_account: "Payroll Wallet" },
      { id: "w-3", name: "Team", purpose: "team", address: state.wallets.team, gl_account: "Employee advances" },
      { id: "w-4", name: "Treasury investments", purpose: "treasury", address: state.wallets.invest, gl_account: "Short-term investments" },
    ],
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");

  log("\nWallets");
  for (const [role, address] of Object.entries(state.wallets)) log(`  ${role.padEnd(9)} ${address}  ${EXPLORER}/account/${address}`);
  log("\nOpen invoices (payer page)");
  for (const [number, inv] of Object.entries(state.invoices)) {
    const paid = state.steps[`pay-${number}`]?.tx;
    if (!paid) log(`  ${number}  ${PAYER_PAGE}?invoice=${inv.hash}&merchant=${state.wallets.treasury}`);
  }
  log(`\nFetcher config: tools/demo/out/${opts.prefix}.fetcher-config.json`);
  log(`  cd tools/fetcher && node bin/fetch-month.mjs --config ../demo/out/${opts.prefix}.fetcher-config.json --month 2026-10`);
  const waiting = ["eurc-INV1002", "usdc-unexplained", "treasury-payroll", "treasury-team", "buy-cetes"].filter((s) => !state.steps[s]);
  if (waiting.length) log(`\nNot done yet: ${waiting.join(", ")}. Run again once the waiting steps can go through.`);
}

main().catch((err) => {
  console.error(`stage-testnet: ${err.message}`);
  process.exitCode = 1;
});
