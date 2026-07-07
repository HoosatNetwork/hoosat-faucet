import { dpc, html, css, BaseElement, FlowFormat } from "/flow/flow-ux/flow-ux.js";
import { Decimal } from "/flow/flow-ux/extern/decimal.js";
import { HTN } from "./htn.js";

const getAddressPrefix = (network) => (network === "hoosat-mainnet" ? "hoosat" : "hoosattest");

export class FaucetForm extends BaseElement {
  static get properties() {
    return {
      errorMessage: { type: String },
      network: { type: String },
      networks: { type: Array },
      address: { type: String },
    };
  }
  static get styles() {
    return css`
      :host {
        display: block;
        max-width: 100%;
      }
      flow-select {
        margin: 8px 0px;
      }
      .error {
        color: red;
        min-height: 30px;
        padding: 16px;
        box-sizing: border-box;
        font-family: "Open Sans";
        font-size: 16px;
      }
      .message {
        margin: 30px 0px;
        font-family: "Open Sans";
        font-size: 16px;
        font-weight: normal;
      }
    `;
  }

  constructor() {
    super();
    this.networks = [];
    this.address = "";
  }

  onlineCallback() {
    const { rpc } = flow.app;
  }

  offlineCallback() { }

  render() {
    const { aliases } = flow.app;
    const addressPrefix = getAddressPrefix(this.network);
    return html`
      <div class="message">Enter your address and the amount of Hoosat you want to receive:</div>
      <flow-input
        label="Address (Must start with '${addressPrefix}:' prefix)"
        class="address"
        x-value="${this.address}"
      ></flow-input>
      <flow-input label="Amount (HTN)" class="amount" value=""></flow-input>
      <flow-select label="Network" selected="${this.network}" class="network" @select=${this.networkChange}>
        ${this.networks.map((n) => html`<flow-menu-item value="${n}">${aliases[n]}</flow-menu-item>`)}
      </flow-select>
      <div class="error">${this.errorMessage}</div>
      <flow-btn primary @click="${this.submit}">SUBMIT</flow-btn>
    `;
  }

  submit() {
    let qS = this.renderRoot.querySelector.bind(this.renderRoot);
    let address = qS(".address").value;
    let network = qS(".network").value;
    let amount = qS(".amount").value;
    const addressPrefix = getAddressPrefix(network);

    console.log({ address, network, amount });

    if (!address) return this.setError("Please enter address");

    if (!address.startsWith(`${addressPrefix}:`)) {
      return this.setError(`Invalid address for ${flow.app.aliases?.[network] || network}. Use ${addressPrefix}:`);
    }

    amount = parseFloat(amount.replace(",", ".")) || 0;
    if (!amount || amount < 1e-8 || amount > 100000) return this.setError("Please enter amount between 0.0000001-0.35");

    amount = Decimal(amount).mul(1e8);

    this.setError(false);

    const duration = (v) => {
      let hrs = Math.floor(v / 1000 / 60 / 60);
      let min = Math.floor((v / 1000 / 60) % 60);
      let sec = Math.floor((v / 1000) % 60);
      if (!hrs && !min && !sec) v;
      let t = "";
      if (hrs) t += (hrs < 10 ? "0" + hrs : hrs) + " h ";
      if (hrs || min) t += (min < 10 ? "0" + min : min) + " m ";
      if (hrs || min || sec) t += (sec < 10 ? "0" + sec : sec) + " s ";
      return t;
    };

    flow.app.rpc.request(
      "faucet-request",
      {
        address,
        network,
        amount,
      },
      (error, result) => {
        console.log({ error, result });
        if (error) {
          let msg = "";
          if (error.error == "limit") {
            let { period, available } = error;
            msg = html`Unable to send funds: you have <b>${HTN(available)}</b> HTN
              ${period == null
                ? html`available.`
                : html`remaining.<br />&nbsp;<br />Your limit will update in ${FlowFormat.duration(period)}.`}`;
          } else {
            msg = error.error || error.toString();

            if (/ApiError/.test(msg)) {
              msg = html`<div class="api-error">${[msg].map((v) => html`${v}<br />`)}</div>`;
            }
          }

          FlowDialog.show({
            title: html`<b class="error">Error</b>`,
            body: html` <div class="msg">${msg}</div> `,
            cls: "custom",
            btns: ["Close:primary:close"],
          });

          return;
        }

        FlowDialog.show({
          title: "Success",
          body: html`
            <div class="msg">
              We have successfully sent
              <b>${HTN(result.amount)} HTN</b> to the requested address:<br />&nbsp;<br />
              <b>${address}</b><br />&nbsp;<br />
              <span class="txid"><nobr>TXID: ${result.txid}</nobr></span>
            </div>
          `,
          cls: "custom",
          btns: ["Close:primary:close"],
        });
      }
    );
  }

  setError(err) {
    if (!err) {
      this.errorMessage = "";
      return;
    }

    this.errorMessage = err.error || err;
  }

  networkChange({ detail: { selected: network } }) {
    this.fire("network-change", { network });
  }
}

FaucetForm.define("faucet-form");
