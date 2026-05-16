import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import * as crypto from "crypto";

export const HARDENED = 0x80000000;
export const RADIX_PATH = [
  44   + HARDENED,
  1022 + HARDENED,
  1    + HARDENED,
  525  + HARDENED,
  1460 + HARDENED,
  0    + HARDENED,
];

export function slip10DeriveEd25519(seed: Uint8Array, path: number[]): Uint8Array {
  const I = hmac(sha512, Buffer.from("ed25519 seed"), seed);
  let IL = I.slice(0, 32);
  let IR = I.slice(32);
  for (const index of path) {
    const indexBuf = Buffer.alloc(4);
    indexBuf.writeUInt32BE(index, 0);
    const data = Buffer.concat([Buffer.alloc(1, 0), IL, indexBuf]);
    const child = hmac(sha512, IR, data);
    IL = child.slice(0, 32);
    IR = child.slice(32);
  }
  return IL;
}

export function derivePublicKey(privateKeyBytes: Uint8Array): Buffer {
  const privateKeyObj = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      privateKeyBytes,
    ]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyObj = crypto.createPublicKey(privateKeyObj);
  const publicKeyDer = publicKeyObj.export({ format: "der", type: "spki" }) as Buffer;
  return publicKeyDer.slice(-32);
}
