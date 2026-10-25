#!/usr/bin/env node
// deploy: upload, deploy and extend the contracts on testnet.
//
//   node bin/deploy.mjs --key <stellar CLI key> --wasm-dir <dir> [--extend-to 518400]
//   node bin/deploy.mjs --key <stellar CLI key> --extend <contract id> [--extend <id> ...] [--extend-to 518400]
//
// The first form uploads report_anchor.wasm and invoice_settlement.wasm from
// --wasm-dir (use the wasm CI builds, so the hashes match deployments/), deploys
// one instance of each, and extends each instance and its code to --extend-to
// ledgers from now (default about 30 days). The second only extends.
//
// Every transaction is a fee bump paid by --key. On testnet the rent for code
// has become larger than a plain transaction's fee can be (uint32 stroops, about
// 429 XLM): on 2026-10-25 an upload cost about 2,000-2,700 XLM and a 30-day
// extension 6,800-8,900 XLM. A fee bump's fee has no such limit. Keys stay in
// the stellar CLI's keystore: this script builds, `stellar tx sign` signs.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Address, Contract, Networks, Operation, SorobanDataBuilder, Transaction, TransactionBuilder, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

const PASSPHRASE = Networks.TESTNET;
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const CONTRACTS = ["report_anchor", "invoice_settlement"];

function parse(argv) {
  const opts = { extend: [], extendTo: 518_400 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--key") opts.key = val();
    else if (a === "--wasm-dir") opts.wasmDir = val();
    else if (a === "--extend") opts.extend.push(val());
    else if (a === "--extend-to") opts.extendTo = Number(val());
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const USAGE = `usage:
  deploy --key <name> --wasm-dir <dir> [--extend-to ledgers]
  deploy --key <name> --extend <contract id> [--extend <id> ...] [--extend-to ledgers]`;

const opts = parse(process.argv.slice(2));
if (opts.help || !opts.key || (!opts.wasmDir && !opts.extend.length)) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 1);
}

const cli = (args, input) => execFileSync("stellar", args, { input, encoding: "utf8" }).trim();
const me = cli(["keys", "address", opts.key]);
const sign = (tx) =>
  TransactionBuilder.fromXDR(cli(["tx", "sign", "--sign-with-key", opts.key, "--network", "testnet", "--quiet"], tx.toXDR()), PASSPHRASE);

// Simulates, then sends as a fee bump. `makeOp(auth)` builds the operation, with
// the authorization the simulation recorded.
async function run(label, makeOp, footprint = []) {
  const build = async (op, data) => {
    const source = await server.getAccount(me);
    return new TransactionBuilder(source, { fee: "100", networkPassphrase: PASSPHRASE })
      .addOperation(op)
      .setTimeout(300)
      .setSorobanData(data)
      .build();
  };
  const sim = await server.simulateTransaction(await build(makeOp([]), new SorobanDataBuilder().setReadOnly(footprint).build()));
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${label}: ${sim.error}`);
  const resourceFee = BigInt(Math.ceil(Number(sim.minResourceFee) * 1.15));
  // The builder refuses a fee above uint32, so build with a zero resource fee
  // and set the real one in the envelope; the fee bump pays it.
  const tx = await build(makeOp(sim.result?.auth ?? []), sim.transactionData.setResourceFee(0).build());
  const env = tx.toEnvelope();
  env.value.tx.ext.value.resourceFee = resourceFee;
  const signed = sign(TransactionBuilder.buildFeeBumpTransaction(me, "1000", sign(new Transaction(env, PASSPHRASE)), PASSPHRASE));
  const hash = Buffer.from(signed.hash()).toString("hex");
  console.log(`${label}: up to ${Number(resourceFee) / 1e7} XLM, ${hash}`);
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") throw new Error(`${label}: refused`);
  const done = await server.pollTransaction(hash, { attempts: 40 });
  if (done.status !== "SUCCESS") throw new Error(`${label}: ${done.status}`);
  return done;
}

async function extend(id) {
  const instance = new Contract(id).getFootprint();
  const got = await server.getLedgerEntries(instance);
  if (!got.entries.length) throw new Error(`${id}: no live instance`);
  const wasmHash = Buffer.from(got.entries[0].val.value.val.value.executable.wasmHash.value);
  const code = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
  await run(`extend ${id} to ${opts.extendTo} ledgers`, () => Operation.extendFootprintTtl({ extendTo: opts.extendTo }), [instance, code]);
}

async function main() {
  for (const id of opts.extend) await extend(id);
  if (!opts.wasmDir) return;
  const ids = {};
  for (const name of CONTRACTS) {
    const wasm = readFileSync(`${opts.wasmDir}/${name}.wasm`);
    const wasmHash = createHash("sha256").update(wasm).digest();
    const code = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
    if ((await server.getLedgerEntries(code)).entries.length) console.log(`${name}: code already uploaded`);
    else await run(`upload ${name}`, () => Operation.uploadContractWasm({ wasm }));
    const done = await run(`deploy ${name}`, (auth) =>
      Operation.createCustomContract({ address: new Address(me), wasmHash, salt: randomBytes(32), auth }));
    ids[name] = scValToNative(done.returnValue);
    await extend(ids[name]);
  }
  console.log(JSON.stringify({ contracts: ids }, null, 2));
}

main().catch((err) => {
  console.error(`deploy: ${err.message}`);
  process.exitCode = 1;
});
