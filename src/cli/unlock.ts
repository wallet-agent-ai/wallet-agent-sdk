import { Keystore } from "../keystore/Keystore";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const PASSPHRASE_FILE = path.join(os.homedir(), ".agent-wallet", "passphrase.key");

export function unlockKeystore(): string {
  // 1. Verificar que existe el keystore
  const keystoreData = Keystore.load();
  if (!keystoreData) {
    throw new Error(
      "❌ A keystore dont found. Execute first: npx agent-wallet init"
    );
  }

  // 2. Leer passphrase del fichero
  if (!fs.existsSync(PASSPHRASE_FILE)) {
    throw new Error(
      "❌ A passphrase.key dont found. The keystore could be corrupt."
    );
  }
  const passphrase = fs.readFileSync(PASSPHRASE_FILE, "utf-8").trim();

  // 3. Desencriptar y devolver private key
  try {
    const privateKeyHex = Keystore.decrypt(keystoreData, passphrase);
    return privateKeyHex;
  } catch {
    throw new Error(
      "❌ Error desencript keystore. The file could be corrupt."
    );
  }
}

export function getNotarizerAddress(): string {
  const keystoreData = Keystore.load();
  if (!keystoreData) {
    throw new Error("❌ Dont found the keystore.");
  }
  return keystoreData.address;
}
