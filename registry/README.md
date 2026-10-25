# Stellar RWA registry

[`stellar-rwa.json`](stellar-rwa.json) is an open list of tokenised real-world assets on Stellar (and USDT0, a bridged stablecoin beside them), with what each one is and where a **real value** for it comes from. It exists so that a month-end close can value these holdings the way an accountant must: at the issuer's net asset value, or a stated stable NAV, or (only where the market tracks the value closely) a traded price, both at the date of each movement and at month end. Any tool can read it; [`pages/rwa`](../pages/rwa/) shows it live, and `tools/fetcher` uses it to value these assets in a [`haruno.stellar.month/1`](../docs/haruno-stellar-month-1.md) snapshot.

Identifiers, oracle contracts and feeds were checked on 2026-10-25 against Horizon, stellar.expert, the issuers' `stellar.toml` files and read-only calls to mainnet Soroban RPC.

| Asset | Issuer | Class | Value | Sources, in order |
|---|---|---|---|---|
| USDY | Ondo Finance | bond | NAV | RedStone on-chain NAV feed; CoinGecko daily history |
| BENJI | Franklin Templeton | fund share | fixed NAV 1.00 | fixed; RedStone BENJI feed (cross-check); CoinGecko |
| WTGX | WisdomTree | fund share | fixed NAV 1.00 | fixed |
| CETES, USTRY, TESOURO | Etherfuse | bond | market | RedStone on-chain; CoinGecko daily (CETES, TESOURO); Rumblefish daily (with a key) |
| XAUm | Matrixdock | commodity (gold) | NAV | RedStone on-chain NAV feed; Chainlink (about 180 days of rounds); CoinGecko |
| USDT0 | Everdawn Labs (USDT0 Network) | stablecoin | par 1.00 | fixed; RedStone on-chain market price (cross-check) |
| CETES, USTRY, TESOURO (testnet) | Etherfuse sandbox | bond | priced as the mainnet twin | as mainnet |

## Format (`stellar-rwa-registry/1`)

[`stellar-rwa.schema.json`](stellar-rwa.schema.json) is its JSON Schema (draft 2020-12). CI checks the registry against it on every change (`tools/fetcher`, `npm test`), and an editor that reads `$schema` checks it as you type.

- `oracles`: the on-chain price contracts the sources refer to, with their network, decimals and base currency. RedStone's SEP-40 contract keeps about the last ten updates (two to three days); a reading older than `stale_after_hours` is not used.
- `assets[]`: one entry per token and network.
  - `id`, `name`, `issuer_name`, `home_domain`.
  - `network`, `code`, `issuer` (classic) and `contract` (the SAC of a classic asset, or the token contract of a Soroban token), `token` (`classic` or `soroban`), `decimals`.
  - `class`: `fund_share`, `bond`, `commodity` or `stablecoin` (a payment stablecoin listed beside the RWAs, such as USDT0).
  - `valuation`: `nav`, `fixed_nav`, `market` or `par`.
  - `sources`: tried in order until one gives a value for the moment asked:
    - `fixed {value}`: the stated NAV, or a stablecoin's par, at any date.
    - `redstone_sep40 {asset}`: `lastprice` / `prices` on the SEP-40 contract, for the token's contract address.
    - `redstone_feed {contract}`: a single-feed contract's `read_price_data`.
    - `chainlink {data_id}`: `latest_round` / `get_round` on the Chainlink proxy.
    - `coingecko {id}`: the daily price (00:00 UTC) from CoinGecko's public API.
    - `rumblefish {id}`: daily closes from the Rumblefish Prices API (needs a key).
  - `price_as`: on a testnet entry, the `id` of the mainnet entry it is priced as.
  - `note`: what an accountant should know (how yield arrives, transfer restrictions, why a DEX price is or is not a value).

A token is matched by network, code **and** issuer (or contract), never by code alone: Horizon lists many look-alike issuers for these codes.

## What `tools/fetcher` does with it

- Reads RedStone on chain (no key) and CoinGecko's public API for the days the oracle does not reach; reads Rumblefish only when `RUMBLEFISH_API_KEY` is set in the environment. The key is never written into a recorded input or a snapshot.
- Implements `fixed`, `redstone_sep40`, `coingecko` and `rumblefish`. `redstone_feed` and `chainlink` are listed for other readers.
- XAUm is a Soroban token: Horizon does not show its balances, so the fetcher does not read XAUm holdings yet.

## Not listed

- Lend (lend.xyz) opLEND tokens: no public price or NAV source.
- Spiko funds (EUTBL, USTBL, SAFO family), the other WisdomTree funds and Centrifuge deRWA tokens: candidates for later entries.

Additions are welcome as pull requests: an entry needs a primary source for its identifiers and at least one source that gives a real value.
