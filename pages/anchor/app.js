// The reviewer's sign-off page. Opened with
//   ?company=<company_id_hash hex>&period=YYYY-MM&report=<sha256 hex>&contract=<ReportAnchor id>&network=testnet
// It takes the company hash as given and never derives it: how a caller
// computes it (and with which salt) is the caller's business.
(function () {
  const X = window.Soroban;
  const S = X.S;
  const $ = (id) => document.getElementById(id);

  const raw = {
    company: X.param("company") || "",
    period: X.param("period") || "",
    report: X.param("report") || "",
    contract: X.param("contract") || X.DEFAULT_CONTRACTS.report_anchor,
    network: X.param("network") || "testnet",
  };
  const company = raw.company.toLowerCase();
  const report = raw.report.toLowerCase();
  const period = raw.period;
  const contractId = raw.contract;
  let wallet = null;

  function problems() {
    const out = [];
    if (raw.network !== "testnet") out.push(`The network "${raw.network}" is not supported here; only testnet is.`);
    if (!X.isHash(company)) out.push("The company hash is missing or is not 64 hex characters.");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) out.push("The period is missing or is not a month in the form YYYY-MM.");
    if (!X.isHash(report)) out.push("The report hash is missing or is not 64 hex characters.");
    if (!X.isContractId(contractId)) out.push("The contract id is not a valid Stellar contract address.");
    return out;
  }

  function showError(msg) {
    $("error").textContent = msg;
    $("error").hidden = !msg;
  }

  function showResult(kind, title, text) {
    $("result").className = `result ${kind}`;
    $("result-icon").innerHTML = kind === "ok" ? "&#10003;" : kind === "bad" ? "&#10007;" : "!";
    $("result-title").textContent = title;
    $("result-text").textContent = text;
    $("result").hidden = false;
  }

  const short = (h) => `${h.slice(0, 8)}…${h.slice(-6)}`;

  function verifierUrl() {
    const u = new URL("../verifier/", location.href);
    u.searchParams.set("company", company);
    u.searchParams.set("period", period);
    if (contractId !== X.DEFAULT_CONTRACTS.report_anchor) u.searchParams.set("contract", contractId);
    return u.toString();
  }

  function monthLabel(p) {
    const [y, m] = p.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  }

  function showLinks(txHash) {
    $("links").hidden = false;
    $("tx-link").href = txHash ? `${X.net.explorer}/tx/${txHash}` : `${X.net.explorer}/contract/${contractId}`;
    $("verify-url").textContent = verifierUrl();
  }

  function showExisting(anchor) {
    $("sign-card").hidden = true;
    const anchored = X.bytesToHex(anchor.report_sha256);
    if (anchored === report) {
      showResult("ok", "Already anchored",
        `This report is already anchored for ${monthLabel(period)}. Nothing to sign.`);
    } else {
      showResult("bad", "A different report is anchored",
        `${monthLabel(period)} is already anchored with another report hash. An anchor cannot be replaced; disclose the correction in the next period's report.`);
    }
    $("existing").hidden = false;
    $("e-time").textContent = X.formatTime(anchor.timestamp);
    $("e-ledger").textContent = String(anchor.ledger);
    $("e-signer").textContent = X.shortAddr(anchor.signer);
    $("e-signer").title = anchor.signer;
    $("e-hash").textContent = short(anchored);
    $("e-hash").title = anchored;
    showLinks(null);
    X.findEventTx(contractId, [X.topicSymbol("anchored"), X.topicBytes(company), X.topicString(period)], anchor.ledger)
      .then((ev) => { if (ev) $("tx-link").href = `${X.net.explorer}/tx/${ev.txHash}`; });
  }

  async function readAnchor() {
    return X.read(contractId, "get", [X.bytes32(company), S.nativeToScVal(period, { type: "string" })]);
  }

  async function load() {
    const bad = problems();
    if (bad.length) {
      showError(bad.join(" "));
      return;
    }
    $("request").hidden = false;
    $("r-period").textContent = monthLabel(period);
    $("r-report").textContent = short(report);
    $("r-report").title = report;
    $("r-company").textContent = short(company);
    $("r-company").title = company;
    $("r-contract").textContent = X.shortAddr(contractId);
    $("r-contract").href = `${X.net.explorer}/contract/${contractId}`;
    X.copyButton($("copy-report"), () => report);
    X.copyButton($("copy-company"), () => company);
    X.copyButton($("copy-verify"), verifierUrl);

    try {
      const anchor = await readAnchor();
      if (anchor) showExisting(anchor);
      else $("sign-card").hidden = false;
    } catch (e) {
      showError(networkMessage(e));
    }
  }

  function networkMessage(e) {
    const msg = String((e && e.message) || e);
    return /Failed to fetch|NetworkError/i.test(msg)
      ? "The Stellar network could not be reached. Check your connection and try again."
      : msg;
  }

  async function connect() {
    showError("");
    $("connect").disabled = true;
    try {
      wallet = await X.connectFreighter();
      $("wallet-line").hidden = false;
      $("wallet-line").textContent = `Signing as ${X.shortAddr(wallet)}`;
      $("connect").hidden = true;
      $("sign").hidden = false;
    } catch (e) {
      showError(networkMessage(e));
      $("connect").disabled = false;
    }
  }

  async function sign() {
    showError("");
    const btn = $("sign");
    const label = btn.textContent;
    btn.disabled = true;
    try {
      btn.textContent = "Preparing…";
      const prepared = await X.prepareCall(wallet, contractId, "anchor", [
        new S.Address(wallet).toScVal(),
        X.bytes32(company),
        S.nativeToScVal(period, { type: "string" }),
        X.bytes32(report),
      ]);
      const done = await X.signAndSubmit(prepared, wallet, (step) => {
        btn.textContent = step === "sign" ? "Confirm in Freighter…" : "Sending…";
      });
      $("sign-card").hidden = true;
      showResult("ok", "Report anchored", `${monthLabel(period)} is anchored in ledger ${done.ledger}, signed by ${X.shortAddr(wallet)}.`);
      showLinks(done.hash);
    } catch (e) {
      if (e instanceof X.ContractError && e.code === 1) {
        // Someone anchored this period after the page loaded.
        const anchor = await readAnchor().catch(() => null);
        if (anchor) return showExisting(anchor);
      }
      showError(e instanceof X.ContractError ? `The contract refused the anchor (error #${e.code}).` : networkMessage(e));
      btn.textContent = label;
      btn.disabled = false;
    }
  }

  $("connect").addEventListener("click", connect);
  $("sign").addEventListener("click", sign);
  load();
})();
