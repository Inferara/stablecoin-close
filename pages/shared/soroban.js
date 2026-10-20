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
    invoice_settlement: "CAQYJWSOIQRYGZPPQDKBTUTJBKBO3F7BW6BVNVTGTWJIMSDSLLKO43M4",
    report_anchor: "CDHTWZXASJ4MDG6RM5M6H2ANNRDZADSC522QH5I5GEM4WDESXQ2QMOAN",
  };

  // Stellar Asset Contracts the pages know by name. An asset's own symbol()
  // is not trusted for display: any contract can call itself "USDC".
  const KNOWN_ASSETS = {
    CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA: {
      code: "USDC", decimals: 7, issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    },
    CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ: {
      code: "EURC", decimals: 7, issuer: "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO",
    },
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

  function isAccountId(s) {
    return typeof s === "string" && /^G[A-Z2-7]{55}$/.test(s) && S.StrKey.isValidEd25519PublicKey(s);
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

  // Finds the transaction that emitted an event in a known ledger: the first
  // event in exactly that ledger whose topics match and, when `match` is
  // given, whose data passes it. The RPC keeps events for about a week on
  // testnet; older ones return null.
  async function findEventTx(contractId, topics, ledger, match) {
    try {
      const res = await server.getEvents({
        startLedger: Number(ledger),
        filters: [{ type: "contract", contractIds: [contractId], topics: [topics] }],
        limit: 100,
      });
      const ev = (res.events || []).find(
        (e) => e.ledger === Number(ledger) && (!match || match(S.scValToNative(e.value))),
      );
      return ev ? { txHash: ev.txHash, ledger: ev.ledger } : null;
    } catch (e) {
      return null;
    }
  }

  // --- Signing with Freighter (payer and anchor pages) ---

  async function freighter() {
    const f = window.freighterApi;
    if (!f) throw new Error("The Freighter library did not load. Reload the page.");
    const c = await f.isConnected();
    if (!c || !c.isConnected) {
      throw new Error("Freighter is not installed. Install the Freighter browser extension (freighter.app) and reload.");
    }
    return f;
  }

  // Asks Freighter for access and returns the wallet's address, refusing a
  // wallet set to another network.
  async function connectFreighter() {
    const f = await freighter();
    const access = await f.requestAccess();
    if (access.error) throw new Error(access.error.message || String(access.error));
    const details = await f.getNetworkDetails();
    if (details.error) throw new Error(details.error.message || String(details.error));
    if (details.networkPassphrase !== net.passphrase) {
      throw new Error("Freighter is on another network. Switch it to Testnet and try again.");
    }
    return access.address;
  }

  // Builds a contract call from `address` and simulates it, so the
  // transaction carries its footprint, fee and auth entries. Simulation
  // errors surface as ContractError when the contract refused.
  async function prepareCall(address, contractId, method, args) {
    let account;
    try {
      account = await server.getAccount(address);
    } catch (e) {
      throw new Error("This wallet account does not exist on testnet yet. Fund it with Friendbot first.");
    }
    try {
      return await server.prepareTransaction(buildCall(account, contractId, method, args));
    } catch (e) {
      const code = contractErrorCode(e && (e.message || e));
      if (code !== null) throw new ContractError(code, String(e.message || e));
      throw e;
    }
  }

  // Signs a prepared transaction in Freighter, submits it and waits for the
  // result. `onStep` gets "sign" and "send" for button labels.
  async function signAndSubmit(prepared, address, onStep = () => {}) {
    const f = await freighter();
    onStep("sign");
    const signed = await f.signTransaction(prepared.toXDR(), {
      networkPassphrase: net.passphrase,
      address,
    });
    if (signed.error) throw new Error(signed.error.message || String(signed.error));
    onStep("send");
    const sent = await server.sendTransaction(S.TransactionBuilder.fromXDR(signed.signedTxXdr, net.passphrase));
    if (sent.status === "ERROR") throw new Error("The network rejected the transaction.");
    const done = await waitFor(sent.hash);
    if (done.status !== S.rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`The transaction failed (${done.status}).`);
    }
    return { hash: sent.hash, ledger: done.ledger };
  }

  // --- Checking what a prepared transaction asks the wallet to sign ---

  // stellar-sdk 17 decodes XDR into plain objects (properties, not the
  // accessor methods of earlier versions).
  function symbolText(name) {
    if (typeof name === "string") return name;
    const bytes = name && name.bytes !== undefined ? name.bytes : name;
    return bytes instanceof Uint8Array ? new TextDecoder().decode(bytes) : String(bytes);
  }

  function describeContractCall(args) {
    return {
      contract: S.Address.fromScAddress(args.contractAddress).toString(),
      fn: symbolText(args.functionName),
      args: args.args.map((v) => S.scValToNative(v)),
    };
  }

  function sameValue(a, b) {
    if (a instanceof Uint8Array || b instanceof Uint8Array) {
      return typeof a === "object" && typeof b === "object" && bytesToHex(a) === bytesToHex(b);
    }
    return typeof a === "bigint" || typeof b === "bigint" ? BigInt(a) === BigInt(b) : a === b;
  }

  function sameCall(call, want) {
    return call.contract === want.contract && call.fn === want.fn &&
      call.args.length === want.args.length && call.args.every((v, i) => sameValue(v, want.args[i]));
  }

  // Throws unless `prepared` is exactly one call of `want.call`, from `source`,
  // whose only authorization is that call with exactly `want.subCalls` under it
  // (each with nothing further below). `want.call` and `want.subCalls[i]` are
  // { contract, fn, args } with args as native values (bytes as Uint8Array).
  function checkAuthTree(prepared, source, want) {
    const fail = (why) => { throw new Error(`Refusing to sign: ${why}.`); };
    if (prepared.source !== source) fail("the transaction is not sent from your wallet");
    if (prepared.operations.length !== 1) fail("the transaction contains more than one operation");
    const op = prepared.operations[0];
    if (op.type !== "invokeHostFunction" || !op.func || op.func.type !== "hostFunctionTypeInvokeContract") {
      fail("the transaction is not a contract call");
    }
    if (!sameCall(describeContractCall(op.func.invokeContract), want.call)) fail("the transaction calls something else");
    const auth = op.auth || [];
    if (auth.length !== 1) fail(`the transaction asks for ${auth.length} authorizations instead of one`);
    const cred = auth[0].credentials;
    if (cred.type === "sorobanCredentialsAddress") {
      if (S.Address.fromScAddress(cred.address.address).toString() !== source) fail("the authorization is for another account");
    } else if (cred.type !== "sorobanCredentialsSourceAccount") {
      fail("the authorization has unknown credentials");
    }
    const contractFn = (inv) => {
      if (inv.function.type !== "sorobanAuthorizedFunctionTypeContractFn") fail("the authorization covers a non-call");
      return describeContractCall(inv.function.contractFn);
    };
    const root = auth[0].rootInvocation;
    if (!sameCall(contractFn(root), want.call)) fail("the authorization is for another call");
    const subs = root.subInvocations;
    if (subs.length !== want.subCalls.length) fail("the authorization covers more than expected");
    subs.forEach((sub, k) => {
      if (!sameCall(contractFn(sub), want.subCalls[k]) || sub.subInvocations.length !== 0) {
        fail("the authorization would move funds differently from what is shown");
      }
    });
  }

  // Copies text and briefly confirms on the button.
  function copyButton(button, text) {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text());
        const was = button.textContent;
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = was; }, 1200);
      } catch (e) {
        /* clipboard refused: the full value is in the title attribute */
      }
    });
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
    S, net, server, DEFAULT_CONTRACTS, KNOWN_ASSETS, ContractError, contractErrorCode,
    isContractId, isAccountId, isHash, bytes32, hexToBytes, bytesToHex, buildCall, read, waitFor,
    findEventTx, connectFreighter, prepareCall, signAndSubmit, checkAuthTree, copyButton, topicSymbol, topicString, topicBytes, shortAddr, formatUnits, formatTime, param,
  };
})();
