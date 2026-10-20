(function () {
  const X = window.Soroban;
  const S = X.S;
  const $ = (id) => document.getElementById(id);

  // InvoiceSettlement error codes (contracts/invoice-settlement/src/lib.rs).
  const ERRORS = {
    1: "No invoice is registered under this link. Check that you opened the full link from the invoice.",
    3: "This invoice has already been paid.",
  };

  const contractId = X.param("contract") || X.DEFAULT_CONTRACTS.invoice_settlement;
  const hash = (X.param("invoice") || "").toLowerCase();
  let invoice = null; // as read from the contract
  let asset = { code: "", decimals: 7 };
  let wallet = null; // connected address

  $("contract-id").textContent = X.shortAddr(contractId);

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
    if (/trustline|#13\b/i.test(msg)) return `Your wallet has no trustline for ${asset.code || "this asset"} yet. Add it in your wallet first.`;
    if (/Failed to fetch|NetworkError|network/i.test(msg)) return "The Stellar network could not be reached. Check your connection and try again.";
    return msg;
  }

  async function load() {
    if (!X.isContractId(contractId)) {
      showError("The link names an invalid contract.");
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
      try {
        const [code, decimals] = await Promise.all([
          X.read(invoice.asset, "symbol", []),
          X.read(invoice.asset, "decimals", []),
        ]);
        asset = { code: String(code), decimals: Number(decimals) };
      } catch (e) {
        asset = { code: X.shortAddr(invoice.asset), decimals: 7 };
      }
      render();
    } catch (e) {
      showError(friendly(e));
    } finally {
      $("loading").hidden = true;
    }
  }

  function render() {
    $("invoice").hidden = false;
    $("inv-number").textContent = invoice.invoice_number;
    $("inv-amount").textContent = X.formatUnits(invoice.amount, asset.decimals);
    $("inv-code").textContent = asset.code;
    $("inv-merchant").textContent = X.shortAddr(invoice.merchant);
    $("inv-merchant").title = invoice.merchant;
    $("inv-asset").innerHTML = "";
    const a = document.createElement("a");
    a.href = `${X.net.explorer}/contract/${invoice.asset}`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `${asset.code} (${X.shortAddr(invoice.asset)})`;
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
      X.findEventTx(contractId, [X.topicSymbol("invoice_paid"), X.topicString(invoice.invoice_number)], paid.ledger)
        .then((ev) => {
          if (ev) $("paid-link").href = `${X.net.explorer}/tx/${ev.txHash}`;
        });
    } else {
      pill.textContent = "Open";
      pill.className = "pill open";
      $("pay-card").hidden = false;
      $("pay").textContent = `Pay ${X.formatUnits(invoice.amount, asset.decimals)} ${asset.code}`;
    }
  }

  async function freighter() {
    const f = window.freighterApi;
    if (!f) throw new Error("The Freighter library did not load. Reload the page.");
    const c = await f.isConnected();
    if (!c || !c.isConnected) {
      throw new Error("Freighter is not installed. Install the Freighter browser extension (freighter.app) and reload.");
    }
    return f;
  }

  async function connect() {
    showError("");
    $("connect").disabled = true;
    try {
      const f = await freighter();
      const access = await f.requestAccess();
      if (access.error) throw new Error(access.error.message || String(access.error));
      const details = await f.getNetworkDetails();
      if (details.error) throw new Error(details.error.message || String(details.error));
      if (details.networkPassphrase !== X.net.passphrase) {
        throw new Error("Freighter is on another network. Switch it to Testnet and try again.");
      }
      wallet = access.address;
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
      const f = await freighter();
      btn.textContent = "Preparing…";
      let account;
      try {
        account = await X.server.getAccount(wallet);
      } catch (e) {
        throw new Error("This wallet account does not exist on testnet yet. Fund it with Friendbot first.");
      }
      const tx = X.buildCall(account, contractId, "pay_invoice", [
        new S.Address(wallet).toScVal(),
        X.bytes32(hash),
      ]);
      const prepared = await X.server.prepareTransaction(tx);

      btn.textContent = "Confirm in Freighter…";
      const signed = await f.signTransaction(prepared.toXDR(), {
        networkPassphrase: X.net.passphrase,
        address: wallet,
      });
      if (signed.error) throw new Error(signed.error.message || String(signed.error));

      btn.textContent = "Sending…";
      const signedTx = S.TransactionBuilder.fromXDR(signed.signedTxXdr, X.net.passphrase);
      const sent = await X.server.sendTransaction(signedTx);
      if (sent.status === "ERROR") throw new Error("The network rejected the transaction.");
      const done = await X.waitFor(sent.hash);
      if (done.status !== S.rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`The transaction failed (${done.status}).`);
      }

      $("invoice").hidden = true;
      $("success").hidden = false;
      $("success-text").textContent =
        `${invoice.invoice_number}: ${X.formatUnits(invoice.amount, asset.decimals)} ${asset.code} paid in ledger ${done.ledger}.`;
      $("success-link").href = `${X.net.explorer}/tx/${sent.hash}`;
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
