"use strict";

import { BigInteger } from 'jsbn';

import Client from './client.js';
import Transaction from './transaction.js';

import { Balances, Nonces } from './types.js';
import { hash } from './utils.js';

const POW_BASE_TARGET = new BigInteger('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 16);

const COINBASE_AMT_ALLOWED = 25;

const GENESIS_REWARD_ADDR = '';
const GENESIS_PREV_BLOCK_HASH = '';

/**
 * A block is a collection of transactions, with a hash connecting it
 * to a previous block.
 */
export default class Block {
  chainLength: number;
  prevBlockHash: string;
  proof?: number;
  timestamp: number;
  target: BigInteger;
  coinbaseReward: number;
  rewardAddr: string;
  transactions: Map<string,Transaction>;

  balances: Balances;
  nextNonce: Nonces;

  static get HIT_POW_TARGET() { return POW_BASE_TARGET.shiftRight(15); }
  static get NEAR_MISS_POW_TARGET() { return POW_BASE_TARGET.shiftRight(18); }

  /**
   * Converts a string representation of a block to a new Block instance.
   * 
   * @param {string} str - A string representing a block in JSON format.
   * 
   * @returns {Block}
   */
  static deserialize(str: string): Block {
    const o = JSON.parse(str);

    const b = new Block(o.rewardAddr);
    b.proof = o.proof;
    b.timestamp = o.timestamp;
    b.chainLength = parseInt(o.chainLength);
    b.prevBlockHash = o.prevBlockHash;

    // Transactions need to be recreated and restored in a map.
    b.transactions = new Map();
    for (const [txID, txJson] of o.transactions) {
      const tx = new Transaction(txJson);
      b.transactions.set(txID, tx);
    }
    return b;
  }

  /**
   * Produces a new genesis block, giving the specified clients
   * the specified amount of starting gold.  This method will also
   * set the genesis block for every client passed in.
   * 
   * @param {Map.<Client, number>} clientBalanceMap - A map of clients to
   *    their starting amount of gold.
   * 
   * @returns {Block} - The genesis block.
   */
  static makeGenesis(clientBalanceMap: Map<Client, number>): Block {
    const g = new Block(GENESIS_REWARD_ADDR);

    for (const [client, balance] of clientBalanceMap.entries()) {
      g.balances.set(client.address, balance);
    }

    for (const client of clientBalanceMap.keys()) {
      client.setGenesisBlock(g);
    }

    return g;
  }

  /**
   * Creates a new Block.  Note that the previous block will not be stored;
   * instead, its hash value will be maintained in this block.
   * 
   * @constructor
   * @param {String} rewardAddr - The address to receive all mining rewards for this block.
   * @param {Block} [prevBlock] - The previous block in the blockchain.
   * @param {Number} [target] - The POW target.  The miner must find a proof that
   *      produces a smaller value when hashed.
   * @param {Number} [coinbaseReward] - The gold that a miner earns for finding a block proof.
   */
  constructor(
    rewardAddr: string,
    prevBlock?: Block,
    target: BigInteger = Block.HIT_POW_TARGET,
    coinbaseReward: number = COINBASE_AMT_ALLOWED
  ) {
    this.prevBlockHash = prevBlock ? prevBlock.hashVal() : GENESIS_PREV_BLOCK_HASH;
    this.target = target;

    // Get the balances and nonces from the previous block, if available.
    // Note that balances and nonces are NOT part of the serialized format.
    this.balances = prevBlock ? new Map(prevBlock.balances) : new Map();
    this.nextNonce = prevBlock ? new Map(prevBlock.nextNonce) : new Map();

    if (prevBlock && prevBlock.rewardAddr) {
      // Add the previous block's rewards to the miner who found the proof.
      const winnerBalance = this.balanceOf(prevBlock.rewardAddr) || 0;
      this.balances.set(prevBlock.rewardAddr, winnerBalance + prevBlock.totalRewards());
    }

    // Storing transactions in a Map to preserve key order.
    this.transactions = new Map();

    // Used to determine the winner between competing chains.
    // Note that this is a little simplistic -- an attacker
    // could make a long, but low-work chain.  However, this works
    // well enough for us.
    this.chainLength = prevBlock ? prevBlock.chainLength+1 : 0;

    this.timestamp = Date.now();

    // The address that will gain both the coinbase reward and transaction fees,
    // assuming that the block is accepted by the network.
    this.rewardAddr = rewardAddr;

    this.coinbaseReward = coinbaseReward;
  }

  /**
   * Determines whether the block is the beginning of the chain.
   * 
   * @returns {Boolean} - True if this is the first block in the chain.
   */
  isGenesisBlock(): boolean {
    return this.prevBlockHash === GENESIS_PREV_BLOCK_HASH;
  }

  /**
   * Returns true if the hash of the block is less than the target
   * proof of work value.
   * 
   * @returns {Boolean} - True if the block has a valid proof.
   */
  hasValidProof(): boolean {
    const h = hash(this.serialize());
    const n = new BigInteger(h, 16);
    return n.compareTo(this.target) < 0;
  }

  /**
   * Converts a Block into string form.  Some fields are deliberately omitted.
   * Note that Block.deserialize plus block.rerun should restore the block.
   * 
   * @returns {String} - The block in JSON format.
   */
  serialize(): string {
    return JSON.stringify({
        transactions: Array.from(this.transactions.entries()),
        prevBlockHash: this.prevBlockHash,
        timestamp: this.timestamp,
        proof: this.proof,
        rewardAddr: this.rewardAddr,
        chainLength: this.chainLength
    });
  }

  /**
   * Returns the cryptographic hash of the current block.
   * The block is first converted to its serial form, so
   * any unimportant fields are ignored.
   * 
   * @returns {String} - cryptographic hash of the block.
   */
  hashVal(): string {
    return hash(this.serialize());
  }

  /**
   * Returns the hash of the block as its id.
   * 
   * @returns {String} - A unique ID for the block.
   */
  get id(): string {
    return this.hashVal();
  }

  /**
   * Accepts a new transaction if it is valid and adds it to the block.
   * 
   * @param {Transaction} tx - The transaction to add to the block.
   * @param {Client} [client] - A client object, for logging useful messages.
   * 
   * @returns {Boolean} - True if the transaction was added successfully.
   */
  addTransaction(tx: Transaction, client?: Client): boolean {
    if (this.transactions.get(tx.id)) {
      if (client) client.log(`Duplicate transaction ${tx.id}.`);
      return false;
    } else if (tx.sig === undefined) {
      if (client) client.log(`Unsigned transaction ${tx.id}.`);
      return false;
    } else if (!tx.validSignature()) {
      if (client) client.log(`Invalid signature for transaction ${tx.id}.`);
      return false;
    } else if (!tx.sufficientFunds(this.balances)) {
      if (client) client.log(`Insufficient gold for transaction ${tx.id}.`);
      return false;
    }

    // Checking and updating nonce value.
    // This portion prevents replay attacks.
    const nonce = this.nextNonce.get(tx.from) || 0;
    if (tx.nonce < nonce) {
      if (client) client.log(`Replayed transaction ${tx.id}.`);
      return false;
    } else if (tx.nonce > nonce) {
      // FIXME: Need to do something to handle this case more gracefully.
      if (client) client.log(`Out of order transaction ${tx.id}.`);
      return false;
    } else {
      this.nextNonce.set(tx.from, nonce + 1);
    }

    // Adding the transaction to the block
    this.transactions.set(tx.id, tx);

    // Taking gold from the sender
    const senderBalance = this.balanceOf(tx.from);
    this.balances.set(tx.from, senderBalance - tx.totalOutput());

    // Giving gold to the specified output addresses
    tx.outputs.forEach(({amount, address}) => {
      const oldBalance = this.balanceOf(address);
      this.balances.set(address, amount + oldBalance);
    });

    return true;
  }

  /**
   * When a block is received from another party, it does not include balances or a record of
   * the latest nonces for each client.  This method restores this information be wiping out
   * and re-adding all transactions.  This process also identifies if any transactions were
   * invalid due to insufficient funds or replayed transactions, in which case the block
   * should be rejected.
   * 
   * @param {Block} prevBlock - The previous block in the blockchain, used for initial balances.
   * 
   * @returns {Boolean} - True if the block's transactions are all valid.
   */
  rerun(prevBlock: Block): boolean {
    // Setting balances to the previous block's balances.
    this.balances = new Map(prevBlock.balances);
    this.nextNonce = new Map(prevBlock.nextNonce);

    // Adding coinbase reward for prevBlock.
    const winnerBalance = this.balanceOf(prevBlock.rewardAddr);
    this.balances.set(prevBlock.rewardAddr, winnerBalance + prevBlock.totalRewards());

    // Re-adding all transactions.
    const txs = this.transactions;
    this.transactions = new Map();
    for (const tx of txs.values()) {
      const success = this.addTransaction(tx);
      if (!success) return false;
    }

    return true;
  }

  /**
   * Gets the available gold of a user identified by an address.
   * Note that this amount is a snapshot in time - IF the block is
   * accepted by the network, ignoring any pending transactions,
   * this is the amount of funds available to the client.
   * 
   * @param {String} addr - Address of a client.
   * 
   * @returns {Number} - The available gold for the specified user.
   */
  balanceOf(addr: string): number {
    return this.balances.get(addr) || 0;
  }

  /**
   * The total amount of gold paid to the miner who produced this block,
   * if the block is accepted.  This includes both the coinbase transaction
   * and any transaction fees.
   * 
   * @returns {Number} Total reward in gold for the user.
   * 
   */
  totalRewards(): number {
    return [...this.transactions].reduce(
      (reward, [, tx]) => reward + tx.fee,
      this.coinbaseReward);
  }
}
