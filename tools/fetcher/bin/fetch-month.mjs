#!/usr/bin/env node
// stellar-month: write a haruno.stellar.month/1 snapshot.
//
//   node bin/fetch-month.mjs --config wallets.json --month 2026-10 [--out 2026-10.json]
//                            [--no-rates] [--record input.json]
//   node bin/fetch-month.mjs --replay input.json [--out 2026-10.json]
//
// --record saves everything that was fetched, so the same snapshot can be
// rebuilt offline with --replay (that is how the test fixtures were made).

import { readFileSync, writeFileSync } from "node:fs";
import { buildSnapshot, validateSnapshot } from "../src/snapshot.mjs";
import { fetchInput } from "../src/fetch.mjs";

function parse(argv) {
  const opts = { rates: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--config") opts.config = val();
    else if (a === "--month") opts.month = val();
    else if (a === "--out") opts.out = val();
    else if (a === "--record") opts.record = val();
    else if (a === "--replay") opts.replay = val();
    else if (a === "--no-rates") opts.rates = false;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const USAGE = `usage:
  stellar-month --config wallets.json --month YYYY-MM [--out file] [--no-rates] [--record input.json]
  stellar-month --replay input.json [--out file]`;

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) return console.log(USAGE);

  let input;
  if (opts.replay) {
    input = JSON.parse(readFileSync(opts.replay, "utf8"));
  } else {
    if (!opts.config || !opts.month) throw new Error(USAGE);
    const config = JSON.parse(readFileSync(opts.config, "utf8"));
    input = await fetchInput(config, opts.month, { rates: opts.rates });
    if (opts.record) writeFileSync(opts.record, JSON.stringify(input, null, 2) + "\n");
  }

  const snapshot = buildSnapshot(input);
  const problems = validateSnapshot(snapshot);
  if (problems.length) {
    console.error("the snapshot does not add up:\n  " + problems.join("\n  "));
    process.exitCode = 2;
    return;
  }
  const text = JSON.stringify(snapshot, null, 2) + "\n";
  if (opts.out) writeFileSync(opts.out, text);
  else process.stdout.write(text);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
