"use strict";

import crypto from 'crypto';

import { Key, Keypair, Signature } from './types.js';

// CRYPTO settings
const HASH_ALG = 'sha256';
const SIG_ALG = 'RSA-SHA256';

export function hash(s: string, encoding: crypto.HexBase64Latin1Encoding = 'hex'): string {
  return crypto.createHash(HASH_ALG).update(s).digest(encoding);
}

export function generateKeypair(): Keypair {
  const kp = crypto.generateKeyPairSync('rsa', {
    modulusLength: 512,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
  });
  return {
    public: kp.publicKey,
    private: kp.privateKey,
  };
}

export function sign(privKey: Key, msg: string): Signature {
  const signer = crypto.createSign(SIG_ALG);
  // Convert an object to its JSON representation
  const str = (msg === Object(msg)) ? JSON.stringify(msg) : '' + msg;
  return signer.update(str).sign(privKey, 'hex');
}

export function verifySignature(pubKey: Key, msg: string, sig: Signature): boolean {
  const verifier = crypto.createVerify(SIG_ALG);
  // Convert an object to its JSON representation
  const str = (msg === Object(msg)) ? JSON.stringify(msg) : '' + msg;
  return verifier.update(str).verify(pubKey, sig, 'hex');
}

export function calcAddress(key: Key): string {
  const addr = hash('' + key, 'base64');
  //console.log(`Generating address ${addr} from ${key}`);
  return addr;
}

export function addressMatchesKey(addr: string, pubKey: Key): boolean {
  return addr === calcAddress(pubKey);
}
