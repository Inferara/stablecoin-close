# stablecoin-close

Open parts of [Haruno](https://haruno.ai)'s stablecoin month-end close on Stellar:
two Soroban contracts, the two public web pages that go with them, the
`haruno.stellar.month/1` snapshot format, and a reference fetcher that writes it.

Built for HackMeridian 2026 (Scale track).

## For judges: five minutes

| | |
|---|---|
| Demo video | _added with the submission on Oct 26_ |
| Pitch deck (PDF) | _added with the submission on Oct 26_ |
| What changed at the event | [compare `pre-hackmeridian...main`](https://github.com/Inferara/stablecoin-close/compare/pre-hackmeridian...main), and [Built at HackMeridian](#built-at-hackmeridian-october-25-26) below |

Try it in the browser; nothing to install:

1. **RWA values on mainnet.** Open the [RWA values page](https://inferara.github.io/stablecoin-close/pages/rwa/): Stellar's tokenised funds, bonds and gold, each valued from the issuer's NAV on chain or its stated NAV, with the DEX price beside it.
2. **Pay an invoice.** Open the [open demo invoice](https://inferara.github.io/stablecoin-close/pages/payer/?invoice=14743a09ff3744e5b12f7736e02e9627a520f8a442100d2359371bde2de44e39&merchant=GD2HID4AHAGP3ELHAROKJU4PAHZT2PCTBIDODI5MWPDFPKDMBAAZJH4Q) (5.00 USDC on testnet). It shows the invoice without a wallet (once someone has paid it, who paid and when); paying needs [Freighter](https://freighter.app) on Testnet with test USDC.
3. **Verify a closed month.** Open the [verifier for September 2026](https://inferara.github.io/stablecoin-close/pages/verifier/?company=346c9389e34031e562c9dec42d2178b7dc7d2e87d0e2f9e452986f2da210fe7f&period=2026-09) and click "Try it with a sample report": the PDF is hashed in your browser and checked against the hash anchored on testnet.

In code: the two contracts in [`contracts/`](contracts/) (`cargo test`), the snapshot format in
[`docs/haruno-stellar-month-1.md`](docs/haruno-stellar-month-1.md) with a
[real month written in it](docs/examples/lisbon-coffee-roasters-2026-10.json), and the fetcher in
[`tools/fetcher`](tools/fetcher/) (`npm test`, no network needed).

## The problem

A company that is paid in stablecoins (USDC, EURC) on Stellar, often into several
wallets, closes its books every month. Today the wallets are invisible to the books.
Someone exports a CSV from an explorer, matches payments to invoices by hand,
guesses the accounting treatment, and nobody can later check the result.

Haruno is an existing accounting-review app. For this, a connector writes a
verified monthly snapshot of the company's Stellar wallets, and Haruno's books
engine reconciles it against the books and open invoices. This repository holds
the parts anyone can use or check without Haruno:

| Path | What it is |
|---|---|
| [`contracts/invoice-settlement`](contracts/invoice-settlement/src/lib.rs) | `InvoiceSettlement`: register an invoice by hash; pay it in one call that sends the registered amount of the registered asset to the merchant and emits `invoice_paid`. |
| [`contracts/report-anchor`](contracts/report-anchor/src/lib.rs) | `ReportAnchor`: record the SHA-256 of a signed-off close report, one per company and month. |
| [`pages/payer`](pages/payer/) | Static page a customer opens from an invoice link or QR code: shows the invoice, connects Freighter, pays. [Live](https://inferara.github.io/stablecoin-close/pages/payer/) |
| [`pages/anchor`](pages/anchor/) | Static page where the reviewer signs off a month: their own wallet anchors the report hash. [Live](https://inferara.github.io/stablecoin-close/pages/anchor/) |
| [`pages/verifier`](pages/verifier/) | Static page where anyone drops in a report PDF and sees whether it matches the anchored hash. [Live](https://inferara.github.io/stablecoin-close/pages/verifier/) |
| [`pages/rwa`](pages/rwa/) | Static page showing Stellar's tokenised real-world assets valued live on mainnet: the issuer's NAV from RedStone on chain or the stated NAV, the DEX price beside it, and the value on Stellar. [Live](https://inferara.github.io/stablecoin-close/pages/rwa/) |
| [`docs/haruno-stellar-month-1.md`](docs/haruno-stellar-month-1.md) | The monthly snapshot format a connector writes. |
| [`tools/fetcher`](tools/fetcher/) | Reference CLI that writes that snapshot from public addresses. |
| [`docs/examples`](docs/examples/lisbon-coffee-roasters-2026-10.json) | A snapshot of the demo company's October on testnet, as the fetcher wrote it. |
| [`tools/demo`](tools/demo/) | Stages that demo month on testnet: wallets, invoices, payments, internal transfers and a tokenised bond. |
| [`tools/deploy`](tools/deploy/bin/deploy.mjs) | Uploads, deploys and extends the contracts on testnet with fee-bump transactions. |
| [`registry/stellar-rwa.json`](registry/) | Open registry of tokenised real-world assets on Stellar (USDY, BENJI, WTGX, Etherfuse stablebonds, XAUm, and the USDT0 stablecoin): what each is, and where a real value for it comes from. |
| [`deployments/testnet.json`](deployments/testnet.json) | Contract ids on testnet. |

## Prior art, and how Haruno differs

Invoice settlement on Stellar is well covered at hackathons: StellarInvoice,
InvoiceVeil, Obscura, BatchGuard ZK, Settler, ProofPay, SettleZK, Cloakpay and
Payfurt, among others. `InvoiceSettlement` here is a supporting piece, not the
novelty; it exists so that a paid invoice leaves an event the books can match with
certainty.

Closer to what Haruno does:

| Project | What it does |
|---|---|
| Trexure | Turns a privacy-shielded Stellar payment into accounting-ready output |
| AutoBooks | AI agents sell accounting data and ledger reconciliations via x402 |
| KwickBit | DeFi accounting and reconciliation (SCF-funded; last activity Jul 2025) |
| Bitwave | Enterprise transaction sync, XLM-focused |
| LedgersTax, Kryptos | Retail tax exports |
| Smart Treasury | Programmable treasury account on Soroban smart accounts: money movement, not accounting. Complementary. |

Sync tools copy transactions into a ledger. Haruno reviews: it reconciles several
wallets against the books and open invoices, raises findings in plain language
(a receipt with no invoice, a memo that does not match, a balance that does not
agree), classifies holdings per accounting standard, and produces a signed-off
close whose report hash anyone can verify here. Haruno is an existing product
with users, and this repository is the open slice of a feature in it.

## How it fits together

```
 customer ──pay_invoice──▶ InvoiceSettlement ──SAC transfer──▶ merchant wallet
                               │ invoice_paid event
                               ▼
 company wallets ──Horizon/RPC──▶ connector ──haruno.stellar.month/1──▶ Haruno books engine
                                                                          │ signed-off report
 reviewer wallet ──anchor(company, month, sha256)──▶ ReportAnchor ◀───────┘
                                                        ▲
 anyone with the PDF ──── verifier page ────────────────┘
```

Nothing on chain identifies a person or a company: invoices are keyed by a hash,
companies by a hash the company chooses.

## Contracts

### InvoiceSettlement

| Function | Auth | Effect |
|---|---|---|
| `register_invoice(merchant, invoice_number, invoice_hash, asset, amount, due)` | merchant | Stores the invoice as `Open`. Refuses a hash already registered, `amount <= 0`, an empty number. |
| `pay_invoice(payer, invoice_hash)` | payer | Transfers `amount` of `asset` (a Stellar Asset Contract) from payer to merchant, marks the invoice `Paid`, emits `invoice_paid`. Refuses an unknown invoice and one already paid. |
| `status(invoice_hash)` | none | `Open` or `Paid { payer, ledger, timestamp }`. |
| `get_invoice(invoice_hash)` | none | Everything registered, plus the status (what the payer page shows). |

Errors: `#1` unknown invoice, `#2` hash already registered, `#3` already paid,
`#4` amount not positive, `#5` empty invoice number.

The payer never passes an asset or an amount: `pay_invoice` uses the registered
ones, so a wrong asset or a wrong amount cannot happen rather than being detected.
A late payment is accepted (`due` is informational), because refusing it would only
leave the debt open. The invoice is marked paid before the token call; if the
transfer fails, the whole transaction reverts and it stays open.

**The `invoice_paid` event** (Haruno matches on this exact shape):

- topics: `[Symbol("invoice_paid"), String(invoice_number)]`
- data: map `{ amount: i128, asset: Address, invoice_hash: BytesN<32>, payer: Address }`

`invoice_registered` is published on registration with the same topic layout.

**`invoice_hash`** is the SHA-256 of a canonical reference string that starts
with a secret salt:

```
<salt>|<company_id>|<invoice_number>|<amount in stroops>|<asset contract id>
```

The salt is a random value only the merchant (its books) knows. It never goes on
chain or into a link. Without it, a company id and sequential invoice numbers are
easy to guess, and someone could compute an invoice's hash and register it first
with themselves as the merchant. Amounts are in the asset's smallest unit (7
decimals for Stellar assets). No customer name or other personal data goes into
the string. The contract cannot recompute the hash; the merchant's books can, which
is what ties an `invoice_paid` event back to an invoice.

Worked example (the salt here is made up for the example; it is checked by a unit
test):

```sh
printf '%s' 'example-salt-do-not-use|lisbon-coffee-roasters|INV-1001|12000000000|CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA' | sha256sum
# 4d6fde0e27fdb232a88e98a58f17a61b4b0909881935a3b21975294d0936d569
```

A payment link carries the invoice hash **and the merchant's address**
(`&merchant=G…`); the payer page refuses to pay when the registered merchant is a
different address. That also covers a leaked salt.

Haruno, or any other reader, should only match an `invoice_paid` event whose `asset`
is a Stellar Asset Contract it expects (for example Circle's USDC), since a merchant
can register an invoice in any token.

### ReportAnchor

| Function | Auth | Effect |
|---|---|---|
| `anchor(signer, company_id_hash, period, report_sha256)` | signer | Records the hash with the signer, ledger and time. `period` is `YYYY-MM`. One anchor per company and period: a second call is refused, whatever its hash. |
| `get(company_id_hash, period)` | none | `Option<{ report_sha256, signer, ledger, timestamp }>` |
| `owner(company_id_hash)` | none | `Option<Address>`: who may anchor this company's periods |
| `transfer_owner(company_id_hash, new_owner)` | current owner | Hands the company to another signer. Earlier anchors keep their signer. |

Errors: `#1` period already anchored, `#2` period not `YYYY-MM`, `#3` not the
company's owner, `#4` unknown company (for `transfer_owner`).

Event `anchored`: topics `[Symbol("anchored"), BytesN<32>(company_id_hash), String(period)]`,
data map `{ report_sha256, signer }`. Event `owner_changed`: topics
`[Symbol("owner_changed"), BytesN<32>(company_id_hash)]`, data map `{ new_owner, old_owner }`.

**Owner binding.** The first anchor of a company makes its signer the company's
owner, and only the owner can anchor later periods. A company id hash is public
after its first anchor (it is an event topic and part of every verifier link), so
without this anyone could anchor the company's next months first with junk. To
change reviewer, the owner calls `transfer_owner`; if the owner's key is lost,
there is no recovery in this version, and the company continues under a new
`company_id_hash` (a new salt). A smart-account owner (passkeys, several signers)
avoids that and is the planned next step.

`company_id_hash` should be salted (for example SHA-256 of `<secret salt>|<company id>`)
so that nobody can find a company's anchors by guessing its id. A correction to an
anchored month is disclosed in the next month's report; the original anchor stays.
Anchoring is meant to be signed by the reviewer's own wallet, not by a key Haruno holds.

### Testnet deployment

| Contract | Id |
|---|---|
| InvoiceSettlement | [`CB4SGMUT56YKMYQWOQN2T3FTBZOJBZHYUYYV6QTVTJGGCYLWIIDOBPWB`](https://stellar.expert/explorer/testnet/contract/CB4SGMUT56YKMYQWOQN2T3FTBZOJBZHYUYYV6QTVTJGGCYLWIIDOBPWB) |
| ReportAnchor | [`CAU56RULWM446LJCYIRMWIJSBL4NE5DBLTHJ4GPXTKUVQ7BUYTQAZ2CS`](https://stellar.expert/explorer/testnet/contract/CAU56RULWM446LJCYIRMWIJSBL4NE5DBLTHJ4GPXTKUVQ7BUYTQAZ2CS) |

Built with Rust 1.95.0 (pinned in `rust-toolchain.toml`), soroban-sdk 29.0.1 and
stellar-cli 28.1.0. The deployed code is reproducible on Linux x86_64 as CI builds it:
`stellar contract build --locked` there gives the wasm hashes in
`deployments/testnet.json`, and every CI run checks that. (A build on another host OS
can order a few internal functions differently and so hash differently, with the same
behavior.)

**Storage lifetime and rent.** Rent is paid for the time a ledger entry is kept alive.
An invoice, anchor or owner entry, and the contract instance with its code, that is
read or written with less than about 7 days left is extended to about 30 days; most
calls extend nothing. Anyone can extend an entry further with an `ExtendFootprintTTL`
operation, and an entry that expires is archived, not deleted, and can be restored.
On testnet on 2026-10-25 a new invoice cost about 70 XLM in rent and fees, and a
company's first anchor about 89 XLM. (The first deployment extended everything to the
network maximum, about 6 months. That made the same calls 400 and 510 XLM, and the
second was over the most a transaction fee can be, so it could not be submitted at all.)

The instance and code were extended to about ledger 5,902,900 (around November 24, 2026).
At today's testnet rent, extending code costs thousands of XLM, more than a plain
transaction can pay, so they must be extended with
[`tools/deploy`](tools/deploy/bin/deploy.mjs) (fee-bump transactions) before about
November 17, when calls would otherwise start to extend them themselves:

```sh
cd tools/deploy && npm ci
node bin/deploy.mjs --key <stellar CLI key> --extend CB4SGMUT56YKMYQWOQN2T3FTBZOJBZHYUYYV6QTVTJGGCYLWIIDOBPWB --extend CAU56RULWM446LJCYIRMWIJSBL4NE5DBLTHJ4GPXTKUVQ7BUYTQAZ2CS
```

Testnet is reset from time to time; after a reset the ids change and
`deployments/testnet.json` is updated. Superseded deployments are listed there. The one
before this, from 2026-10-20 (`CAXZMH…RCBU`, `CDHTWZ…MOAN`), stays live until April 2027;
the payer page still accepts invoices registered on its InvoiceSettlement.

Round trip on testnet on 2026-10-25 with Circle's testnet USDC
(SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`); the demo invoices
use a salt that is not published:

- `INV-DEMO-0004`, 5.00 USDC, [registered](https://stellar.expert/explorer/testnet/tx/9013a2fd8bf835ba5d5d37be299f3873c57654115f9857788f898a2c6fc1e120)
  by a demo merchant that is not one of the demo company's wallets, and left open for
  trying the payer page:
  [`pages/payer/?invoice=14743a09…&merchant=GD2HID…`](https://inferara.github.io/stablecoin-close/pages/payer/?invoice=14743a09ff3744e5b12f7736e02e9627a520f8a442100d2359371bde2de44e39&merchant=GD2HID4AHAGP3ELHAROKJU4PAHZT2PCTBIDODI5MWPDFPKDMBAAZJH4Q)
- [`pages/verifier/sample-report.pdf`](pages/verifier/sample-report.pdf) is [anchored](https://stellar.expert/explorer/testnet/tx/0b8674609c73bad2f74ccf6ba33214c4c490127449b4d139273ba0fab9383d84)
  for period `2026-09`; the [verifier page](https://inferara.github.io/stablecoin-close/pages/verifier/?company=346c9389e34031e562c9dec42d2178b7dc7d2e87d0e2f9e452986f2da210fe7f&period=2026-09)'s
  "Try it with a sample report" link checks it. Anchoring `2026-10` for the same
  company from another account simulates to `Error(Contract, #3)`.

The first deployment's round trip on 2026-10-20 (INV-DEMO-0001
[paid](https://stellar.expert/explorer/testnet/tx/bdf187262e9a5720d0e13140b4d1b45a274a1ec0d57041e3dd9c6e8a503a85e2)
from a transaction the payer page built) is on the superseded InvoiceSettlement.

## Pages

Live on GitHub Pages: [payer](https://inferara.github.io/stablecoin-close/pages/payer/),
[anchor](https://inferara.github.io/stablecoin-close/pages/anchor/),
[verifier](https://inferara.github.io/stablecoin-close/pages/verifier/),
[RWA values](https://inferara.github.io/stablecoin-close/pages/rwa/).

The RWA values page reads mainnet, not testnet: the registry's oracles over a public
mainnet RPC (`https://mainnet.sorobanrpc.com`) and the DEX and supply from Horizon. It
needs no wallet and signs nothing.

Plain HTML and JavaScript, no build step. They talk to Soroban RPC
(`https://soroban-testnet.stellar.org`) directly from the browser and load
`@stellar/stellar-sdk@17.2.1` and `@stellar/freighter-api@6.0.1` from jsDelivr
with subresource integrity. Signing is done with Freighter for now; signing with a
passkey smart account is the next step.

- **Payer** — `pages/payer/?invoice=<hash>&merchant=<G… address>` (only the InvoiceSettlement contracts published in `deployments/testnet.json` are accepted: the current one and the one before it).
  Shows the invoice number, amount, asset (with its contract id), merchant and due
  date; connects [Freighter](https://freighter.app) (set to Testnet); checks the
  wallet's balance; builds `pay_invoice`, simulates it, asks Freighter to sign,
  submits, and shows a success screen with a StellarExpert link. A paid invoice shows
  who paid and when. The wallet needs a USDC trustline. The page offers no Pay button
  when the link names no merchant or a merchant other than the registered one, when
  `contract` is not the InvoiceSettlement deployed here, or when the asset is not one
  it knows (USDC and EURC on testnet; a token's own name is not trusted). Before asking
  Freighter to sign, it checks the simulated transaction: one `pay_invoice` call for
  this invoice from your wallet, authorizing exactly one transfer of the shown amount
  of the shown asset to the shown merchant, and nothing else.
- **Anchor (sign-off)** — opened by Haruno when a close is signed off; see the URL
  contract below. Shows the period and the two hashes (shortened, with copy buttons)
  and the contract; connects Freighter, builds `anchor(signer, company_id_hash, period,
  report_sha256)` through the same simulate, sign and submit path as the payer page,
  and ends on a success screen with the transaction link and a ready verifier link for
  that company and period. If the period is already anchored it shows that anchor
  instead, and whether it matches the given report hash, and offers nothing to sign.
  When the company already has an owner and the connected wallet is someone else, it
  says which wallet signs for the company instead of offering to sign.
- **Verifier** — `pages/verifier/?company=<company_id_hash>&period=<YYYY-MM>[&contract=<id>]`.
  Drop a PDF (or tap to pick one); it is hashed in the browser with WebCrypto and
  never uploaded. The page shows "Matches the anchored report", "Does not match" or
  "Nothing anchored", with the time, ledger, signer and an explorer link.

### Haruno opens the anchor page

```
pages/anchor/?company=<company_id_hash>&period=<YYYY-MM>&report=<report_sha256>&contract=<ReportAnchor id>&network=testnet
```

| Parameter | Required | Rule |
|---|---|---|
| `company` | yes | 64 hex characters: the company id hash, used as given |
| `period` | yes | `YYYY-MM`, month 01-12 |
| `report` | yes | 64 hex characters: SHA-256 of the report PDF |
| `contract` | no | a `C…` contract id; defaults to the testnet ReportAnchor above, and any other id is shown with a warning |
| `network` | no | `testnet` (the only one supported); anything else is refused |

Every parameter is checked before anything is shown; an invalid link lists what is
wrong and offers nothing to sign. The URL carries hashes only, nothing personal. The
page never derives `company_id_hash`: how the caller computes it, and with which salt,
is up to the caller. The verifier page takes the same `company`, `period`, `contract`
and `network` parameters.

Run them locally from the repository root:

```sh
python -m http.server 8000
# http://localhost:8000/pages/payer/?invoice=14743a09ff3744e5b12f7736e02e9627a520f8a442100d2359371bde2de44e39&merchant=GD2HID4AHAGP3ELHAROKJU4PAHZT2PCTBIDODI5MWPDFPKDMBAAZJH4Q
# http://localhost:8000/pages/verifier/
# http://localhost:8000/pages/anchor/?company=346c9389e34031e562c9dec42d2178b7dc7d2e87d0e2f9e452986f2da210fe7f&period=2026-09&report=f9103bbedcc8c3732c6184f94ef9a4fcb1d929d8517443e58df80594fc872a39
```

Any static host works; serve the repository root so that `pages/shared/` resolves.
The live copies above are this repository's `main` on GitHub Pages.

## Snapshot format and reference fetcher

[`docs/haruno-stellar-month-1.md`](docs/haruno-stellar-month-1.md) specifies
`haruno.stellar.month/1`: one company's wallets for one calendar month, with opening
and closing balance per wallet and asset, every movement with its counterparty, memo,
invoice reference and rate, internal transfers marked on both legs, and the rule that
`opening + in - out = closing` exactly.

[`tools/fetcher`](tools/fetcher/) writes such a file from public addresses (Node 20+):

```sh
cd tools/fetcher
npm ci
node bin/fetch-month.mjs --config test/fixtures/testnet-config.json --month 2026-10 --out 2026-10.json
npm test
```

The config names the company, network, wallets (`id`, `name`, `purpose`, `address`,
`gl_account`) and optionally the `invoice_contract`. What it does and does not do:

- Reads Horizon's payments feed (payments, path payments, account creation and merge,
  and SAC transfers from contract calls) and the transactions the wallet paid fees for.
- `pay_invoice` calls on the configured contract are matched to their invoice number
  through `get_invoice` over RPC (`invoice_ref_source: "contract"`); otherwise an
  `INV-…` reference in the memo is used (`"memo"`, low confidence).
- Balances are worked back from today's balance. If the wallet traded on the DEX
  (outside its own path payments), used claimable balances or liquidity pools, or was
  clawed back during or after the month, the affected assets get a `caveat` and the
  file is marked `incomplete`; the fetcher does not try to reconstruct those.
- USDC and EURC (Circle's issuers on testnet and mainnet) are valued at par with USD
  and EUR, with EUR→USD and →JPY rates from [frankfurter.dev](https://frankfurter.dev)
  (ECB reference rates, business days). That is a peg assumption, not a market price.
- Tokenised real-world assets listed in the [registry](registry/) are valued from the
  sources it names: RedStone's on-chain feeds (the issuer's NAV for USDY and XAUm),
  a stated fixed NAV (BENJI, WTGX), and CoinGecko's public daily history for days the
  oracle no longer holds; Rumblefish too when `RUMBLEFISH_API_KEY` is set. A testnet
  token from Etherfuse's sandbox is valued at its mainnet twin's price and says so.
  These holdings carry `asset.class`, and their rates `basis`. Every other asset, XLM
  included, is written as unpriced (`"0"`).
- Every wallet-asset carries a `closing_rate`: the value at the month's end, or now
  while the month runs.
- Mainnet works the same way, except that SDF runs no public mainnet RPC: set `rpc_url`
  to read invoice numbers there.

The tests replay a recorded testnet month (the round trip above) and synthetic cases;
they need no network.

## Build, test, deploy

Requirements: Rust with the `wasm32v1-none` target, [stellar-cli](https://github.com/stellar/stellar-cli/releases) 28+.

```sh
cargo test                      # contract unit tests
stellar contract build          # target/wasm32v1-none/release/*.wasm
```

To deploy on testnet, use the wasm CI publishes (the `contracts-wasm` artifact of a CI
run), so the hashes match `deployments/testnet.json`. Uploading code there now costs
more than a plain transaction's fee can be, so `tools/deploy` sends fee-bump
transactions. A friendbot account holds 10,000 XLM; on 2026-10-25 the two uploads, two
deployments and two 30-day extensions took about 20,400 XLM, so merge a few funded
accounts into the deployer first:

```sh
stellar keys generate deployer --network testnet --fund
cd tools/deploy && npm ci
node bin/deploy.mjs --key deployer --wasm-dir <unzipped contracts-wasm>
```

Keys stay in the stellar CLI's own configuration or in your wallet. None belongs in
this repository.

## Starting point vs built at HackMeridian

HackMeridian 2026 ran on site in Lisbon on October 25-26. The tag
[`pre-hackmeridian`](https://github.com/Inferara/stablecoin-close/tree/pre-hackmeridian)
marks where this repository stood when the event began; everything after it was
built at the event:
[**compare `pre-hackmeridian...main`**](https://github.com/Inferara/stablecoin-close/compare/pre-hackmeridian...main).
The history before the tag is kept as it was written: nothing squashed, rebased or
backdated.

### Starting point (before October 25)

Written for HackMeridian from 2026-10-20, ahead of the on-site days; none of it
existed before that date:

- the `InvoiceSettlement` and `ReportAnchor` contracts with their unit tests, and
  their testnet deployment;
- the payer, anchor and verifier pages, live on GitHub Pages;
- the `haruno.stellar.month/1` snapshot format and the reference fetcher with its
  recorded testnet fixture;
- CI that builds the contracts and checks the deployed wasm hashes.

Haruno, the app that reads the snapshot and reconciles it, is an existing product
and is not in this repository. Its Stellar connector, and the reconciliation of the
snapshot in its books engine, were also built before the event.

### Built at HackMeridian (October 25-26)

Listed here as the work lands; the compare link above shows every change.

- **Oct 25: open RWA registry and valuation.** [`registry/stellar-rwa.json`](registry/)
  lists Stellar's tokenised real-world assets with their value sources. The fetcher
  now values them (RedStone on chain, fixed NAV, CoinGecko, optional Rumblefish),
  values a testnet sandbox token at its mainnet twin's price, and writes a
  `closing_rate` for every holding. The snapshot format gains the optional
  `asset.class`, `asset.priced_as` and `rate.basis` fields.
- **Oct 25: RWA values page.** [`pages/rwa`](pages/rwa/) shows every mainnet asset in
  the registry valued live (about $1.0B on Stellar when it was written): USDY at
  RedStone's NAV beside its DEX price 1.4% lower, BENJI and WTGX at their stated 1.00
  NAV with RedStone's BENJI feed as a check, the Etherfuse stablebonds, XAUm, and USDT0
  at par. USDT0 joins the registry as a `stablecoin` valued at `par`.
- **Oct 25: contracts redeployed with a bounded storage lifetime.** Staging the demo
  showed that testnet rent had made the contracts unusable: both extended every entry
  to the network maximum, so a new invoice cost 400 XLM and a new company's first
  anchor 510 XLM, more than a transaction fee can be. They now keep entries about 30
  days (70 and 89 XLM on the same day), and were redeployed with fee-bump
  transactions from [`tools/deploy`](tools/deploy/bin/deploy.mjs). The pages, the demo
  invoice and the sample anchor moved to the new contracts.
- **Oct 25: the demo month on testnet.** [`tools/demo`](tools/demo/) staged the demo
  company's October: four wallets, three invoices registered on InvoiceSettlement, INV-1001
  [paid through the contract](https://stellar.expert/explorer/testnet/tx/65524c3a93bbe009cb6327e7d357d1108ff59192005e170ea0193babc5b451de),
  an unexplained 3 USDC, two internal transfers, and Etherfuse sandbox CETES
  [bought](https://stellar.expert/explorer/testnet/tx/608b891f7342dc1844e6ec14f0f4801f85a089fc57c613661e6b76a5fc36da2c)
  by a "Treasury investments" wallet. The fetcher's snapshot of it is
  [`docs/examples/lisbon-coffee-roasters-2026-10.json`](docs/examples/lisbon-coffee-roasters-2026-10.json):
  the CETES is a `bond` valued at mainnet CETES's price. It is recorded as a test fixture.

Parts of this repository were written with AI coding assistants.

## License

[Apache-2.0](LICENSE)
