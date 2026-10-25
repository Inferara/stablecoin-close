# Demo month on testnet

[`bin/stage-testnet.mjs`](bin/stage-testnet.mjs) puts a month of a small company's
stablecoin activity on Stellar testnet, so a close can be run on real ledger data:
the "Lisbon Coffee Roasters" month the demo uses, scaled down 100× so faucet amounts are
enough.

```sh
cd tools/demo && npm ci
node bin/stage-testnet.mjs                 # keys lcr-*, state in out/lcr.json
node bin/stage-testnet.mjs --prefix lcr2   # a second company from scratch
```

Requirements: Node 20+, [stellar-cli](https://github.com/stellar/stellar-cli/releases) 28+.
Keys are created in the stellar CLI's keystore and never written here. `out/` is not
committed: it holds the state (wallet addresses and transaction hashes), the fetcher
config, and the invoice salt, which is secret (`DEMO_INVOICE_SALT` uses a salt the
books already have instead).

## What it does

| Wallet | Funded by | Role |
|---|---|---|
| funder | friendbot | Opens the company's wallets; pays the rent for registering invoices, so the company's books do not carry it. Not the company's. |
| customer | friendbot | Pays the company; buys its USDC on the testnet DEX. Not the company's. |
| Treasury | funder, 60 XLM | Receivables; the merchant on InvoiceSettlement. Books account `USDC Treasury`. |
| Payroll | funder, 5 XLM | Books account `Payroll Wallet`. |
| Team | funder, 5 XLM | Books account `Employee advances`. |
| Treasury investments | Treasury, 40 XLM | Holds a tokenised bond. Books account `Short-term investments`. |

Movements, all in October:

| # | Movement | What a close should show |
|---|---|---|
| 1 | customer pays INV-1001, 12 USDC, through `pay_invoice` | matched through the contract |
| 2 | customer pays 8 EURC, memo `INV1002` | matched by memo, low confidence |
| 3 | customer pays 3 USDC, no memo | unexplained receipt |
| 4 | Treasury to Payroll, 5 USDC | internal |
| 5 | Treasury to Team, 2 USDC | internal |
| 6 | Treasury opens Treasury investments with 40 XLM | internal |
| 7 | Treasury investments buys Etherfuse sandbox CETES for 20 XLM, paying itself | a conversion; CETES is a bond valued at mainnet CETES's price |

INV-1003 (5 USDC) and INV-1004 (4 USDC) are registered and left open; the script prints
their payer page links. `--pay-on-page` leaves INV-1001 open too, to pay it from the page.

Step 2 needs EURC, which has no testnet market: the script waits until the customer
holds 8 EURC from [Circle's faucet](https://faucet.circle.com) (Stellar testnet) and
prints the address to fund. Run it again afterwards.

Then write the month with the fetcher:

```sh
cd ../fetcher && node bin/fetch-month.mjs --config ../demo/out/lcr.fetcher-config.json --month 2026-10
```

The run of 2026-10-25 is recorded in
[`tools/fetcher/test/fixtures/testnet-lcr-2026-10.input.json`](../fetcher/test/fixtures/testnet-lcr-2026-10.input.json),
and its snapshot is [`docs/examples/lisbon-coffee-roasters-2026-10.json`](../../docs/examples/lisbon-coffee-roasters-2026-10.json).
