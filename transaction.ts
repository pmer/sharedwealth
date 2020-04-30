"use strict";

import * as utils from './utils.js';

import { Balances, Key, Outputs, Signature } from './types.js';

// String constants mixed in before hashing.
const TX_CONST = 'TX';

/**
 * A transaction comes from a single account, specified by "address". For
 * each account, transactions have an order established by the nonce. A
 * transaction should not be accepted if the nonce has already been used.
 * (Nonces are in increasing order, so it is easy to determine when a nonce
 * has been used.)
 */
export default class Transaction {
  from: string;
  nonce: number;
  pubKey: Key;
  sig?: Signature;
  fee: number;
  outputs: Outputs;

  /**
   * The constructor for a transaction includes an array of outputs, meaning
   * that one transaction can pay multiple parties. An output is a pair of an
   * amount of gold and the hash of a public key (also called the address),
   * in the form:
   *    {amount, address}
   * 
   * @constructor
   * @param {Object} obj - The inputs and outputs of the transaction.
   * @param obj.from - The address of the payer.
   * @param obj.nonce - Number that orders the payer's transactions.  For coinbase
   *          transactions, this should be the block height.
   * @param obj.pubKey - Public key associated with the specified from address.
   * @param obj.sig - Signature of the transaction.  This field may be ommitted.
   * @param obj.fee - The amount of gold offered as a transaction fee.
   * @param {Array} obj.outputs - An array of the outputs.
   */
  constructor({
    from,
    nonce,
    pubKey,
    sig,
    outputs,
    fee = 0
  }: {
    from: string;
    nonce: number;
    pubKey: Key;
    sig?: Signature;
    outputs: Outputs;
    fee: number;
  }) {
    this.from = from;
    this.nonce = nonce;
    this.pubKey = pubKey;
    this.sig = sig;
    this.fee = fee;
    this.outputs = outputs;
  }

  /**
   * A transaction's ID is derived from its contents.
   */
  get id(): string {
    return utils.hash(TX_CONST + JSON.stringify({
      from: this.from,
      nonce: this.nonce,
      pubKey: this.pubKey,
      outputs: this.outputs,
      fee: this.fee
    }));
  }

  /**
   * Signs a transaction and stores the signature in the transaction.
   * 
   * @param privKey  - The key used to sign the signature.  It should match the
   *    public key included in the transaction.
   */
  sign(privKey: Key): void {
    this.sig = utils.sign(privKey, this.id);
  }

  /**
   * Determines whether the signature of the transaction is valid
   * and if the from address matches the public key. This method
   * is not relevant for coinbase transactions.
   * 
   * @returns {Boolean} - Validity of the signature and from address.
   */
  validSignature(): boolean {
    return this.sig !== undefined &&
        utils.addressMatchesKey(this.from, this.pubKey) &&
        utils.verifySignature(this.pubKey, this.id, this.sig);
  }

  sufficientFunds(balances: Balances): boolean {
    const balance = balances.get(this.from);
    if (balance === undefined) {
      return false;
    }
    return this.totalOutput() <= balance;
  }

  /**
   * Calculates the total value of all outputs, including the transaction fee.
   * 
   * @returns {Number} - Total amount of gold given out with this transaction.
   */
  totalOutput(): number {
    return this.outputs.reduce( (totalValue, {amount}) => totalValue + amount, this.fee);
  }
}
