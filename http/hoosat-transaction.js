import { dpc, html, css, BaseElement } from "/flow/flow-ux/flow-ux.js";
import { HTN } from "./htn.js";

export class HoosatTransaction extends BaseElement {
  static get properties() {
    return {
      data: { type: Object },
    };
  }

  static get styles() {
    return css`
      :host {
        display: block;
        margin: 2px;
      }
      .transaction {
        margin-top: 4px;
        align-items: center;
      }
      .transaction :nth-child(1) {
        width: var(--value-column-width);
        text-align: center;
      }
      .transaction :nth-child(2) {
        width: var(--blue-score-column-width);
        text-align: center;
      }
      .transaction :nth-child(3) {
        width: var(--txid-column-width);
      }
      .caption {
        font-family: "Open Sans";
        font-size: 14px;
      }
      .value {
        font-family: "Consolas";
        font-size: 16px;
        color: #666;
      }
      .value > a {
        display: block;
        width: 100%;
        font-family: "Consolas";
        font-size: 16px;
        color: #666;
        text-decoration: none;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
      }
      .value > a:hover {
        text-decoration: underline;
        color: var(--flow-primary-color, #007bff);
      }
      [row] {
        display: flex;
        flex-direction: row;
      }
      [col] {
        display: flex;
        flex-direction: column;
      }
    `;
  }

  constructor() {
    super();
    this.data = {};
  }

  formatTimestamp(timestamp) {
    if (!timestamp) return "Pending";

    let ts = Number(timestamp);
    if (isNaN(ts)) return timestamp;

    if (ts < 10000000000) {
      ts = ts * 1000;
    }

    const date = new Date(ts);

    return date.getFullYear() + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0') + ' ' +
      String(date.getHours()).padStart(2, '0') + ':' +
      String(date.getMinutes()).padStart(2, '0') + ':' +
      String(date.getSeconds()).padStart(2, '0');
  }

  render() {
    const tx = this.data || {};

    const txid = tx.txid || tx.transactionId || tx.outpoint?.transactionId || "";
    const rawTime = tx.txTime || tx.time || tx.block_time || tx.transaction?.block_time || "";
    const humanTime = this.formatTimestamp(rawTime);
    const amountVal = tx.amount || 0;

    return html`
      <div class="transaction" row>
        <div class="value">${(amountVal > 0 ? " " : "") + HTN(amountVal, true)}</div>
        <div class="value">${humanTime}</div>
        <div class="value">
          <a href="https://explorer.hoosat.fi/txs/${txid || ''}" target="_blank" rel="noopener noreferrer">
            ${txid ? txid.substring(0, 12) + ".." : 'N/A'}
          </a>
        </div>
      </div>
    `;
  }
}

HoosatTransaction.define("hoosat-transaction");