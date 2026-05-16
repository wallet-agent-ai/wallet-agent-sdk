import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { RadixEngineToolkit, PublicKey, NetworkId } from "@radixdlt/radix-engine-toolkit";
import { Keystore } from "../keystore/Keystore";
import * as crypto from "crypto";
import * as fs from "fs";
import * as readline from "readline";
import * as path from "path";
import * as os from "os";
import { RADIX_PATH, slip10DeriveEd25519, derivePublicKey } from "./derive";

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

export async function recover() {
  console.log("\n🔄 Agent Wallet — Recover");
  console.log("==============================\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // 1. Pedir las 24 palabras
    console.log("Put your 24 palabras seed with a space between each one:");
    const mnemonicInput = (await ask(rl, "> ")).trim();

    // 2. Validar mnemonic
    if (!bip39.validateMnemonic(mnemonicInput, wordlist)) {
      console.log("❌ Mnemonic invalid. Verifia the 24 words.");
      rl.close();
      return;
    }

    // 3. Pedir palabra clave
    const bip39Passphrase = (await ask(rl, "\n🔑 Pass word: ")).trim();
    rl.close();

    // 4. Derivar seed y private key
    console.log("\n⏳ Deriving wallet...");
    const seed = await bip39.mnemonicToSeed(mnemonicInput, bip39Passphrase);
    const privateKeyBytes = slip10DeriveEd25519(seed, RADIX_PATH);
    const privateKeyHex = Buffer.from(privateKeyBytes).toString("hex");

    // 5. Derivar public key y address
    const publicKeyBytes = derivePublicKey(privateKeyBytes);
    const publicKey = new PublicKey.Ed25519(publicKeyBytes.toString("hex"));
    const address = await RadixEngineToolkit.Derive.virtualAccountAddressFromPublicKey(
      publicKey,
      NetworkId.Mainnet
    );

    // 6. Mostrar address para que el usuario confirme
    console.log("\n📍 Direction recovery:", address.toString());
    
    const rl2 = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const confirm = (await ask(rl2, "\n¿Is correc? (y/n): ")).trim().toLowerCase();
    rl2.close();

    if (confirm !== "s") {
      console.log("❌ Recovery canceled. Verify the words and the pass word.");
      return;
    }

    // 7. Regenerar keystore
    const passphrase = crypto.randomBytes(32).toString("hex");
    const encrypted = Keystore.encrypt(privateKeyHex, passphrase);
    Keystore.save({
      version: 1,
      address: address.toString(),
      bip39Passphrase,
      ...encrypted,
    });

    // 8. Guardar nueva passphrase
    const passphraseFile = path.join(os.homedir(), ".agent-wallet", "passphrase.key");
    fs.writeFileSync(passphraseFile, passphrase, { mode: 0o600 });

    console.log("\n✅ Wallet correctly recover.");
    console.log("📍 Direction:", address.toString());
    console.log("✅ Keystore save on:", Keystore.path());

  } catch (e: any) {
    rl.close();
    console.log("❌ Error:", e.message);
  }
}

