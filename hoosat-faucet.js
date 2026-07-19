const path = require("path");
const crypto = require("crypto");
const EventEmitter = require("events");
const FlowRouter = require("@aspectron/flow-router");
const utils = require("@aspectron/flow-utils");
//require("colors");
const fs = require("fs");
const args = utils.args();
const sockjs = require("sockjs");
const session = require("express-session");
const express = require("express");
const bodyParser = require("body-parser");
const Cookie = require("cookie");
const CookieSignature = require("cookie-signature");
const { Command, CommanderError } = require("commander");
const ws = require("ws");

if (typeof globalThis.fetch !== "function") {
  const fetch = require("node-fetch");
  globalThis.fetch = fetch;
  globalThis.Headers = fetch.Headers;
  globalThis.Request = fetch.Request;
  globalThis.Response = fetch.Response;
}

function createSessionCompat(sessionFactory) {
  const compatSession = (options) => {
    const middleware = sessionFactory(options);

    return (req, res, next) => {
      if (typeof res.writeHead !== "function") {
        res.writeHead = () => res;
      }

      if (typeof res.write !== "function") {
        res.write = () => true;
      }

      if (typeof res.end !== "function") {
        res.end = () => res;
      }

      if (typeof res.getHeader !== "function") {
        res.getHeader = () => undefined;
      }

      if (typeof res.setHeader !== "function") {
        res.setHeader = () => undefined;
      }

      if (typeof res._implicitHeader !== "function") {
        res._implicitHeader = () => {
          res._header = true;
          return res;
        };
      }

      return middleware(req, res, next);
    };
  };

  Object.assign(compatSession, sessionFactory);
  return compatSession;
}

const { FlowHttp } = require("@aspectron/flow-http")({
  express,
  session: createSessionCompat(session),
  //sockjs,
  ws,
  Cookie,
  CookieSignature,
});
const Decimal = require("decimal.js");
const { Wallet, initHoosatFramework, log } = require("@hoosat/wallet");

const { RPC } = require("@kaspa/grpc-node");
const DAY = 1000 * 60 * 60 * 24;
const HOUR = 1000 * 60 * 60;
const MIN = 1000 * 60;

class HoosatFaucet extends EventEmitter {
  constructor(appFolder) {
    super();
    this.appFolder = appFolder;
    this.config = utils.getConfig(path.join(appFolder, "config", "hoosat-faucet"));
    this.ip_limit_map = new Map();
    this.address_limit_map = new Map();
    this.cache = {};

    this.options = {
      limit: 200,
      rpc: "127.0.0.1:42420",
      host: "0.0.0.0",
      port: 3099,
    };

  }

  async submitWalletTransaction(network, tx) {
    const wallet = this.wallets[network];
    if (!wallet) {
      throw new Error(`Wallet interface is not active for network ${network}`);
    }

    log.info(`Submitting faucet transaction on ${network} to ${tx.toAddr} for ${Wallet.HTN(tx.amount)}`);
    try {
      const response = await wallet.submitTransaction(tx);
      await this.refreshWalletState(network);
      log.info(`Faucet transaction submitted on ${network}: ${response?.txid || "no-txid"}`);
      return response;
    } catch (error) {
      if (!/Insufficient balance/.test(error?.message || "")) {
        throw error;
      }

      log.warn(`[${network}] Wallet reported insufficient balance, refreshing tracked UTXOs and retrying once`);
      await this.refreshWalletState(network);

      const response = await wallet.submitTransaction(tx);
      await this.refreshWalletState(network);
      log.info(`Faucet transaction submitted on ${network}: ${response?.txid || "no-txid"}`);
      return response;
    }
  }

  async refreshWalletState(network) {
    const wallet = this.wallets[network];
    const address = this.addresses[network];
    if (!wallet || !address) {
      return;
    }

    const utxosMap = await wallet.api.getUtxosByAddresses([address]);
    const latestUtxos = utxosMap.get(address) || [];
    const latestIds = new Set(latestUtxos.map((utxo) => utxo.transactionId + utxo.index));
    const staleIds = [];

    [wallet.utxoSet.utxos.confirmed, wallet.utxoSet.utxos.pending, wallet.utxoSet.utxos.used].forEach((collection) => {
      collection.forEach((utxo, utxoId) => {
        if (String(utxo.address) === address && !latestIds.has(utxoId)) {
          staleIds.push(utxoId);
        }
      });
    });

    if (staleIds.length) {
      wallet.utxoSet.remove([...new Set(staleIds)]);
    }

    wallet.utxoSet.utxoStorage[address] = latestUtxos;
    wallet.utxoSet.add(latestUtxos, address);
    wallet.utxoSet.clearMissing();
    wallet.updateDebugInfo();
    wallet.emitBalance();
  }

  async initHttp() {
    const { host, port } = this.options;

    let flowHttp = new FlowHttp(__dirname, {
      config: {
        websocketMode: "RPC",
        websocketPath: "/rpc",
        http: {
          host,
          port,
          session: {
            secret: "34343546756767567657534578678672346573237436523798",
            key: "hoosat-faucet-website",
          },
        },
        staticFiles: {
          "/": "http",
        },
      },
    });
    this.flowHttp = flowHttp;

    flowHttp.on("app.init", (args) => {
      let { app } = args;
      app.use(bodyParser.json());
      app.use(bodyParser.urlencoded({ extended: true }));

      let rootFolder = this.appFolder;

      let router = new FlowRouter(app, {
        mount: {
          flowUX: "/flow/flow-ux",
          litHtml: "/lit-html",
          litElement: "/lit-element",
          webcomponents: "/webcomponentsjs",
          sockjs: "/sockjs",
        },
        rootFolder,
        folders: [{ url: "/http", folder: path.join(rootFolder, "http") }],
      });
      router.init();
    });

    flowHttp.init();
  }

  async initHoosat() {
    await initHoosatFramework();

    const aliases = Object.keys(Wallet.networkAliases);
    let filter = aliases
      .map((alias) => {
        console.log(alias);
        return this.options[alias] ? Wallet.networkAliases[alias] : null;
      })
      .filter((v) => v);

    this.rpc = {};
    this.wallets = {};
    this.addresses = {};
    this.limits = {};

    if (this.options.rpc && filter.length != 1) {
      log.error("You must explicitly use the network flag when specifying the RPC option");
      log.error("Option required: --mainnet, --testnet, --devnet, --simnet");
      process.exit(1);
    }

    const seeds = fs.readFileSync(".seeds") + "";
    for (const { network, port } of Object.values(Wallet.networkTypes)) {
      if (filter.length && !filter.includes(network)) {
        log.verbose(`Skipping creation of '${network}'...`);
        continue;
      }
      console.log(`network: ${network}`);
      const host = this.options.rpc || `127.0.0.1:${port}`;
      log.info(`Creating gRPC binding for network '${network}' at ${host}`);
      const rpc = (this.rpc[network] = new RPC({ clientConfig: { host } }));
      rpc.onError((error) => {
        log.error(`gRPC[${host}] ${error}`);
      });

      this.wallets[network] = Wallet.fromMnemonic(
        seeds,
        { network: network.replace("hoosat-", ""), rpc },
        { disableAddressDerivation: true }
      );
      console.log(this.wallets);

      this.addresses[network] = await this.wallets[network].receiveAddress;
      console.log(this.addresses);
      this.limits[network] =
        this.options.limit === false
          ? Number.MAX_SAFE_INTEGER
          : Decimal(this.options.limit || 0.35)
            .mul(1e8)
            .toNumber();
      this.wallets[network].setLogLevel(log.level);

      log.info(`${Wallet.networkTypes[network]?.name} address - ${this.addresses[network]}`);
    }

    this.networks = Object.keys(this.wallets);
  }

  generateCaptcha(socket) {
    const num1 = Math.floor(Math.random() * 10) + 1;
    const num2 = Math.floor(Math.random() * 10) + 1;

    // Store answer directly safely referenced to this active socket session context
    socket.captchaAnswer = num1 + num2;

    socket.publish("captcha-challenge", {
      question: `${num1} + ${num2} = ?`
    });
  }

  calculateAvailable({ network, ip, address }) {
    if (this.limits[network] == Number.MAX_SAFE_INTEGER) return { available: Number.MAX_SAFE_INTEGER, period: null };

    const ts = Date.now();
    const period_start = ts - DAY;

    // Get clean transaction histories for both constraints
    let ipHistory = (this.ip_limit_map.get(ip)?.[network] || []).filter(tx => tx.ts > period_start);
    let addrHistory = (address && address !== "default")
      ? (this.address_limit_map.get(address)?.[network] || []).filter(tx => tx.ts > period_start)
      : [];

    // Calculate spent amounts for both paths independently
    const ipSpent = ipHistory.reduce((v, tx) => tx.amount + v, 0);
    const addrSpent = addrHistory.reduce((v, tx) => tx.amount + v, 0);

    // The current available balance is constrained by whichever limit has less room left
    const ipAvailable = this.limits[network] - ipSpent;
    const addrAvailable = this.limits[network] - addrSpent;
    const available = Math.min(ipAvailable, addrAvailable);

    // Capture the time remaining until the oldest window clears
    let longestHistory = ipSpent > addrSpent ? ipHistory : addrHistory;
    const period = longestHistory.length ? longestHistory[0].ts - period_start : null;

    log.info(`Limit Check -> IP Spent: ${ipSpent / 1e8}, Addr Spent: ${addrSpent / 1e8}. Available: ${available / 1e8} HTN`);
    return { available, period };
  }

  updateLimit({ network, ip, address, amount }) {
    if (this.limits[network] == Number.MAX_SAFE_INTEGER) return;

    const txRecord = { ts: Date.now(), amount };

    // 1. Force record insertion into IP map
    if (ip) {
      if (!this.ip_limit_map.has(ip)) this.ip_limit_map.set(ip, {});
      const ipUser = this.ip_limit_map.get(ip);
      if (!ipUser[network]) ipUser[network] = [];
      ipUser[network].push(txRecord);
    }

    // 2. Force record insertion into Address map
    if (address && address !== "default") {
      if (!this.address_limit_map.has(address)) this.address_limit_map.set(address, {});
      const addrUser = this.address_limit_map.get(address);
      if (!addrUser[network]) addrUser[network] = [];
      addrUser[network].push(txRecord);
    }
  }

  publishLimit({ network, socket, ip }) {
    const limit = this.limits[network];
    const { available } = this.calculateAvailable({ network, ip, address: "default" });
    socket.publish(`limit`, { network, available, limit });
  }

  async initFaucet() {
    const { flowHttp } = this;
    let socketConnections = flowHttp.sockets.events.subscribe("connect");
    let lastUpdateEpoch = 0;
    let bpsArray = [];
    let prevBlueScore;
    (async () => {
      for await (const event of socketConnections) {
        const { networks, addresses, limits } = this;
        const { socket } = event;
        const ip = getIp(socket || msg);
        socket.publish("networks", { networks });
        socket.publish("addresses", { addresses });

        this.generateCaptcha(socket);

        networks.forEach((network) => {
          let wallet = this.wallets[network];

          if (!wallet) return;
          const { balance } = wallet;
          socket.publish(`balance`, { network, balance });
          this.publishLimit({ network, socket, ip });

          let cache = this.cache[network];
          if (cache && cache.length) {
            cache.forEach((msg) => {
              socket.publish(`utxo-change`, msg);
            });
          }
        });
      }
    })();


    let captchaRequests = flowHttp.sockets.subscribe("get-captcha");
    (async () => {
      for await (const msg of captchaRequests) {
        const { socket } = msg;
        if (socket) {
          const num1 = Math.floor(Math.random() * 10) + 1;
          const num2 = Math.floor(Math.random() * 10) + 1;

          // Leet speak mapping for digits 1 to 10
          const leetWords = [
            "z3r0", "0n3", "tw0", "thr33", "f0ur",
            "f1v3", "s1x", "s3v3n", "31ght", "n1n3", "t3n"
          ];

          // Helper function to randomly capitalize each character in a string
          const randomizeCase = (str) =>
            str.split("").map(char => Math.random() > 0.5 ? char.toUpperCase() : char.toLowerCase()).join("");

          const word1 = randomizeCase(leetWords[num1]);
          const word2 = randomizeCase(leetWords[num2]);
          const operation = randomizeCase("plu5");

          // Keep the exact numerical sum for validation
          socket.captchaAnswer = num1 + num2;

          // Respond with the randomized case leet speak question
          msg.respond({ question: `${word1} ${operation} ${word2} = ?` });
        }
      }
    })();


    let requests = flowHttp.sockets.subscribe("faucet-request");
    (async () => {
      for await (const msg of requests) {
        var { data, ip, socket } = msg;
        const { address, network, amount: amount_, captchaAnswer } = data;

        const expected = socket?.captchaAnswer;

        if (!expected || parseInt(captchaAnswer) !== expected) {
          msg.error("Invalid or missing CAPTCHA answer. Please try again.");
          continue;
        }

        const effectiveIp = getIp(socket || msg);
        ip = effectiveIp;

        const amount = parseInt(amount_);
        if (isNaN(amount) || !amount || amount < 0) {
          msg.error(`Invalid amount: ${amount_}`);
          continue;
        }

        if (!this.networks.includes(network)) {
          msg.error(`Unknown network ${network}`);
          continue;
        }
        const [prefix] = address.split(":");
        if (prefix != "hoosat" && prefix != "hoosattest") {
          msg.error(`Incompatible address ${address} for network ${network}`);
          continue;
        }

        if (!this.wallets[network]) {
          msg.error(`Wallet interface is not active for network ${network}`);
          continue;
        }

        // 1. Check availability BEFORE processing
        let { available, period } = this.calculateAvailable({ network, ip, address });
        if (available < amount) {
          msg.error({ error: "limit", available, period });
          continue;
        }

        // 2. IMMEDIATE LOCKOUT: Claim the limit space synchronously BEFORE yielding to await
        log.info(`[LOCK] Reserving ${Wallet.HTN(amount)} for IP: ${ip} / Addr: ${address}`);
        this.updateLimit({ network, ip, address, amount });

        try {
          const fee = 0;
          let response = await this.submitWalletTransaction(network, {
            toAddr: address,
            amount,
            fee,
            networkFeeMax: 1e8,
            calculateNetworkFee: true,
            changeAddrOverride: this.addresses[network],
          });

          const txid = response?.txid || null;
          ({ available, period } = this.calculateAvailable({ network, ip, address }));
          msg.respond({ amount, address, network, txid, available });
          this.publishLimit({ network, socket, ip });
        } catch (ex) {
          log.error(`Faucet transaction failed on ${network}: ${ex?.stack || ex}`);

          // 3. REFUND LIMIT: If it failed, remove this specific allocation from their history
          log.warn(`[REFUND] Reverting reserved amount for IP: ${ip} / Addr: ${address} due to failure`);
          this.refundLimit({ network, ip, address, amount });

          msg.error({ error: ex?.message || ex?.toString?.() || "Internal faucet failure" });
        }
      }
    })();

    const getIp = (msg) => {
      const headers = msg.headers;
      console.log(headers)
      // Prefer first entry in X-Forwarded-For (real client)
      let ip = (headers["x-forwarded-for"] && headers["x-forwarded-for"].split(',')[0].trim());

      if (ip && ip.startsWith('::ffff:')) ip = ip.substring(7);
      return ip || '127.0.0.1';
    };

    const getAvailable = async ({ network, ip }) => {
      if (!network || !/^hoosat(test|dev|sim)*/.test(network)) return { error: `Unknown network: ${network}` };

      network = network.split(":").shift();
      if (!this.networks.includes(network)) return { error: `Unknown network: ${network}` };

      let { available, period } = this.calculateAvailable({ network, ip, address: "default" });
      return { available, period };
    };

    const getHoosat = async ({ address, amount: amount_, ip }) => {
      const amount = parseInt(amount_);
      if (isNaN(amount) || !amount || amount < 0) return { error: `Invalid amount: ${amount_}` };
      if (!address || !/^hoosat(test|dev|sim)*:/.test(address)) return { error: `Invalid address: ${address}` };

      let network = address.split(":").shift();
      if (!this.networks.includes(network)) return { error: `Unknown network: ${network}` };
      if (!this.wallets[network]) return { error: `Wallet interface is not active for network ${network}` };

      let { available, period } = this.calculateAvailable({ network, ip, address });
      if (available < amount) {
        return {
          error: `Unable to send funds: limit reached.`,
        };
      }

      // Lock synchronously before running the async network wallet transaction
      this.updateLimit({ network, ip, address, amount });

      try {
        const fee = 0;
        let response = await this.submitWalletTransaction(network, {
          toAddr: address,
          amount,
          fee,
          networkFeeMax: 1e8,
          calculateNetworkFee: true,
          changeAddrOverride: this.addresses[network],
        });

        const txid = response?.txid || null;
        ({ available, period } = this.calculateAvailable({ network, ip, address }));
        return { success: true, amount, address, network, txid, available, period };
      } catch (ex) {
        // Refund if it fails
        this.refundLimit({ network, ip, address, amount });
        console.log(ex);
        return { error: "Internal faucet failure", info: ex.toString() };
      }
    };

    for (const [network, wallet] of Object.entries(this.wallets)) {
      wallet.sync().catch((e) => {
        console.log(`[${network}] syncVirtualSelectedParentBlueScore Error`, e);
      });

      wallet.on("ready", (result) => {
        log.info(`ready (${network})`);
        flowHttp.sockets.publish(`wallet-ready`, { network });
      });

      wallet.on("api-online", (result) => {
        log.info(`${network} - gRPC API is online`);
        flowHttp.sockets.publish(`wallet-online`, { network });
      });

      wallet.on("api-offline", (result) => {
        log.info(`${network} - gRPC API is offline`);
        flowHttp.sockets.publish(`wallet-offline`, { network });
      });

      wallet.on("sync-start", (result) => {
        flowHttp.sockets.publish(`sync-start`, { network });
      });

      wallet.on("sync-finish", (result) => {
        flowHttp.sockets.publish(`sync-finish`, { network });
      });

      wallet.on("blue-score-changed", (result) => {
        let { blueScore } = result;
        if (!prevBlueScore) {
          prevBlueScore = blueScore;
        }
        let avgPeriod = 30; // 30 second average
        let now = Date.now();
        let timeSinceLastUpdate = now - lastUpdateEpoch;
        if (timeSinceLastUpdate > 500) {
          lastUpdateEpoch = now;
          let blocks = blueScore - prevBlueScore;
          let bps = Math.round(10 * (blocks / (timeSinceLastUpdate / 1000))) / 10;
          prevBlueScore = blueScore;
          bpsArray.push(bps);
          while (bpsArray.length > avgPeriod) {
            bpsArray.shift();
          }
          let blocksSinceLastUpdate = Math.round(10 * (bpsArray.reduce((a, b) => a + b, 0) / bpsArray.length)) / 10;
          console.debug(
            `[${network}] blueScore: ${blueScore}, bps: ${(bps < 10 ? " " : "") + bps.toFixed(1)
            }, bps-30s: ${blocksSinceLastUpdate.toFixed(1)}, raw: [${bpsArray.join(", ")}]`
          );
          flowHttp.sockets.publish(`blue-score`, { blueScore, network, blocksSinceLastUpdate });
        }
      });

      wallet.on("balance-update", (detail) => {
        const { balance, available, pending } = detail;
        flowHttp.sockets.publish(`balance`, { network, balance: { available, pending } });
      });

      let seq = 0;
      this.cache[network] = [];
      wallet.on("utxo-change", (detail) => {
        let { added, removed } = detail;
        added = [...added.values()].flat();
        removed = [...removed.values()].flat();
        flowHttp.sockets.publish(`utxo-change`, { network, added, removed, seq: seq++ });
        this.cache[network].push({ network, added, removed, seq });
        while (this.cache[network].length > 24) this.cache[network].shift();
      });
    }
  }

  refundLimit({ network, ip, address, amount }) {
    if (this.limits[network] == Number.MAX_SAFE_INTEGER) return;

    const filterTx = (history) => {
      if (!history || !history[network]) return;
      // Find the index of the most recent item matching this amount to remove it
      const index = history[network].findIndex(tx => tx.amount === amount);
      if (index !== -1) {
        history[network].splice(index, 1);
      }
    };

    if (ip) filterTx(this.ip_limit_map.get(ip));
    if (address && address !== "default") filterTx(this.address_limit_map.get(address));
  }

  duration(v) {
    let hrs = Math.floor(v / 1000 / 60 / 60);
    let min = Math.floor((v / 1000 / 60) % 60);
    let sec = Math.floor((v / 1000) % 60);
    if (!hrs && !min && !sec) v;
    let t = "";
    if (hrs) t += (hrs < 10 ? "0" + hrs : hrs) + " h ";
    if (hrs || min) t += (min < 10 ? "0" + min : min) + " m ";
    if (hrs || min || sec) t += (sec < 10 ? "0" + sec : sec) + " s ";
    return t;
  }

  async main() {
    const logLevels = ["error", "warn", "info", "verbose", "debug"];
    const program = (this.program = new Command());
    program
      .version("0.0.1", "--version")
      .description("Hoosat Faucet")
      .helpOption("--help", "display help for command")
      .option("--log <level>", `set log level ${logLevels.join(", ")}`, (level) => {
        if (!logLevels.includes(level)) throw new Error(`Log level must be one of: ${logLevels.join(", ")}`);
        return level;
      })
      .option("--verbose", "log wallet activity")
      .option("--debug", "debug wallet activity")
      .option("--mainnet", "use mainnet network")
      .option("--testnet", "use testnet network")
      .option("--devnet", "use devnet network")
      .option("--simnet", "use simnet network")
      .option("--host <host>", "http host (default: localhost)", "localhost")
      .option("--port <port>", `set http port (default ${this.options.port})`, (port) => {
        port = parseInt(port);
        if (isNaN(port)) throw new Error("Port is not a number");
        if (port < 0 || port > 0xffff) throw new Error("Port number is out of range");
        return port;
      })
      .option("--limit <limit>", `HTN/day limit per IP`, (limit) => {
        limit = parseFloat(limit);
        if (isNaN(limit) || limit <= 0) throw new Error("HTN/day limit is invalid");
        return limit;
      })
      .option("--no-limit", "disable HTN/day limit")
      .option("--rpc <address>", "use custom RPC address <host:port>");

    program
      .command("run", { isDefault: true })
      .description("run faucet")
      .action(async () => {
        let options = program.opts();
        Object.entries(options).forEach(([k, v]) => {
          if (v === undefined) delete options[k];
        });
        Object.assign(this.options, options);

        log.level =
          (this.options.verbose && "verbose") || (this.options.debug && "debug") || this.options.log || "info";

        await this.initHttp();
        await this.initHoosat();
        await this.initFaucet();
      });

    program.parse();
  }

  HTN(v) {
    var [int, frac] = Decimal(v).mul(1e-8).toFixed(8).split(".");
    int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    frac = frac?.replace(/0+$/, "");
    return frac ? `${int}.${frac}` : int;
  }
}



(async () => {
  let hoosatFaucet = new HoosatFaucet(__dirname);
  try {
    await hoosatFaucet.main();
  } catch (ex) {
    console.log(ex.toString());
  }
})();
