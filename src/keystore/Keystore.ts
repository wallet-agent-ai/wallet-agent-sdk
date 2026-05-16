import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

const KEYSTORE_DIR = path.join(os.homedir(), ".agent-wallet");
const KEYSTORE_FILE = path.join(KEYSTORE_DIR, "keystore.json");

export interface KeystoreData {
  version: number;
  address: string;
  encryptedPrivateKey: string;
  iv: string;
  salt: string;
  bip39Passphrase?: string;
}

export class Keystore {
  // Guarda la clave encriptada en disco
  static save(data: KeystoreData): void {
    if (!fs.existsSync(KEYSTORE_DIR)) {
      fs.mkdirSync(KEYSTORE_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(KEYSTORE_FILE, JSON.stringify(data, null, 2), {
      mode: 0o600, // solo el owner puede leer
    });
  }

  // Lee el keystore del disco
  static load(): KeystoreData | null {
    if (!fs.existsSync(KEYSTORE_FILE)) return null;
    const raw = fs.readFileSync(KEYSTORE_FILE, "utf-8");
    return JSON.parse(raw) as KeystoreData;
  }

  // Encripta la private key con AES-256-GCM
  static encrypt(privateKeyHex: string, passphrase: string): Omit<KeystoreData, "version" | "address"> {
    const salt = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const key = crypto.scryptSync(passphrase, salt, 32);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(privateKeyHex, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      encryptedPrivateKey: encrypted.toString("hex"),
      iv: iv.toString("hex"),
      salt: salt.toString("hex"),
    };
  }

  // Desencripta la private key
  static decrypt(data: KeystoreData, passphrase: string): string {
    const salt = Buffer.from(data.salt, "hex");
    const iv = Buffer.from(data.iv, "hex");
    const key = crypto.scryptSync(passphrase, salt, 32);
    const encryptedBuf = Buffer.from(data.encryptedPrivateKey, "hex");
    const authTag = encryptedBuf.slice(-16);
    const encrypted = encryptedBuf.slice(0, -16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final("utf8");
  }

  static exists(): boolean {
    return fs.existsSync(KEYSTORE_FILE);
  }

  static path(): string {
    return KEYSTORE_FILE;
  }
}
