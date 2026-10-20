(function () {
  const X = window.Soroban;
  const S = X.S;
  const $ = (id) => document.getElementById(id);

  // InvoiceSettlement error codes (contracts/invoice-settlement/src/lib.rs).
  const ERRORS = {
    1: "No invoice is registered under this link. Check that you opened the full link from the invoice.",
    3: "This invoice has already been paid.",
  };

  // Only the InvoiceSettlement this repository deployed (deployments/).
  const KNOWN_CONTRACTS = [X.DEFAULT_CONTRACTS.invoice_settlement];

  const contractId = X.param("contract") || X.DEFAULT_CONTRACTS.invoice_settlement;
  const hash = (X.param("invoice") || "").toLowerCase();
  const expectedMerchant = X.param("merchant") || "";
  let invoice = null; // as read from the contract
  let asset = null; // from KNOWN_ASSETS
  let wallet = null; // connected address

  $("contract-id").textContent = X.shortAddr(contractId);
  $("contract-id").title = contractId;

  function showError(msg) {
    const el = $("error");
    el.textContent = msg;
    el.hidden = !msg;
  }

  function friendly(e) {
    if (e instanceof X.ContractError && ERRORS[e.code]) return ERRORS[e.code];
    const code = X.contractErrorCode(e && (e.raw || e.message));
    if (code !== null && ERRORS[code]) return ERRORS[code];
    const msg = String((e && e.message) || e);
    if (/insufficient|balance is not sufficient|#10\b/i.test(msg)) return "Your wallet does not hold enough of this asset.";
    if (/trustline|#13\b/i.test(msg)) return `Your wallet has no trustline for ${(asset && asset.code) || "this asset"} yet. Add it in your wallet first.`;
    if (/Failed to fetch|NetworkError/i.test(msg)) return "The Stellar network could not be reached. Check your connection and try again.";
    return msg;
  }

  async function load() {
    if (!KNOWN_CONTRACTS.includes(contractId)) {
      showError(X.isContractId(contractId)
        ? `Do not pay: this link points at contract ${contractId}, which is not the published InvoiceSettlement contract.`
        : "The link names an invalid contract.");
      return;
    }
    if (!hash) {
      $("ask").hidden = false;
      return;
    }
    if (!X.isHash(hash)) {
      showError("The invoice hash in this link is not valid (it should be 64 hex characters).");
      $("ask").hidden = false;
      return;
    }
    $("loading").hidden = false;
    try {
      invoice = await X.read(contractId, "get_invoice", [X.bytes32(hash)]);
      asset = X.KNOWN_ASSETS[invoice.asset] || null;
      render();
    } catch (e) {
      showError(friendly(e));
    } finally {
      $("loading").hidden = true;
    }
  }

  // Why this invoice must not be paid from this page, or null.
  function refusal() {
    if (!asset) {
      return `Do not pay: the invoice asks for an asset this page does not know (contract ${invoice.asset}).`;
    }
    if (!expectedMerchant) {
      return "This payment link is incomplete: it does not say who should be paid. Ask the merchant for the full link.";
    }
    if (!X.isAccountId(expectedMerchant)) {
      return "This payment link names an invalid merchant address.";
    }
    if (invoice.merchant !== expectedMerchant) {
      return `Do not pay: this invoice pays ${invoice.merchant}, not the merchant named in your link (${expectedMerchant}).`;
    }
    return null;
  }

  function render() {
    const decimals = asset ? asset.decimals : 7;
    $("invoice").hidden = false;
    $("inv-number").textContent = invoice.invoice_number;
    $("inv-amount").textContent = X.formatUnits(invoice.amount, decimals);
    $("inv-code").textContent = asset ? asset.code : "of an unknown asset";
    $("inv-merchant").textContent = X.shortAddr(invoice.merchant);
    $("inv-merchant").title = invoice.merchant;
    $("inv-asset").innerHTML = "";
    const a = document.createElement("a");
    a.href = `${X.net.explorer}/contract/${invoice.asset}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.className = "mono";
    a.textContent = `${asset ? asset.code : "Unknown"} ${X.shortAddr(invoice.asset)}`;
    a.title = invoice.asset;
    $("inv-asset").append(a);
    $("inv-due").textContent = new Date(Number(invoice.due) * 1000).toLocaleDateString(undefined, {
      year: "numeric", month: "long", day: "numeric",
    });

    const [state, paid] = invoice.status;
    const pill = $("inv-status");
    if (state === "Paid") {
      pill.textContent = "Paid";
      pill.className = "pill paid";
      $("pay-card").hidden = true;
      $("paid-card").hidden = false;
      $("paid-by").textContent = X.shortAddr(paid.payer);
      $("paid-by").title = paid.payer;
      $("paid-ledger").textContent = String(paid.ledger);
      $("paid-time").textContent = X.formatTime(paid.timestamp);
      $("paid-link").href = `${X.net.explorer}/contract/${contractId}`;
      X.findEventTx(contractId, [X.topicSymbol("invoice_paid"), X.topicString(invoice.invoice_number)], paid.ledger,
        (data) => X.bytesToHex(data.invoice_hash) === hash)
        .then((ev) => {
          if (ev) $("paid-link").href = `${X.net.explorer}/tx/${ev.txHash}`;
        });
      return;
    }
    pill.textContent = "Open";
    pill.className = "pill open";
    const why = refusal();
    if (why) {
      showError(why);
      return;
    }
    $("pay-card").hidden = false;
    $("pay").textContent = `Pay ${X.formatUnits(invoice.amount, asset.decimals)} ${asset.code}`;
  }

  // The only thing the page lets the wallet sign: this invoice's pay_invoice,
  // authorizing just the transfer of the shown amount to the shown merchant.
  function expectedPayment() {
    return {
      call: { contract: contractId, fn: "pay_invoice", args: [wallet, X.hexToBytes(hash)] },
      subCalls: [{ contract: invoice.asset, fn: "transfer", args: [wallet, invoice.merchant, BigInt(invoice.amount)] }],
    };
  }

  async function connect() {
    showError("");
    $("connect").disabled = true;
    try {
      wallet = await X.connectFreighter();
      $("wallet-line").hidden = false;
      $("wallet-line").textContent = `Wallet ${X.shortAddr(wallet)}`;
      $("connect").hidden = true;
      $("pay").hidden = false;
      try {
        const bal = await X.read(invoice.asset, "balance", [new S.Address(wallet).toScVal()]);
        $("balance-line").hidden = false;
        $("balance-line").textContent = `You hold ${X.formatUnits(bal, asset.decimals)} ${asset.code}`;
        if (BigInt(bal) < BigInt(invoice.amount)) {
          showError(`Your wallet holds less ${asset.code} than this invoice asks for.`);
        }
      } catch (e) {
        showError(friendly(e));
      }
    } catch (e) {
      showError(friendly(e));
      $("connect").disabled = false;
    }
  }

  async function pay() {
    showError("");
    const btn = $("pay");
    const label = btn.textContent;
    btn.disabled = true;
    try {
      btn.textContent = "Preparing…";
      const prepared = await X.prepareCall(wallet, contractId, "pay_invoice", [
        new S.Address(wallet).toScVal(),
        X.bytes32(hash),
      ]);
      X.checkAuthTree(prepared, wallet, expectedPayment());
      const done = await X.signAndSubmit(prepared, wallet, (step) => {
        btn.textContent = step === "sign" ? "Confirm in Freighter…" : "Sending…";
      });

      $("invoice").hidden = true;
      $("success").hidden = false;
      $("success-text").textContent =
        `${invoice.invoice_number}: ${X.formatUnits(invoice.amount, asset.decimals)} ${asset.code} paid in ledger ${done.ledger}.`;
      $("success-link").href = `${X.net.explorer}/tx/${done.hash}`;
    } catch (e) {
      showError(friendly(e));
      btn.textContent = label;
      btn.disabled = false;
    }
  }

  $("connect").addEventListener("click", connect);
  $("pay").addEventListener("click", pay);
  $("ask-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const h = $("ask-hash").value.trim().toLowerCase();
    const q = new URLSearchParams(location.search);
    q.set("invoice", h);
    location.search = q.toString();
  });

  load();
})();
