// Real-world assets on Stellar, valued live. Reads the open registry
// (registry/stellar-rwa.json), then for each mainnet asset: its value from the
// sources the registry names (stated NAV, RedStone on chain), the Stellar DEX
// price against USDC where it trades, and its supply on Stellar. Everything is
// read in the browser from public endpoints; nothing is stored or sent anywhere.
// A haruno.stellar.month/1 snapshot dropped on the page is read locally and its
// real-world assets are valued again with the same live values.
(function () {
  const S = window.StellarSdk;
  const $ = (id) => document.getElementById(id);

  const RPC = "https://mainnet.sorobanrpc.com";
  const HORIZON = "https://horizon.stellar.org";
  const REGISTRY_URL = "../../registry/stellar-rwa.json";
  const SAMPLE_SNAPSHOT_URL = "../../docs/examples/lisbon-coffee-roasters-2026-10.json";
  const SNAPSHOT_FORMAT = "haruno.stellar.month/1";
  // Circle's USDC on mainnet: the quote asset for DEX prices.
  const USDC = { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" };
  // Simulation needs a source account but does not check that it exists.
  const READ_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  // A gap between the value and the DEX price above this is called out.
  const GAP_NOTICE = 0.01;

  const server = new S.rpc.Server(RPC);
  $("rpc").textContent = new URL(RPC).host;

  const CLASS_LABEL = { fund_share: "Fund share", bond: "Bond", commodity: "Gold", stablecoin: "Stablecoin" };
  const VALUATION_LABEL = { nav: "Valued at NAV", fixed_nav: "Stable NAV", market: "Valued at market", par: "Valued at par" };

  // --- reads ---

  async function read(contractId, method, args = []) {
    const tx = new S.TransactionBuilder(new S.Account(READ_SOURCE, "0"), { fee: S.BASE_FEE, networkPassphrase: S.Networks.PUBLIC })
      .addOperation(new S.Contract(contractId).call(method, ...args))
      .setTimeout(60)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (S.rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
    return sim.result && sim.result.retval ? S.scValToNative(sim.result.retval) : null;
  }

  async function getJson(url) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${new URL(url, location.href).host}: HTTP ${res.status}`);
    return res.json();
  }

  const scaled = (value, decimals) => Number(value) / 10 ** decimals;

  // RedStone's latest SEP-40 reading for a token: { usd, at }.
  async function redstoneLast(oracle, token) {
    const asset = S.xdr.ScVal.scvVec([S.xdr.ScVal.scvSymbol("Stellar"), new S.Address(token).toScVal()]);
    const r = await read(oracle.contract, "lastprice", [asset]);
    return r ? { usd: scaled(r.price, oracle.decimals), at: new Date(Number(r.timestamp) * 1000) } : null;
  }

  // A RedStone single-feed contract's value: { usd, at }.
  async function redstoneFeed(oracle, contract) {
    const r = await read(contract, "read_price_data");
    return r ? { usd: scaled(r.price, oracle.decimals), at: new Date(Number(r.write_timestamp)) } : null;
  }

  function horizonAsset(prefix, code, issuer) {
    const type = code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
    return `${prefix}_asset_type=${type}&${prefix}_asset_code=${code}&${prefix}_asset_issuer=${issuer}`;
  }

  // The Stellar DEX against USDC: { mid, bid, ask } in USDC per unit, or null with no orders.
  async function dexPrice(entry) {
    const book = await getJson(`${HORIZON}/order_book?${horizonAsset("selling", entry.code, entry.issuer)}&${horizonAsset("buying", USDC.code, USDC.issuer)}&limit=1`);
    const bid = book.bids && book.bids[0] ? Number(book.bids[0].price) : null;
    const ask = book.asks && book.asks[0] ? Number(book.asks[0].price) : null;
    if (bid === null && ask === null) return null;
    return { bid, ask, mid: bid !== null && ask !== null ? (bid + ask) / 2 : bid ?? ask };
  }

  // Units in existence on Stellar: Horizon's balances for a classic asset, total_supply() for a token.
  async function supply(entry) {
    if (entry.token === "soroban") return scaled(await read(entry.contract, "total_supply"), entry.decimals);
    const body = await getJson(`${HORIZON}/assets?asset_code=${entry.code}&asset_issuer=${entry.issuer}`);
    const r = body._embedded.records[0];
    if (!r) return null;
    const b = r.balances || {};
    return ["authorized", "authorized_to_maintain_liabilities"].reduce((sum, k) => sum + Number(b[k] || 0), 0)
      + Number(r.claimable_balances_amount || 0) + Number(r.liquidity_pools_amount || 0) + Number(r.contracts_amount || 0);
  }

  // The headline value, from the registry's sources in order, and the readings beside it.
  async function valueOf(entry, oracles) {
    let value = null;
    const checks = [];
    for (const s of entry.sources) {
      try {
        if (s.kind === "fixed") {
          const v = { usd: Number(s.value), label: entry.valuation === "par" ? "Par" : "Stated NAV (issuer)" };
          if (value) checks.push(v); else value = v;
        } else if (s.kind === "redstone_sep40") {
          const r = await redstoneLast(oracles.redstone_sep40, s.asset);
          if (!r) continue;
          const kind = entry.valuation === "nav" ? "NAV" : "market";
          const v = { ...r, label: `RedStone on chain (${kind})`, stale: Date.now() - r.at > oracles.redstone_sep40.stale_after_hours * 3600_000 };
          if (value) checks.push({ ...v, label: "RedStone on chain (market)" }); else value = v;
        } else if (s.kind === "redstone_feed") {
          const r = await redstoneFeed(oracles.redstone_feed, s.contract);
          if (r) checks.push({ ...r, label: "RedStone fund feed" });
        }
      } catch (e) {
        checks.push({ error: `${s.kind}: ${e.message}` });
      }
    }
    return { value, checks };
  }

  // --- formatting ---

  const usd = (n, digits) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  const priceText = (n) => usd(n, n >= 100 ? 2 : n >= 1 ? 4 : 6);
  const moneyText = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(n);
  const unitsText = (n) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);

  function ago(at) {
    const minutes = Math.round((Date.now() - at) / 60000);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of children) if (c !== null && c !== undefined) node.append(c);
    return node;
  }

  function row(dt, dd, ddClass) {
    return el("div", {}, el("dt", { textContent: dt }), el("dd", { textContent: dd, className: ddClass || "" }));
  }

  // --- the page ---

  function card(entry) {
    const value = el("p", { className: "big" }, el("span", { className: "loading", textContent: "…" }));
    const source = el("p", { className: "hint", style: "margin:4px 0 0" });
    const rows = el("dl", { className: "rows" });
    const domain = el("a", { href: `https://${entry.home_domain}`, textContent: entry.home_domain, rel: "noopener", target: "_blank" });
    const node = el("section", { className: "card asset", id: `asset-${entry.id}` },
      el("div", { className: "head" },
        el("h2", { textContent: `${entry.code} · ${entry.name}` }),
        el("div", { className: "tags" },
          el("span", { className: "tag", textContent: CLASS_LABEL[entry.class] || entry.class }),
          el("span", { className: "tag", textContent: VALUATION_LABEL[entry.valuation] || entry.valuation }))),
      el("p", { className: "who" }, `${entry.issuer_name} · `, domain),
      el("p", { className: "label", textContent: "Value per token" }),
      el("div", { className: "value" }, value),
      source,
      rows,
      el("p", { className: "note", textContent: entry.note }));
    return { node, value, source, rows };
  }

  async function fill(entry, oracles, parts) {
    const [{ value, checks }, dex, units] = await Promise.all([
      valueOf(entry, oracles),
      entry.token === "classic" ? dexPrice(entry).catch(() => null) : Promise.resolve(null),
      supply(entry).catch(() => null),
    ]);

    if (value) {
      parts.value.textContent = priceText(value.usd);
      parts.source.textContent = value.at ? `${value.label}, ${ago(value.at)}` : value.label;
      if (value.stale) parts.source.classList.add("stale");
    } else {
      parts.value.textContent = "No value";
      parts.source.textContent = "None of the registry's sources answered.";
    }

    for (const c of checks) {
      if (c.error) parts.rows.append(row("Not read", c.error, "stale"));
      else parts.rows.append(row(c.label, c.at ? `${priceText(c.usd)} · ${ago(c.at)}` : priceText(c.usd)));
    }
    if (dex) {
      parts.rows.append(row("Stellar DEX vs USDC", priceText(dex.mid)));
      if (value && dex.bid !== null && dex.ask !== null) {
        const gap = (dex.mid - value.usd) / value.usd;
        const pill = el("span", {
          className: `gap ${Math.abs(gap) > GAP_NOTICE ? "warn" : "ok"}`,
          textContent: `DEX ${gap >= 0 ? "+" : "−"}${Math.abs(gap * 100).toFixed(2)}% vs value`,
        });
        parts.value.parentElement.append(pill);
      }
    } else if (entry.token === "classic") {
      parts.rows.append(row("Stellar DEX vs USDC", "no orders"));
    }
    if (units !== null) {
      parts.rows.append(row("Supply on Stellar", `${unitsText(units)} ${entry.code}`));
      if (value) parts.rows.append(row("Value on Stellar", moneyText(units * value.usd)));
    }
    return { perToken: value ? value.usd : null, onStellar: value && units !== null ? units * value.usd : null };
  }

  // --- a snapshot, valued again now ---

  // Registry id -> promise of the live value per token in USD (or null).
  const live = {};

  // Matched by network, code and issuer (or contract), never by code alone.
  function registryEntry(registry, network, asset) {
    return registry.assets.find((e) => e.network === network && e.code === asset.code &&
      (asset.issuer ? e.issuer === asset.issuer : e.contract === asset.contract)) || null;
  }

  function snapshotError(message) {
    $("snapshot-error").textContent = message;
    $("snapshot-error").hidden = !message;
    if (message) $("snapshot-result").hidden = true;
  }

  const signedPercent = (r) => `${r >= 0 ? "+" : "−"}${Math.abs(r * 100).toFixed(2)}%`;

  async function showSnapshot(registry, snap) {
    if (!snap || snap.format !== SNAPSHOT_FORMAT || !Array.isArray(snap.wallets)) {
      return snapshotError(`This is not a ${SNAPSHOT_FORMAT} snapshot.`);
    }
    snapshotError("");
    const holdings = $("snapshot-holdings");
    const summary = $("snapshot-summary");
    holdings.replaceChildren();
    summary.replaceChildren();
    const testnet = snap.wallets.some((w) => w.network === "testnet");
    $("snapshot-title").textContent = `${snap.company} · ${snap.month}${testnet ? " · testnet" : ""}`;
    $("snapshot-result").hidden = false;

    let fileTotal = 0;
    let rwaThen = 0;
    let rwaNow = 0;
    const others = [];
    const jobs = [];
    for (const w of snap.wallets) {
      for (const a of w.assets || []) {
        const units = Number(a.closing);
        if (!(units > 0)) continue;
        const rate = a.closing_rate || {};
        const then = Number(rate.usd) > 0 ? units * Number(rate.usd) : null;
        if (then !== null) fileTotal += then;
        const entry = registryEntry(registry, w.network, a.asset);
        const priced = entry && entry.price_as ? registry.assets.find((e) => e.id === entry.price_as) : entry;
        if (!priced) {
          others.push(`${w.name}: ${unitsText(units)} ${a.asset.code}, ${then === null ? "unpriced" : usd(then, 2)}`);
          continue;
        }
        const now = row("Now", "…");
        holdings.append(el("div", { className: "holding" },
          el("div", { className: "head" },
            el("h3", { textContent: `${w.name} · ${a.asset.code}` }),
            el("div", { className: "tags" },
              el("span", { className: "tag", textContent: CLASS_LABEL[priced.class] || priced.class }),
              entry !== priced ? el("span", { className: "tag", textContent: `Priced as mainnet ${priced.code}` }) : null)),
          el("dl", { className: "rows" },
            row("Holding", `${unitsText(units)} ${a.asset.code}`),
            row("Month end, in the file", then === null
              ? "unpriced"
              : `${usd(then, 2)} (${priceText(Number(rate.usd))}${rate.basis ? `, ${rate.basis}` : ""})`),
            now)));
        if (then !== null) rwaThen += then;
        jobs.push((live[priced.id] || Promise.resolve(null)).then((perToken) => {
          const dd = now.querySelector("dd");
          if (perToken === null) {
            dd.textContent = "not available";
            return;
          }
          rwaNow += units * perToken;
          const change = then ? `, ${signedPercent((units * perToken - then) / then)}` : "";
          dd.textContent = `${usd(units * perToken, 2)} (${priceText(perToken)}${change})`;
        }));
      }
    }
    if (others.length) {
      holdings.append(el("div", { className: "holding" },
        el("p", { className: "label", textContent: "Other holdings, as valued in the file" }),
        ...others.map((t) => el("p", { className: "hint", style: "margin:2px 0", textContent: t }))));
    }
    summary.append(row("Holdings valued in the file", usd(fileTotal, 2)));
    const rwaRow = row("Real-world assets", "…");
    summary.append(rwaRow);
    if (testnet) summary.append(row("Testnet tokens", "valued at their mainnet twins' prices"));
    await Promise.all(jobs);
    rwaRow.querySelector("dd").textContent = jobs.length ? `${usd(rwaThen, 2)} at month end, ${usd(rwaNow, 2)} now` : "none in this file";
  }

  function wireSnapshot(registryReady) {
    const take = async (text) => {
      let snap;
      try {
        snap = JSON.parse(text);
      } catch {
        return snapshotError("This file is not JSON.");
      }
      const registry = await registryReady;
      if (registry) await showSnapshot(registry, snap);
    };
    const readFile = (file) => file && file.text().then(take);
    $("snapshot-file").addEventListener("change", (e) => readFile(e.target.files[0]));
    const drop = $("snapshot-drop");
    ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    }));
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      readFile(e.dataTransfer.files[0]);
    });
    $("snapshot-sample").addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        const res = await fetch(SAMPLE_SNAPSHOT_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await take(await res.text());
      } catch (err) {
        snapshotError(`The demo snapshot could not be loaded: ${err.message}`);
      }
    });
  }

  async function main() {
    let ready;
    wireSnapshot(new Promise((resolve) => (ready = resolve)));
    let registry;
    try {
      registry = await getJson(REGISTRY_URL);
    } catch (e) {
      $("error").textContent = `The registry could not be loaded: ${e.message}`;
      $("error").hidden = false;
      ready(null);
      return;
    }
    const entries = registry.assets.filter((e) => e.network === "mainnet");
    const list = $("assets");
    const jobs = entries.map((entry) => {
      const parts = card(entry);
      list.append(parts.node);
      const job = fill(entry, registry.oracles, parts).catch((e) => {
        parts.value.textContent = "Not read";
        parts.source.textContent = e.message;
        return null;
      });
      live[entry.id] = job.then((r) => (r ? r.perToken : null));
      return job;
    });
    ready(registry);
    const values = (await Promise.all(jobs)).map((r) => (r ? r.onStellar : null));
    const valued = values.filter((v) => v !== null);
    const total = valued.reduce((a, b) => a + b, 0);
    $("total").textContent = valued.length
      ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(total)
      : "Not available";
    $("total-note").textContent = `Supply on Stellar × value per token, across ${valued.length} of the ${entries.length} assets in the registry (checked ${registry.checked}).`;
  }

  main();
})();
