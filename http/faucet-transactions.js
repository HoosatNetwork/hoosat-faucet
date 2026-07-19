import { dpc, html, css, BaseElement } from "/flow/flow-ux/flow-ux.js";
import { Decimal } from "/flow/flow-ux/extern/decimal.js";

export class FaucetTransactions extends BaseElement {
  static get properties() {
    return {
      transactions: { type: Object },
      network: { type: String },
      limit: { type: Number },
    };
  }

  static get styles() {
    return css`
      :host {
        display: block;
        margin-top: 16px;
      }
      .caption {
        font-family: "Open Sans";
        font-size: 14px;
      }
      .headers {
        font-family: "Open Sans";
        font-size: 10px;
        margin-top: 16px;
        display: flex;
        flex-direction: row;
      }
      .headers :nth-child(1) {
        width: var(--value-column-width);
        text-align: center;
      }
      .headers :nth-child(2) {
        width: var(--blue-score-column-width);
        text-align: center;
      }
      .headers :nth-child(3) {
        width: var(--txid-column-width);
      }
      .transactions {
        margin-top: 4px;
      }
    `;
  }

  constructor() {
    super();
    this.transactions = {};
    this.limit = 15;
    this.transactionUpdates = null;
  }

  async onlineCallback() {
    const { rpc } = flow.app;
    const faucetAddress = "hoosat:qrlrgxpafeurkhda2u4n8rtwfsyya7f049q6w7a7nv36eun3qlcx29jdp0795";

    // 1. Fetch historical address transactions from the REST API
    try {
      const targetAddress = encodeURIComponent(faucetAddress);
      const res = await fetch(`https://api.network.hoosat.fi/addresses/${targetAddress}/full-transactions?limit=${this.limit}&offset=0&resolve_previous_outpoints=no`, {
        headers: { 'accept': 'application/json' }
      });

      if (res.ok) {
        const apiData = await res.json();

        const historicalTx = Array.isArray(apiData) ? apiData.map(item => {
          // Fallback extraction depending on if payload puts properties at root or under a transaction object
          const txObj = item.transaction || item;
          const txid = txObj.transaction_id || item.transaction_id || "";
          const txTime = txObj.block_time || item.block_time || "";

          // Find the specific output directed to our faucet address to display the proper amount
          let amount = 0;
          const outputs = txObj.outputs || item.outputs || [];
          const targetOutput = outputs.find(o => o.script_public_key_address === faucetAddress);
          if (targetOutput) {
            amount = targetOutput.amount;
          } else if (outputs.length > 0) {
            amount = outputs[0].amount; // Fallback to first output if specific match missing
          }

          // Return uniform schema matching both the subcomponent requirements and standard fallback names
          return {
            amount: amount,
            txid: txid,
            txTime: txTime,
            outpoint: {
              transactionId: txid,
              index: 0
            }
          };
        }) : [];

        this.transactions = {
          ...this.transactions,
          [this.network]: historicalTx
        };
      }
    } catch (err) {
      console.error("Failed to fetch historical faucet transactions:", err);
    }

    // 2. Setup real-time updates from RPC stream
    this.transactionUpdates = rpc.subscribe(`utxo-change`);
    (async () => {
      for await (const msg of this.transactionUpdates) {
        const { network, added } = msg.data;

        const currentList = this.transactions[network] ? [...this.transactions[network]] : [];

        added.forEach((tx) => {
          // Normalize the stream input properties to maintain exact field parity
          const txid = tx.outpoint?.transactionId || tx.txid || "";
          const txTime = tx.block_time || tx.block_time || "";

          currentList.unshift({
            ...tx,
            txid: txid,
            txTime: txTime,
            outpoint: tx.outpoint || { transactionId: txid, index: 0 }
          });
        });

        while (currentList.length > this.limit) {
          currentList.pop();
        }

        this.transactions = {
          ...this.transactions,
          [network]: currentList
        };
      }
    })().catch(err => console.error("Transaction stream error:", err));
  }

  offlineCallback() {
    if (this.transactionUpdates) {
      this.transactionUpdates.stop();
    }
  }

  render() {
    const transactions = this.transactions[this.network] || [];
    return html`
      <div class="wrapper">
        <div class="caption">Faucet Transactions</div>
        <div class="headers">
          <div>VALUE (HTN)</div>
          <div>Time</div>
          <div>TXID</div>
        </div>
        <div class="transactions">
          ${transactions.map((tx) => html`<hoosat-transaction .data=${tx}></hoosat-transaction>`)}
        </div>
      </div>
    `;
  }
}

FaucetTransactions.define("faucet-transactions");