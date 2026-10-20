// Small helpers shared by the payer and verifier pages. Plain browser script:
// it expects the StellarSdk global (loaded from a pinned CDN build) and
// exposes window.Soroban.
(function () {
  const S = window.StellarSdk;

  const NETWORKS = {
    testnet: {
      rpc: "https://soroban-testnet.stellar.org",
      passphrase: S.Networks.TESTNET,
      explorer: "https://stellar.expert/explorer/testnet",
    },
  };

  // Contracts deployed by this repository (deployments/testnet.json).
  const DEFAULT_CONTRACTS = {
    invoice_settlement: "CB6J7MWCEJD5A4MR2Z2NSISUDIOZG7R76CDFIPP7R5CKJVBWNAAGMVQQ",
    report_anchor: "CCMJRXZN3JZQCDPMA3MMQ4LKYEDAWM6CR2C6R5OFNKFVUGI6LVXKMOU3",
  };

  // Reads need a transaction to simulate, and a transaction needs a source
  // account. Simulation does not check that the account exists, so a fixed,
  // unfunded, keyless address is enough.
  const READ_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  const net = NETWORKS.testnet;
  const server = new S.rpc.Server(net.rpc);

  class ContractError extends Error {
    constructor(code, raw) {
      super(`contract error #${code}`);
      this.code = code;
      this.raw = raw;
    }
  }

  function contractErrorCode(text) {
    const m = /Error\(Contract, #(\d+)\)/.exec(String(text || ""));
    return m ? Number(m[1]) : null;
  }

  function isContractId(s) {
    return typeof s === "string" && /^C[A-Z2-7]{55}$/.test(s) && S.StrKey.isValidContract(s);
  }

  function isHash(s) {
    return typeof s === "string" && /^[0-9a-fA-F]{64}$/.test(s);
  }

  function bytes32(hex) {
    return S.xdr.ScVal.scvBytes(hexToBytes(hex));
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function buildCall(source, contractId, method, args) {
    return new S.TransactionBuilder(source, {
      fee: S.BASE_FEE,
      networkPassphrase: net.passphrase,
    })
      .addOperation(new S.Contract(contractId).call(method, ...args))
      .setTimeout(120)
      .build();
  }

  // Simulates a read-only call and returns its result as native JS values.
  async function read(contractId, method, args) {
    const tx = buildCall(new S.Account(READ_SOURCE, "0"), contractId, method, args);
    const sim = await server.simulateTransaction(tx);
    if (S.rpc.Api.isSimulationError(sim)) {
      const code = contractErrorCode(sim.error);
      if (code !== null) throw new ContractError(code, sim.error);
      throw new Error(sim.error);
    }
    const retval = sim.result && sim.result.retval;
    return retval ? S.scValToNative(retval) : undefined;
  }

  // Waits for a submitted transaction to leave the PENDING/NOT_FOUND state.
  async function waitFor(hash, timeoutMs = 60000) {
    const started = Date.now();
    for (;;) {
      const r = await server.getTransaction(hash);
      if (r.status !== S.rpc.Api.GetTransactionStatus.NOT_FOUND) return r;
      if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the transaction");
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }

  // Finds the transaction that emitted an event in a known ledger. The RPC
  // keeps events for about a week on testnet; older ones return null.
  async function findEventTx(contractId, topics, ledger) {
    try {
      const res = await server.getEvents({
        startLedger: Number(ledger),
        filters: [{ type: "contract", contractIds: [contractId], topics: [topics] }],
        limit: 100,
      });
      const ev = res.events && res.events[res.events.length - 1];
      return ev ? { txHash: ev.txHash, ledger: ev.ledger } : null;
    } catch (e) {
      return null;
    }
  }

  function topicSymbol(name) {
    return S.xdr.ScVal.scvSymbol(name).toXDR("base64");
  }

  function topicString(s) {
    return S.nativeToScVal(s, { type: "string" }).toXDR("base64");
  }

  function topicBytes(hex) {
    return bytes32(hex).toXDR("base64");
  }

  function shortAddr(a) {
    return a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a;
  }

  // Formats an integer amount in the asset's smallest unit (bigint) with the
  // given number of decimals, dropping trailing zeros beyond two places.
  function formatUnits(value, decimals) {
    const v = BigInt(value);
    const neg = v < 0n;
    const abs = neg ? -v : v;
    const base = 10n ** BigInt(decimals);
    const whole = (abs / base).toLocaleString("en-US");
    let frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
    if (frac.length < 2) frac = frac.padEnd(2, "0");
    return `${neg ? "-" : ""}${whole}.${frac}`;
  }

  function formatTime(unixSeconds) {
    const d = new Date(Number(unixSeconds) * 1000);
    return d.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      timeZoneName: "short",
    });
  }

  function param(name) {
    return new URLSearchParams(location.search).get(name);
  }

  window.Soroban = {
    S, net, server, DEFAULT_CONTRACTS, ContractError, contractErrorCode,
    isContractId, isHash, bytes32, hexToBytes, bytesToHex, buildCall, read, waitFor,
    findEventTx, topicSymbol, topicString, topicBytes, shortAddr, formatUnits, formatTime, param,
  };
})();
