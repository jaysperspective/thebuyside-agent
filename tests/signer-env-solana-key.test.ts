/**
 * Unit tests for EnvSolanaKeySigner — input parsing (base58 + JSON-array),
 * deterministic public-key derivation, and end-to-end sign-then-verify.
 */

import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { EnvSolanaKeySigner } from '../src/signer/env-solana-key.js';

// Fixed test keypair — Keypair.fromSeed(seed) is deterministic, so the
// derived pubkey is stable across runs.
const TEST_SEED = Buffer.alloc(32, 1); // [1,1,1,...,1]
const TEST_KP = Keypair.fromSeed(TEST_SEED);
const TEST_SECRET = TEST_KP.secretKey; // 64 bytes
const TEST_PUBKEY = TEST_KP.publicKey.toBase58();

const KEY_BASE58 = bs58.encode(TEST_SECRET);
const KEY_JSON_ARRAY = JSON.stringify(Array.from(TEST_SECRET));

describe('EnvSolanaKeySigner.constructor — base58 input', () => {
  it('parses a base58 secret key and derives the correct pubkey', () => {
    const s = new EnvSolanaKeySigner(KEY_BASE58);
    expect(s.publicKey).toBe(TEST_PUBKEY);
    expect(s.kind).toBe('svm');
  });

  it('rejects malformed base58 (not decodable)', () => {
    expect(() => new EnvSolanaKeySigner('!!!not-base58!!!')).toThrow(
      /neither a valid base58 string nor a JSON array/,
    );
  });

  it('rejects base58 that decodes to the wrong byte length', () => {
    const tooShort = bs58.encode(Buffer.alloc(32, 7)); // 32 bytes, not 64
    expect(() => new EnvSolanaKeySigner(tooShort)).toThrow(
      /must decode to 64 bytes \(got 32\)/,
    );
  });
});

describe('EnvSolanaKeySigner.constructor — JSON-array input', () => {
  it('parses a JSON-array secret key and derives the correct pubkey', () => {
    const s = new EnvSolanaKeySigner(KEY_JSON_ARRAY);
    expect(s.publicKey).toBe(TEST_PUBKEY);
  });

  it('produces the same pubkey for base58 vs JSON-array of the same key', () => {
    const fromB58 = new EnvSolanaKeySigner(KEY_BASE58);
    const fromJson = new EnvSolanaKeySigner(KEY_JSON_ARRAY);
    expect(fromB58.publicKey).toBe(fromJson.publicKey);
  });

  it('rejects JSON that fails to parse', () => {
    expect(() => new EnvSolanaKeySigner('[1, 2, 3, malformed')).toThrow(
      /JSON-array format but is not valid JSON/,
    );
  });

  it('rejects a JSON array of the wrong length', () => {
    const arr = JSON.stringify(Array(32).fill(0));
    expect(() => new EnvSolanaKeySigner(arr)).toThrow(/must contain 64 bytes \(got 32\)/);
  });

  it('rejects a JSON array containing non-numeric entries', () => {
    const arr = JSON.stringify(['a', 'b', 'c']);
    expect(() => new EnvSolanaKeySigner(arr)).toThrow(
      /must be an array of byte values/,
    );
  });
});

describe('EnvSolanaKeySigner.signTransaction', () => {
  it('attaches a valid Ed25519 signature for the buyer slot', async () => {
    // Build a minimal versioned tx that requires the buyer's signature only
    // (we set payerKey = buyer pubkey here to make verification easy; the
    // production code path uses the seller's feePayer).
    const buyer = TEST_KP.publicKey;
    const recipient = Keypair.generate().publicKey;
    const blockhash = bs58.encode(Buffer.alloc(32, 9));

    const message = new TransactionMessage({
      payerKey: buyer,
      recentBlockhash: blockhash,
      instructions: [
        // Trivial no-op instruction: a memo
        {
          programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
          keys: [{ pubkey: recipient, isSigner: false, isWritable: false }],
          data: Buffer.from('test', 'utf8'),
        },
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);

    const signer = new EnvSolanaKeySigner(KEY_BASE58);
    const signed = await signer.signTransaction(tx);

    // The signature for the buyer (payerKey) should now be filled in.
    const sig = signed.signatures[0];
    expect(sig).not.toEqual(new Uint8Array(64)); // not the all-zero placeholder

    // Independently verify with tweetnacl: the signature must validate the
    // serialized message bytes against the buyer's pubkey.
    const serializedMessage = signed.message.serialize();
    const ok = nacl.sign.detached.verify(
      serializedMessage,
      sig,
      buyer.toBytes(),
    );
    expect(ok).toBe(true);
  });
});
