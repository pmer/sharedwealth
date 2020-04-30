"use strict";

import { assert } from 'chai';
import { BigInteger } from 'jsbn';

import Block from './block.js';
import Client from './client.js';
import Miner from './miner.js';
import Transaction from './transaction.js';

import * as utils from './utils.js';

// Generating keypair for multiple test cases, since key generation is slow.
const kp = utils.generateKeypair();
const addr = utils.calcAddress(kp.public);

// Adding a POW target that should be trivial to match.
const EASY_POW_TARGET = new BigInteger('fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 16);

describe('utils', () => {
  describe('.verifySignature', () => {
    const sig = utils.sign(kp.private, 'hello');
    it('should accept a valid signature', () => {
      assert.ok(utils.verifySignature(kp.public, 'hello', sig));
    });

    it('should reject an invalid signature', () => {
      assert.ok(!utils.verifySignature(kp.public, 'goodbye', sig));
    });
  });
});

describe('Transaction', () => {
  const outputs = [{amount: 20, address: 'ffff'},
                 {amount: 40, address: 'face'}];
  const t = new Transaction({from: addr, pubKey: kp.public, outputs: outputs, fee: 1, nonce: 1});
  t.sign(kp.private);

  describe('#totalOutput', () => {
    it('should sum up all of the outputs and the transaction fee', () => {
      assert.equal(t.totalOutput(), 61);
    });
  });

});

describe('Block', () => {
  const prevBlock = new Block('8e7912');
  prevBlock.balances = new Map([ [addr, 500], ['ffff', 100], ['face', 99] ]);

  const outputs = [{amount: 20, address: 'ffff'}, {amount: 40, address: 'face'}];
  const t = new Transaction({from: addr, pubKey: kp.public, outputs: outputs, fee: 1, nonce: 0});

  describe('#addTransaction', () => {
    it('should fail if a transaction is not signed.', () => {
      const b = new Block(addr, prevBlock);
      const tx = new Transaction(t);
      assert.isFalse(b.addTransaction(tx));
    });

    it("should fail if the 'from' account does not have enough gold.", () => {
      const b = new Block(addr, prevBlock);
      const tx = new Transaction(t);
      tx.outputs = [{amount:20000000000000, address: 'ffff'}];
      tx.sign(kp.private);
      assert.isFalse(b.addTransaction(tx));
    });

    it('should transfer gold from the sender to the receivers.', () => {
      const b = new Block(addr, prevBlock);
      const tx = new Transaction(t);
      tx.sign(kp.private);
      b.addTransaction(tx);
      assert.equal(b.balances.get(addr), 500-61); // Extra 1 for transaction fee.
      assert.equal(b.balances.get('ffff'), 100+20);
      assert.equal(b.balances.get('face'), 99+40);
    });

    it('should ignore any transactions that were already received in a previous block.', () => {
      const b = new Block(addr, prevBlock);
      const tx = new Transaction(t);
      tx.sign(kp.private);
      b.addTransaction(tx);

      // Attempting to add transaction to subsequent block.
      const b2 = new Block(addr, b);
      b2.addTransaction(tx);
      assert.isEmpty(b2.transactions);
    });
  });

  describe('#rerun', () => {
    it('should redo transactions to return to the same block.', () => {
      const b = new Block(addr, prevBlock);

      const tx = new Transaction(t);
      tx.sign(kp.private);
      b.addTransaction(tx);

      // Wiping out balances and then rerunning the block
      b.rerun(prevBlock);

      // Verifying prevBlock's balances are unchanged.
      assert.equal(prevBlock.balances.get(addr), 500);
      assert.equal(prevBlock.balances.get('ffff'), 100);
      assert.equal(prevBlock.balances.get('face'), 99);

      // Verifying b's balances are correct.
      assert.equal(b.balances.get(addr), 500-61);
      assert.equal(b.balances.get('ffff'), 100+20);
      assert.equal(b.balances.get('face'), 99+40);
    });

    it('should take a serialized/deserialized block and get back the same block.', () => {
      const b = new Block(addr, prevBlock);

      const tx = new Transaction(t);
      tx.sign(kp.private);
      b.addTransaction(tx);

      const hash = b.hashVal();

      const serialBlock = b.serialize();
      const b2 = Block.deserialize(serialBlock);
      b2.rerun(prevBlock);

      // Verify hashes still match
      assert.equal(b2.hashVal(), hash);

      assert.equal(b2.balances.get(addr), 500-61);
      assert.equal(b2.balances.get('ffff'), 100+20);
      assert.equal(b2.balances.get('face'), 99+40);
    });
  });
});

describe('Client', () => {
  const genesis = new Block('8e7912');
  genesis.balances = new Map([ [addr, 500], ['ffff', 100], ['face', 99] ]);
  const net = { broadcast: function(){}, sendMessage: function(){} };

  const outputs = [{amount: 20, address: 'ffff'}, {amount: 40, address: 'face'}];
  const t = new Transaction({from: addr, pubKey: kp.public, outputs: outputs, fee: 1, nonce: 0});
  t.sign(kp.private);

  const outputs2 = [{amount: 10, address: 'face'}];
  const t2 = new Transaction({from: addr, pubKey: kp.public, outputs: outputs2, fee: 1, nonce: 1});
  t2.sign(kp.private);

  const client = new Client({net: net, startingBlock: genesis});
  client.log = function(){};

  const miner = new Miner({name: 'Minnie', net, startingBlock: genesis});
  miner.log = function(){};

  describe('#receiveBlock', () => {
    it('should reject any block without a valid proof.', () => {
      const b = new Block(addr, genesis);
      b.addTransaction(t);
      // Receiving and verifying block
      const b2 = client.receiveBlock(b);
      assert.isNull(b2);
    });

    it('should store all valid blocks, but only change lastBlock if the newer block is better.', () => {
      const b = new Block(addr, genesis, EASY_POW_TARGET);
      b.addTransaction(t);
      // Finding a proof.
      miner.currentBlock = b;
      b.proof = 0;
      miner.findProof(true);
      // Receiving and verifying block
      client.receiveBlock(b);
      assert.equal(client.blocks.get(b.id), b);
      assert.equal(client.lastBlock, b);

      const b2 = new Block(addr, b, EASY_POW_TARGET);
      b2.addTransaction(t2);
      // Finding a proof.
      miner.currentBlock = b2;
      b2.proof = 0;
      miner.findProof(true);
      // Receiving and verifying block
      client.receiveBlock(b2);
      assert.equal(client.blocks.get(b2.id), b2);
      assert.equal(client.lastBlock, b2);

      const bAlt = new Block(addr, genesis, EASY_POW_TARGET);
      bAlt.addTransaction(t2);
      // Finding a proof.
      miner.currentBlock = bAlt;
      bAlt.proof = 0;
      miner.findProof(true);
      // Receiving and verifying block
      client.receiveBlock(bAlt);
      assert.equal(client.blocks.get(bAlt.id), bAlt);
      assert.equal(client.lastBlock, b2);
    });
  });
});
