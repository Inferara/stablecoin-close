// Builds a `haruno.stellar.month/1` snapshot from data already fetched from
// Horizon (and, for invoice numbers, Soroban RPC). Pure: no network access, so
// it can be tested on recorded inputs. See docs/haruno-stellar-month-1.md.

import { Asset, Networks, xdr, scValToNative, Address } from "@stellar/stellar-sdk";

export const FORMAT = "haruno.stellar.month/1";

export const PASSPHRASES = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

// Stablecoins valued at par with their reference currency. This is a peg
// assumption, not a market price: a depeg would not show here.
export const PEGGED = {
  testnet: {
    "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5": "USD",
    "EURC:GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO": "EUR",
  },
  mainnet: {
    "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN": "USD",
    "EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2": "EUR",
  },
};

// Operations that change a balance in ways the payments feed does not show.
// Seeing one in the window means the worked-back balances cannot be trusted.
const BLIND_SPOTS = {
  manage_sell_offer: "traded on the DEX",
  manage_buy_offer: "traded on the DEX",
  create_passive_sell_offer: "traded on the DEX",
  create_claimable_balance: "used claimable balances",
  claim_claimable_balance: "used claimable balances",
  clawback: "was clawed back",
  clawback_claimable_balance: "was clawed back",
  liquidity_pool_deposit: "used a liquidity pool",
  liquidity_pool_withdraw: "used a liquidity pool",
};

export const DEFAULT_MEMO_PATTERN = "INV[-\\s_]?(\\d+)";
export const DEFAULT_MEMO_FORMAT = "INV-$1";

const SCALE = 10_000_000n;

export function toStroops(decimal) {
  const s = String(decimal).trim();
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || frac.length > 7) {
    throw new Error(`not a 7-decimal amount: ${decimal}`);
  }
  const v = BigInt(whole) * SCALE + BigInt(frac.padEnd(7, "0"));
  return neg ? -v : v;
}

export function fromStroops(v) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? "-" : ""}${a / SCALE}.${(a % SCALE).toString().padStart(7, "0")}`;
}

export function monthBounds(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`month must be YYYY-MM: ${month}`);
  const [y, m] = month.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

function assetKey(code, issuer) {
  return issuer ? `${code}:${issuer}` : "XLM";
}

function fromHorizonAsset(type, code, issuer) {
  return type === "native" ? { code: "XLM", issuer: null } : { code, issuer };
}

export function sacContractId(code, issuer, network) {
  const asset = issuer ? new Asset(code, issuer) : Asset.native();
  return asset.contractId(PASSPHRASES[network]);
}

// Horizon operation ids encode the operation's 1-based index in their low 12 bits.
export function opIndex(operationId) {
  return Number((BigInt(operationId) & 0xfffn) - 1n);
}

// If a payments-feed record is a call to `pay_invoice` on the given contract,
// returns the invoice hash (hex); otherwise null.
export function invoiceCall(record, invoiceContract) {
  if (!invoiceContract || record.type !== "invoke_host_function") return null;
  const p = record.parameters || [];
  if (p.length < 4) return null;
  try {
    const decode = (v) => scValToNative(xdr.ScVal.fromXDR(v.value, "base64"));
    const contract = Address.fromScVal(xdr.ScVal.fromXDR(p[0].value, "base64")).toString();
    if (contract !== invoiceContract || decode(p[1]) !== "pay_invoice") return null;
    return Buffer.from(decode(p[3])).toString("hex");
  } catch {
    return null;
  }
}

function memoInvoice(memo, config) {
  if (!memo) return null;
  const re = new RegExp(config.memo_invoice_pattern || DEFAULT_MEMO_PATTERN, "i");
  const m = re.exec(memo);
  if (!m) return null;
  return m[0].replace(re, config.memo_invoice_format || DEFAULT_MEMO_FORMAT);
}

function rateFor(asset, network, date, rates) {
  const peg = PEGGED[network][assetKey(asset.code, asset.issuer)];
  const day = rates && rates[date];
  if (peg === "USD") {
    const jpy = day && day.USD && day.USD.JPY;
    return jpy
      ? { usd: "1", jpy: String(jpy), source: `par;frankfurter.dev ${day.USD.date}` }
      : { usd: "1", jpy: "0", source: "par;unpriced-jpy" };
  }
  if (peg === "EUR" && day && day.EUR && day.EUR.USD && day.EUR.JPY) {
    return { usd: String(day.EUR.USD), jpy: String(day.EUR.JPY), source: `par-eur;frankfurter.dev ${day.EUR.date}` };
  }
  return { usd: "0", jpy: "0", source: "unpriced;unpriced-jpy" };
}

// Every balance change of one account, as signed legs:
// { tx_hash, op_index, paging, time, kind, asset, delta, counterparty, memo, invoice_hash, fee }
export function legsFor(address, account, invoiceContract) {
  const legs = [];
  const unknown = [];
  for (const r of account.payments || []) {
    if (r.transaction_successful === false) continue;
    const tx = r.transaction || {};
    const base = {
      tx_hash: r.transaction_hash,
      op_index: opIndex(r.id),
      paging: BigInt(r.paging_token || r.id),
      time: r.created_at,
      memo: tx.memo_type === "text" ? tx.memo : tx.memo != null ? String(tx.memo) : null,
      invoice_hash: invoiceCall(r, invoiceContract),
    };
    const push = (kind, asset, delta, counterparty) =>
      legs.push({ ...base, kind, asset, delta, counterparty });

    switch (r.type) {
      case "create_account": {
        const amt = toStroops(r.starting_balance);
        const xlm = { code: "XLM", issuer: null };
        if (r.account === address) push("create_account", xlm, amt, r.funder);
        if (r.funder === address) push("create_account", xlm, -amt, r.account);
        break;
      }
      case "payment": {
        if (r.from === r.to) break; // moves nothing
        const asset = fromHorizonAsset(r.asset_type, r.asset_code, r.asset_issuer);
        const amt = toStroops(r.amount);
        if (r.to === address) push("payment", asset, amt, r.from);
        if (r.from === address) push("payment", asset, -amt, r.to);
        break;
      }
      case "path_payment_strict_send":
      case "path_payment_strict_receive": {
        const recv = fromHorizonAsset(r.asset_type, r.asset_code, r.asset_issuer);
        const sent = fromHorizonAsset(r.source_asset_type, r.source_asset_code, r.source_asset_issuer);
        if (r.from === address) push("path_payment", sent, -toStroops(r.source_amount), r.to);
        if (r.to === address) push("path_payment", recv, toStroops(r.amount), r.from);
        break;
      }
      case "account_merge": {
        const xlm = { code: "XLM", issuer: null };
        if (r.merged_amount == null) {
          unknown.push(`${r.transaction_hash}: account merge without a known amount`);
          break;
        }
        const amt = toStroops(r.merged_amount);
        if (r.into === address) push("account_merge", xlm, amt, r.account);
        if (r.account === address) push("account_merge", xlm, -amt, r.into);
        break;
      }
      case "invoke_host_function": {
        // Net the operation's changes per asset: one leg per asset and direction.
        const net = new Map();
        for (const c of r.asset_balance_changes || []) {
          const asset = fromHorizonAsset(c.asset_type, c.asset_code, c.asset_issuer);
          const k = assetKey(asset.code, asset.issuer);
          const amt = toStroops(c.amount);
          const e = net.get(k) || { asset, delta: 0n, counterparty: null };
          if (c.to === address) { e.delta += amt; e.counterparty ??= c.from || null; }
          if (c.from === address) { e.delta -= amt; e.counterparty ??= c.to || null; }
          net.set(k, e);
        }
        for (const e of net.values()) {
          if (e.delta !== 0n) push("sac_transfer", e.asset, e.delta, e.counterparty);
        }
        break;
      }
      default:
        unknown.push(`${r.transaction_hash}: ${r.type} is not read`);
    }
  }

  for (const t of account.transactions || []) {
    if ((t.fee_account || t.source_account) !== address) continue;
    const fee = BigInt(t.fee_charged);
    if (fee === 0n) continue;
    legs.push({
      tx_hash: t.hash,
      op_index: 0,
      paging: BigInt(t.paging_token) + 4095n, // after the tx's operations
      time: t.created_at,
      memo: null,
      invoice_hash: null,
      kind: "fee",
      asset: { code: "XLM", issuer: null },
      delta: -fee,
      counterparty: null,
      fee: true,
    });
  }
  legs.sort((a, b) => (a.paging < b.paging ? -1 : a.paging > b.paging ? 1 : 0));
  return { legs, unknown };
}

function blindSpots(account, from) {
  const seen = new Set();
  for (const op of account.operations || []) {
    if (new Date(op.created_at) < from) continue;
    if (BLIND_SPOTS[op.type]) seen.add(BLIND_SPOTS[op.type]);
  }
  // A path payment crosses offers too, but the payments feed already has its
  // full effect; only trades caused by anything else are a blind spot.
  const paths = new Set((account.payments || []).filter((r) => r.type.startsWith("path_payment")).map((r) => r.id));
  const blind = (account.trades || []).filter(
    (t) => new Date(t.ledger_close_time) >= from && !paths.has(String(t.id).split("-")[0]),
  );
  if (blind.length) seen.add("traded on the DEX");
  return [...seen];
}

// input: { config, month, fetched_at, accounts: { [address]: {...} }, invoices: { [hash]: number }, rates }
export function buildSnapshot(input) {
  const { config, month, fetched_at: fetchedAt } = input;
  const network = config.network;
  if (!PASSPHRASES[network]) throw new Error(`network must be testnet or mainnet: ${network}`);
  const { start, end } = monthBounds(month);
  const byAddress = new Map(config.wallets.map((w) => [w.address, w]));
  const notes = [];
  let anyCaveat = false;
  let usedRpc = false;

  const wallets = config.wallets.map((w) => {
    const account = input.accounts[w.address] || {};
    const { legs, unknown } = legsFor(w.address, account, config.invoice_contract);
    const spots = blindSpots(account, start);
    const caveats = [];
    if (spots.length) caveats.push(`This wallet ${spots.join(", ")} since the month began, so the balance worked back from today's may be wrong.`);
    if (unknown.length) caveats.push(`Some activity could not be read (${unknown.length} operation(s)), so the balance worked back from today's may be wrong.`);

    if (account.exists === false) notes.push(`${w.name}: the account does not exist on ${network} today.`);
    else if (end <= new Date(fetchedAt)) notes.push(`${w.name}: opening and closing were worked back from today's balance.`);
    else notes.push(`${w.name}: opening was worked back from today's balance; closing is today's balance.`);

    const current = new Map();
    for (const b of account.balances || []) {
      if (b.asset_type === "liquidity_pool_shares") continue;
      const asset = fromHorizonAsset(b.asset_type, b.asset_code, b.asset_issuer);
      current.set(assetKey(asset.code, asset.issuer), { asset, balance: toStroops(b.balance) });
    }

    const perAsset = new Map();
    const slot = (asset) => {
      const k = assetKey(asset.code, asset.issuer);
      if (!perAsset.has(k)) perAsset.set(k, { asset, after: 0n, movements: [], netIn: 0n });
      return perAsset.get(k);
    };
    for (const [, c] of current) slot(c.asset);

    let createdInMonth = false;
    for (const l of legs) {
      const t = new Date(l.time);
      if (t < start) continue;
      const s = slot(l.asset);
      if (t >= end) {
        s.after += l.delta;
        continue;
      }
      if (l.kind === "create_account" && l.delta > 0n) createdInMonth = true;
      s.netIn += l.delta;
      let invoiceRef = null;
      let invoiceSource = null;
      if (l.invoice_hash) {
        usedRpc = true;
        const number = input.invoices && input.invoices[l.invoice_hash];
        if (number) { invoiceRef = number; invoiceSource = "contract"; }
      }
      if (!invoiceRef && !l.fee) {
        const m = memoInvoice(l.memo, config);
        if (m) { invoiceRef = m; invoiceSource = "memo"; }
      }
      const other = l.counterparty && l.counterparty !== w.address ? byAddress.get(l.counterparty) : null;
      s.movements.push({
        tx_hash: l.tx_hash,
        op_index: l.op_index,
        time: l.time,
        direction: l.delta > 0n ? "in" : "out",
        amount: fromStroops(l.delta < 0n ? -l.delta : l.delta),
        counterparty: l.counterparty,
        counterparty_wallet: other && !l.fee ? other.id : null,
        internal: Boolean(other) && !l.fee,
        kind: l.kind,
        memo: l.memo,
        invoice_ref: invoiceRef,
        invoice_ref_source: invoiceSource,
        rate: rateFor(l.asset, network, l.time.slice(0, 10), input.rates),
      });
    }

    const assets = [];
    for (const [k, s] of perAsset) {
      const today = current.has(k) ? current.get(k).balance : 0n;
      const closing = today - s.after;
      const opening = closing - s.netIn;
      if (opening === 0n && closing === 0n && s.movements.length === 0) continue;
      const assetCaveats = [...caveats];
      if (opening < 0n || closing < 0n) {
        assetCaveats.push("The worked-back balance is negative: activity this tool cannot see changed it.");
      } else if (createdInMonth && opening !== 0n) {
        assetCaveats.push("The account was created this month but its worked-back opening is not zero.");
      }
      const caveat = assetCaveats.length ? assetCaveats.join(" ") : null;
      if (caveat) anyCaveat = true;
      assets.push({
        asset: { code: s.asset.code, issuer: s.asset.issuer, contract: sacContractId(s.asset.code, s.asset.issuer, network) },
        opening: fromStroops(opening),
        closing: fromStroops(closing),
        caveat,
        movements: s.movements,
      });
    }
    assets.sort((a, b) => (a.asset.code === "XLM" ? -1 : b.asset.code === "XLM" ? 1 : a.asset.code.localeCompare(b.asset.code)));

    return {
      id: w.id,
      name: w.name,
      purpose: w.purpose ?? null,
      owner: w.owner ?? null,
      network,
      address: w.address,
      gl_account: w.gl_account ?? null,
      assets,
    };
  });

  const snapshot = {
    format: FORMAT,
    month,
    fetched_at: fetchedAt,
    company: config.company,
    reporting_currency: config.reporting_currency || "USD",
    source: {
      kind: usedRpc ? "horizon+rpc" : "horizon",
      network,
      balances: anyCaveat ? "incomplete" : "reconstructed",
      notes,
    },
    wallets,
  };
  if (config.unexplained_threshold != null) snapshot.unexplained_threshold = String(config.unexplained_threshold);
  return snapshot;
}

// Checks the rules of the format that a builder can get wrong. Returns a list
// of problems; empty means the file is consistent.
export function validateSnapshot(s) {
  const problems = [];
  if (s.format !== FORMAT) problems.push(`format is ${s.format}`);
  const { start, end } = monthBounds(s.month);
  for (const w of s.wallets) {
    const seen = new Set();
    const feeTx = new Set();
    for (const a of w.assets) {
      let sum = toStroops(a.opening);
      for (const m of a.movements) {
        const amt = toStroops(m.amount);
        if (amt <= 0n) problems.push(`${w.id} ${m.tx_hash}: amount must be positive`);
        sum += m.direction === "in" ? amt : -amt;
        const t = new Date(m.time);
        if (t < start || t >= end) problems.push(`${w.id} ${m.tx_hash}: time outside ${s.month}`);
        if (m.kind === "fee") {
          if (m.direction !== "out" || m.internal || m.op_index !== 0 || a.asset.code !== "XLM") problems.push(`${w.id} ${m.tx_hash}: malformed fee`);
          if (feeTx.has(m.tx_hash)) problems.push(`${w.id} ${m.tx_hash}: two fees`);
          feeTx.add(m.tx_hash);
          continue;
        }
        const key = `${m.tx_hash}/${m.op_index}/${a.asset.code}:${a.asset.issuer}`;
        if (seen.has(key)) problems.push(`${w.id} ${key}: duplicate movement`);
        seen.add(key);
        if (m.internal !== Boolean(m.counterparty_wallet)) problems.push(`${w.id} ${m.tx_hash}: internal without counterparty_wallet`);
      }
      if (sum !== toStroops(a.closing)) problems.push(`${w.id} ${a.asset.code}: opening + in - out != closing`);
    }
  }
  return problems;
}
