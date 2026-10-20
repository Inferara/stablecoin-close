# `haruno.stellar.month/1` — one company's Stellar wallets for one month

A connector writes one file per company per calendar month (UTC), and Haruno's
books engine reads it on close. The file is the whole contract between the two:
neither side reads the other's code or data. `tools/fetcher` in this repository
is an open reference implementation of the writing side.

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
              "rate": { "usd": "1", "jpy": "151.20", "source": "par;frankfurter.app" }
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
- `invoice_ref_source`: `contract` (an `invoice_paid` event of the configured
  invoice contract — high confidence), `memo` (parsed from the memo — low
  confidence), or `null` with `invoice_ref: null`.
- `rate.usd` is the USD value of one unit at `time`; `rate.jpy` the JPY value of one
  unit. `rate.source` names where each number came from.
- `gl_account` is the books account the wallet maps to, by name; `null` means
  "not mapped" (no reconciliation row, a note instead).
- Addresses are public keys only (`G…` accounts, `C…` contracts). No secret
  material ever appears in this file.
- `asset.code` is `XLM` with `issuer: null` for the native asset.
- `unexplained_threshold` (optional, decimal string in the reporting currency)
  is the company's setting for the books' unexplained-movement check: a
  non-internal movement whose value reaches it and that nothing explains is a
  finding. Absent means the books' own default.
- One file holds all of the company's wallets. `source.network` is `testnet` or
  `mainnet` when every wallet is on that network (each wallet must then match),
  and `mixed` when both appear. Internal transfers never cross networks. A file
  with any testnet wallet is noted as such on close.
- `source.kind` names the services read, joined with `+` (`horizon`, `rpc`).
  `source.balances` is `current`, `reconstructed` (worked back from today's
  balance) or `incomplete` (at least one wallet-asset has a `caveat`).
  `source.notes` are sentences for the reader, including a wallet whose last
  sync failed (its month is the one it had before).
- A wallet-asset may carry `"caveat": "<sentence>"` (absent or `null` when there
  is none). The connector sets it when it knows `opening`/`closing` may be wrong,
  for example when the wallet traded on the DEX, held claimable balances, was
  clawed back, or used a liquidity pool, so the balance worked back from today's
  cannot be trusted. The books never mark such a wallet-asset reconciled: its
  reconciliation row is an exception carrying the sentence.
- An unknown rate is `"0"` and `rate.source` says which side is unknown
  (`unpriced` for USD, `unpriced-jpy` for JPY). `"0"` there means unknown, never
  worthless.
