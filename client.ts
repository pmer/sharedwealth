"use strict";

import events from 'events';

import Block from './block.js';
import Transaction from './transaction.js';

import { Keypair, Outputs, Net } from './types.js';
import { calcAddress, generateKeypair } from './utils.js';

const DEFAULT_TX_FEE = 1;

// If a block is 6 blocks older than the current block, it is considered
// confirmed, for no better reason than that is what Bitcoin does.
// Note that the genesis block is always considered to be confirmed.
const CONFIRMED_DEPTH = 6;

/**
 * A client has a public/private keypair and an address.
 * It can send and receive messages on the Blockchain network.
 */
export default class Client extends events.EventEmitter {
  net: Net;
  name?: string;

  keyPair: Keypair;
  address: string;

  // Establishes order of transactions.  Incremented with each
  // new output transaction from this client.  This feature
  // avoids replay attacks.
  nonce: number;

  // FIXME: Need to restore pending amounts and transactions.
  pendingSpent: number;

  // A map of all block hashes to the accepted blocks.
  blocks: Map<string,Block>;

  // A map of missing block IDS to the list of blocks depending
  // on the missing blocks.
  pendingBlocks: Map<string,Set<Block>>;

  // Transactions from this block or older are assumed to be confirmed,
  // and therefore are spendable by the client. The transactions could
  // roll back, but it is unlikely.
  lastConfirmedBlock?: Block;

  // The last block seen.  Any transactions after lastConfirmedBlock
  // up to lastBlock are considered pending.
  lastBlock?: Block;


  // Network message types
  static readonly MISSING_BLOCK = 'MISSING_BLOCK';
  static readonly POST_TRANSACTION = 'POST_TRANSACTION';
  static readonly PROOF_FOUND = 'PROOF_FOUND';

  /**
   * The net object determines how the client communicates
   * with other entities in the system. (This approach allows us to
   * simplify our testing setup.)
   * 
   * @constructor
   * @param {Object} obj - The properties of the client.
   * @param {String} [obj.name] - The client's name, used for debugging messages.
   * @param {Object} obj.net - The network used by the client
   *    to send messages to all miners and clients.
   * @param {Block} [obj.startingBlock] - The starting point of the blockchain for the client.
   */
  constructor({
    name,
    net,
    startingBlock
  }: {
    name?: string;
    net: Net;
    startingBlock?: Block;
  }) {
    super();

    this.net = net;
    this.name = name;

    this.keyPair = generateKeypair();
    this.address = calcAddress(this.keyPair.public);

    // Establishes order of transactions.  Incremented with each
    // new output transaction from this client.  This feature
    // avoids replay attacks.
    this.nonce = 0;

    // FIXME: Need to restore pending amounts and transactions.
    this.pendingSpent = 0;

    // A map of all block hashes to the accepted blocks.
    this.blocks = new Map();

    // A map of missing block IDS to the list of blocks depending
    // on the missing blocks.
    this.pendingBlocks = new Map();

    if (startingBlock) {
      this.setGenesisBlock(startingBlock);
    }

    // Setting up listeners to receive messages from other clients.
    this.on(Client.PROOF_FOUND, this.receiveBlock);
    this.on(Client.MISSING_BLOCK, this.provideMissingBlock)
  }

  /**
   * The genesis block can only be set if the client does not already
   * have the genesis block.
   * 
   * @param {Block} startingBlock - The genesis block of the blockchain.
   */
  setGenesisBlock(startingBlock: Block): void {
    if (this.lastBlock) {
      throw new Error('Cannot set genesis block for existing blockchain.');
    }

    // Transactions from this block or older are assumed to be confirmed,
    // and therefore are spendable by the client. The transactions could
    // roll back, but it is unlikely.
    this.lastConfirmedBlock = startingBlock;

    // The last block seen.  Any transactions after lastConfirmedBlock
    // up to lastBlock are considered pending.
    this.lastBlock = startingBlock;

    this.blocks.set(startingBlock.id, startingBlock);
  }

  /**
   * The amount of gold available to the client, not counting any pending
   * transactions.  This getter looks at the last confirmed block, since
   * transactions in newer blocks may roll back.
   */
  get confirmedBalance(): number {
    return this.lastConfirmedBlock!.balanceOf(this.address);
  }

  /**
   * Any gold received in the last confirmed block or before is considered
   * spendable, but any gold received more recently is not yet available.
   * However, any gold given by the client to other clients in unconfirmed
   * transactions is treated as unavailable.
   */
  get availableGold(): number {
    return this.confirmedBalance - this.pendingSpent;
  }

  /**
   * Broadcasts a transaction from the client giving gold to the clients
   * specified in 'outputs'. A transaction fee may be specified, which can
   * be more or less than the default value.
   * 
   * @param {Array} outputs - The list of outputs of other addresses and
   *    amounts to pay.
   * @param {number} [fee] - The transaction fee reward to pay the miner.
   */
  postTransaction(outputs: Outputs, fee: number = DEFAULT_TX_FEE): void {
    // We calculate the total value of gold needed.
    const totalPayments = outputs.reduce((acc, {amount}) => acc + amount, 0) + fee;

    // Make sure the client has enough gold.
    if (totalPayments > this.availableGold) {
      throw new Error(`Requested ${totalPayments}, but account only has ${this.availableGold}.`);
    }

    // Broadcasting the new transaction.
    const tx = new Transaction({
      from: this.address,
      nonce: this.nonce,
      pubKey: this.keyPair.public,
      outputs: outputs,
      fee: fee,
    });

    tx.sign(this.keyPair.private);

    this.nonce++;

    this.net.broadcast(Client.POST_TRANSACTION, tx);
  }

  /**
   * Validates and adds a block to the list of blocks, possibly updating the head
   * of the blockchain.  Any transactions in the block are rerun in order to
   * update the gold balances for all clients.  If any transactions are found to be
   * invalid due to lack of funds, the block is rejected and 'null' is returned to
   * indicate failure.
   * 
   * If any blocks cannot be connected to an existing block but seem otherwise valid,
   * they are added to a list of pending blocks and a request is sent out to get the
   * missing blocks from other clients.
   * 
   * @param {Block | string} block - The block to add to the clients list of available blocks.
   * 
   * @returns {Block | null} The block with rerun transactions, or null for an invalid block.
   */
  receiveBlock(block: Block | string): Block | null {
    // If the block is a string, then deserialize it.
    if (typeof block === 'string') {
      block = Block.deserialize(block);
    }

    // Ignore the block if it has been received previously.
    if (this.blocks.has(block.id)) return null;

    // First, make sure that the block has a valid proof. 
    if (!block.hasValidProof()) {
      //throw new Error(`Block ${block.id} does not have a valid proof ${block.proof}.`);
      this.log(`Block ${block.id} does not have a valid proof.`);
      return null;
    }

    // Make sure that we have the previous blocks.
    // If we don't, request the missing blocks and exit.
    const prevBlock = this.blocks.get(block.prevBlockHash);
    if (!prevBlock) {
      let stuckBlocks = this.pendingBlocks.get(block.prevBlockHash);

      // If this is the first time that we have identified this block as missing,
      // send out a request for the block.
      if (stuckBlocks === undefined) { 
        this.requestMissingBlock(block);
        stuckBlocks = new Set();
      }
      stuckBlocks.add(block);

      this.pendingBlocks.set(block.prevBlockHash, stuckBlocks);
      return null;
    }

    // Verify the block, and store it if everything looks good.
    // This code will trigger an exception if there are any invalid transactions.
    const success = block.rerun(prevBlock);
    if (!success) return null;

    // Storing the block.
    this.blocks.set(block.id, block);

    // If it is a better block than the client currently has, set that
    // as the new currentBlock, and update the lastConfirmedBlock.
    if (this.lastBlock!.chainLength < block.chainLength) {
      this.lastBlock = block;
      this.setLastConfirmed();
    }

    // Go through any blocks that were waiting for this block
    // and recursively call receiveBlock.
    const unstuckBlocks = this.pendingBlocks.get(block.id) || [];
    // Remove these blocks from the pending set.
    this.pendingBlocks.delete(block.id);
    for (const b of unstuckBlocks) {
      this.log(`Processing unstuck block ${b.id}`);
      this.receiveBlock(b);
    }

    return block;
  }

  /**
   * Request the previous block from the network.
   * 
   * @param {Block} block - The block that is connected to a missing block.
   */
  requestMissingBlock(block: Block): void {
    this.log(`Asking for missing block: ${block.prevBlockHash}`);
    const msg = {
      from: this.address,
      missing: block.prevBlockHash,
    }
    this.net.broadcast(Client.MISSING_BLOCK, JSON.stringify(msg));
  }

  /**
   * Takes a JSON-formatted string, parses it, and identifies the
   * request for a misssing block.  If the client has the block,
   * it will send the block to the client that requested it.
   * 
   * @param {string} msg - JSON-formatted string.
   */
  provideMissingBlock(msg: string): void {
    const o = JSON.parse(msg);
    if (this.blocks.has(o.missing)) {
      this.log(`Providing missing block ${o.missing}`);
      const block = this.blocks.get(o.missing)!;
      this.net.sendMessage(o.from, Client.PROOF_FOUND, block.serialize());
    }
  }

  /**
   * Sets the last confirmed block according to the most recently accepted block.
   * Note that the genesis block is always considered to be confirmed.
   */
  setLastConfirmed(): void {
    let block = this.lastBlock!;
    let confirmedBlockHeight = block.chainLength - CONFIRMED_DEPTH;
    if (confirmedBlockHeight < 0) {
      confirmedBlockHeight = 0;
    }
    while (block.chainLength > confirmedBlockHeight) {
      block = this.blocks.get(block.prevBlockHash)!;
    }
    this.lastConfirmedBlock = block;
  }

  /**
   * Utility method that displays all confimed balances for all clients,
   * according to the client's own perspective of the network.
   */
  showAllBalances(): void {
    for (const [id,balance] of this.lastConfirmedBlock!.balances) {
      this.log(`${id}: ${balance}`);
    }
  }
 
  /**
   * Logs messages to stdout, including the name to make debugging easier.
   * If the client does not have a name, then one is calculated from the
   * client's address.
   * 
   * @param {String} msg - The message to display to the console.
   */
  log(msg: string): void {
    const name = this.name || this.address.substring(0,10);
    console.log(`${name}: ${msg}`);
  }
}
