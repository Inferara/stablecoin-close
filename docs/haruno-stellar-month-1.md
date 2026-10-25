# `haruno.stellar.month/1` — one company's Stellar wallets for one month

A connector writes one file per company per calendar month (UTC), and a reader
(Haruno's books engine, or anything else) consumes it. The file is the whole
contract between the two: neither side reads the other's code or data.
`tools/fetcher` in this repository is an open reference implementation of the
writing side.
[`docs/examples/lisbon-coffee-roasters-2026-10.json`](examples/lisbon-coffee-roasters-2026-10.json)
is a real month on testnet as it writes it, including a tokenised bond.

## Shape

```json
{
  "format": "haruno.stellar.month/1",
  "month": "2026-10",
  "fetched_at": "2026-10-20T09:15:00Z",
  "company": "lisbon-coffee-roasters",
  "reporting_currency": "USD",
  "source": {
    "kind": "horizon+rpc",
    "network": "testnet",
    "balances": "reconstructed",
    "notes": ["Treasury: opening and closing were worked back from today's balance."]
  },
  "wallets": [
    {
      "id": "w-1",
      "name": "Treasury",
      "purpose": "receivables",
      "owner": null,
      "network": "testnet",
      "address": "G...",
      "gl_account": "USDC Treasury",
      "assets": [
        {
          "asset": { "code": "USDC", "issuer": "G...", "contract": "C..." },
          "opening": "0.0000000",
          "closing": "1200.0000000",
          "closing_rate": { "usd": "1", "jpy": "152.10", "source": "par;frankfurter.dev 2026-10-23" },
          "movements": [
            {
              "tx_hash": "64 hex",
              "op_index": 0,
              "time": "2026-10-05T10:00:00Z",
              "direction": "in",
              "amount": "1200.0000000",
              "counterparty": "G...",
              "counterparty_wallet": null,
              "internal": false,
              "kind": "payment",
              "memo": "INV-1001",
              "invoice_ref": "INV-1001",
              "invoice_ref_source": "contract",
              "rate": { "usd": "1", "jpy": "151.20", "source": "par;frankfurter.dev 2026-10-05" }
            }
          ]
        }
      ]
    }
  ]
}
```

## Rules

- Amounts and rates are decimal **strings** (Stellar has 7 decimal places; a JSON
  number would lose them). `amount` is always positive; `direction` is `in` or `out`.
- `month` is `YYYY-MM`; every movement's `time` falls inside it (UTC). `fetched_at`
  is RFC 3339. A later `fetched_at` for the same company and month supersedes.
- Per wallet and asset: `opening + Σ in − Σ out = closing`, exactly. A file that
  does not add up is refused.
- `(tx_hash, op_index, wallet id, asset)` is unique within a file among
  non-fee movements.
- `kind`: `payment`, `path_payment`, `create_account`, `account_merge`,
  `sac_transfer`, `fee`.
- A `fee` movement is the transaction fee the wallet paid: native XLM,
  direction `out`, never internal, `op_index` 0, at most one per
  `(tx_hash, wallet id)`. It never collides with the operations of the same
  transaction.
- A `path_payment` sends one asset and delivers another, so its two legs may
  differ in asset and amount; every other internal movement's legs carry the
  same asset and amount.
- A `path_payment` from a wallet to itself converts one asset into another: both
  legs sit in that wallet, each with `counterparty` the wallet's own `address` and
  `internal: false`. A movement whose counterparty is its own wallet's address is
  a conversion, never income, expense, or unexplained.
- `internal: true` when the counterparty is another wallet of the same company in
  this file; `counterparty_wallet` then names its `id`. Both legs appear, one per
  wallet. Internal movements are never income, expense, or unexplained.
- `invoice_ref_source`: `contract` (taken from the configured invoice contract:
  its `invoice_paid` event or the `pay_invoice` call that moved the funds — high
  confidence), `memo` (parsed from the memo — low confidence), or `null` with
  `invoice_ref: null`.
- `rate.usd` is the USD value of one unit at `time`; `rate.jpy` the JPY value of one
  unit. `rate.source` names where each number came from (for example
  `par;frankfurter.dev 2026-10-05`: USD at par, JPY from frankfurter.dev's rate
  for that date).
- Every wallet-asset carries `closing_rate`, the same shape as a movement's
  `rate`, priced at the month's last moment (23:59:59 UTC of its last day), or at
  `fetched_at` while the month runs. It values `closing`, even when the asset did
  not move that month.
- `gl_account` is the books account the wallet maps to, by name; `null` means
  "not mapped": a reader has nothing to reconcile it against and should say so.
- Addresses are public keys only (`G…` accounts, `C…` contracts). No secret
  material ever appears in this file.
- `asset.code` is `XLM` with `issuer: null` for the native asset.
- `unexplained_threshold` (optional, decimal string in the reporting currency)
  is the company's setting for unexplained movements: a reader should flag a
  non-internal movement whose value reaches it and that nothing explains.
  Absent means the reader's own default.
- One file holds all of the company's wallets. `source.network` is `testnet` or
  `mainnet` when every wallet is on that network (each wallet must then match),
  and `mixed` when both appear. Internal transfers never cross networks. A reader
  should make it visible when a file has any testnet wallet.
- `source.kind` names the services read, joined with `+` (`horizon`, `rpc`).
  `source.balances` is `current`, `reconstructed` (worked back from today's
  balance) or `incomplete` (at least one wallet-asset has a `caveat`).
  `source.notes` are sentences for the reader, including a wallet whose last
  sync failed (its month is the one it had before).
- A wallet-asset may carry `"caveat": "<sentence>"` (absent or `null` when there
  is none). The connector sets it when it knows `opening`/`closing` may be wrong,
  for example when the wallet traded on the DEX, held claimable balances, was
  clawed back, or used a liquidity pool, so the balance worked back from today's
  cannot be trusted. A reader must not treat such a wallet-asset as reconciled,
  and should show the sentence.
- An unknown rate is `"0"` and `rate.source` says which side is unknown
  (`unpriced` for USD, `unpriced-jpy` for JPY). `"0"` there means unknown, never
  worthless.

## Tokenised real-world assets (optional fields)

A writer that recognises a tokenised real-world asset (a fund share, a bond, a
gold token) may say so with three optional fields. A reader that does not know
them ignores them; nothing else in the file changes. The open registry in
[`registry/stellar-rwa.json`](../registry/stellar-rwa.json) is one source of this
knowledge; `tools/fetcher` writes these fields for the assets it lists.

```json
{
  "asset": {
    "code": "CETES",
    "issuer": "GC3CW7EDYRTWQ635VDIGY6S4ZUF5L6TQ7AA4MWS7LEQDBLUSZXV7UPS4",
    "contract": "C...",
    "class": "bond",
    "priced_as": { "network": "mainnet", "code": "CETES", "issuer": "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC" }
  },
  "closing_rate": {
    "usd": "0.063628", "jpy": "9.677819", "basis": "market",
    "source": "mainnet-twin;market;redstone 2026-10-25T09:05:00Z;frankfurter.dev 2026-10-23"
  }
}
```

- `asset.class` is `fund_share`, `bond`, `commodity` or `stablecoin`: what the
  token is a claim on. It is matched by code **and** issuer (or contract), never by code alone, since
  anyone can issue an asset of any code.
- `asset.priced_as` names the mainnet asset whose price values a **testnet**
  token. There is no testnet market, so a test token from an issuer's sandbox is
  valued at its mainnet twin's price; the rate's `source` then starts with
  `mainnet-twin`. A reader should say so wherever it shows the value.
- `rate.basis` (on a movement's `rate` or a `closing_rate`) says what kind of value
  the USD number is: `nav` (the issuer's net asset value or redemption value, for
  example from an oracle's FUNDAMENTAL feed), `fixed_nav` (a fund with a stated
  stable NAV, such as 1.00), or `market` (a traded price, used only where the market
  tracks the value closely), or `par` (a stablecoin at its peg). Absent means the writer did not say; `source` still
  names where the number came from. A traded price is never a fund share's NAV.
