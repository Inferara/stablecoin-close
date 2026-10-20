(function () {
  const X = window.Soroban;
  const $ = (id) => document.getElementById(id);

  // The sample report in this folder, anchored on testnet when the contract
  // was deployed (see README).
  const SAMPLE = {
    company: "346c9389e34031e562c9dec42d2178b7dc7d2e87d0e2f9e452986f2da210fe7f",
    period: "2026-09",
  };

  const contractId = X.param("contract") || X.DEFAULT_CONTRACTS.report_anchor;
  let fileHash = null;
  let fileName = null;

  $("contract-id").textContent = X.shortAddr(contractId);
  $("company").value = (X.param("company") || "").toLowerCase();
  $("period").value = X.param("period") || "";

  function showError(msg) {
    $("error").textContent = msg;
    $("error").hidden = !msg;
  }

  function showResult(kind, title, text) {
    const r = $("result");
    r.className = `result ${kind}`;
    $("result-icon").innerHTML = kind === "ok" ? "&#10003;" : kind === "bad" ? "&#10007;" : "?";
    $("result-title").textContent = title;
    $("result-text").textContent = text;
    r.hidden = false;
    r.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function clearResult() {
    $("result").hidden = true;
    $("details").hidden = true;
  }

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return X.bytesToHex(new Uint8Array(digest));
  }

  async function takeFile(file) {
    showError("");
    clearResult();
    if (!file) return;
    fileName = file.name;
    $("drop-title").textContent = file.name;
    $("drop-hint").textContent = "Computing fingerprint…";
    fileHash = await sha256Hex(await file.arrayBuffer());
    $("drop-hint").textContent = `SHA-256 ${fileHash.slice(0, 16)}…  (drop another file to replace it)`;
    if (ready()) check();
  }

  function ready() {
    return fileHash && X.isHash($("company").value.trim()) && /^\d{4}-\d{2}$/.test($("period").value);
  }

  async function check() {
    showError("");
    clearResult();
    const company = $("company").value.trim().toLowerCase();
    const period = $("period").value;
    if (!fileHash) return showError("Choose the report PDF first.");
    if (!X.isHash(company)) return showError("The company ID hash should be 64 hex characters.");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return showError("Choose the period (year and month).");
    if (!X.isContractId(contractId)) return showError("The link names an invalid contract.");

    $("check").disabled = true;
    $("check").textContent = "Checking…";
    try {
      const anchor = await X.read(contractId, "get", [
        X.bytes32(company),
        X.S.nativeToScVal(period, { type: "string" }),
      ]);
      if (anchor === null || anchor === undefined) {
        showResult("none", "Nothing anchored",
          `No report has been anchored for this company and ${period}. Check the company and period.`);
        return;
      }
      const anchored = X.bytesToHex(anchor.report_sha256);
      if (anchored === fileHash) {
        showResult("ok", "Matches the anchored report",
          `${fileName} is exactly the report anchored for ${period}.`);
      } else {
        showResult("bad", "Does not match",
          `${fileName} is not the report anchored for ${period}. It may have been changed, or it is a different file.`);
      }
      $("details").hidden = false;
      $("d-time").textContent = X.formatTime(anchor.timestamp);
      $("d-ledger").textContent = String(anchor.ledger);
      $("d-signer").textContent = X.shortAddr(anchor.signer);
      $("d-signer").title = anchor.signer;
      $("d-anchored").textContent = `${anchored.slice(0, 12)}…${anchored.slice(-6)}`;
      $("d-anchored").title = anchored;
      $("d-file").textContent = `${fileHash.slice(0, 12)}…${fileHash.slice(-6)}`;
      $("d-file").title = fileHash;
      $("d-link").href = `${X.net.explorer}/contract/${contractId}`;
      X.findEventTx(contractId, [X.topicSymbol("anchored"), X.topicBytes(company), X.topicString(period)], anchor.ledger)
        .then((ev) => {
          if (ev) $("d-link").href = `${X.net.explorer}/tx/${ev.txHash}`;
        });
    } catch (e) {
      const msg = String((e && e.message) || e);
      showError(/Failed to fetch|NetworkError/i.test(msg)
        ? "The Stellar network could not be reached. Check your connection and try again."
        : msg);
    } finally {
      $("check").disabled = false;
      $("check").textContent = "Check";
    }
  }

  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) =>
    drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) =>
    drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  // A drop on the zone bubbles up to here; a file dropped anywhere else on
  // the page is taken too, rather than navigating away.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => { e.preventDefault(); takeFile(e.dataTransfer.files[0]); });
  $("file").addEventListener("change", (e) => takeFile(e.target.files[0]));
  $("form").addEventListener("submit", (e) => { e.preventDefault(); check(); });

  $("sample").addEventListener("click", async (e) => {
    e.preventDefault();
    $("company").value = SAMPLE.company;
    $("period").value = SAMPLE.period;
    const res = await fetch("sample-report.pdf");
    const blob = await res.blob();
    await takeFile(new File([blob], "sample-report.pdf", { type: "application/pdf" }));
  });
})();
