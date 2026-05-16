import * as bip39 from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { RadixEngineToolkit, PublicKey, NetworkId } from "@radixdlt/radix-engine-toolkit";
import { Keystore } from "../keystore/Keystore";
import * as crypto from "crypto";
import * as readline from "readline";
import { RADIX_PATH, slip10DeriveEd25519, derivePublicKey } from "./derive";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function askYesNo(rl: readline.Interface, question: string): Promise<boolean> {
  const answer = await ask(rl, `${question} (y/n): `);
  return answer.trim().toLowerCase() === "y";
}

function displayMnemonic(mnemonic: string): void {
  const words = mnemonic.split(" ");
  console.log();
  words.forEach((w, i) => {
    process.stdout.write(`  ${String(i + 1).padStart(2, "0")}. ${w.padEnd(12)}`);
    if ((i + 1) % 4 === 0) process.stdout.write("\n");
  });
  console.log();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function init() {
  console.log("\n🤖 AgentWallet — Initialize");
  console.log("================================\n");

  if (Keystore.exists()) {
    console.log("⚠️  A keystore already exists:", Keystore.path());
    console.log("   Current address:", Keystore.load()?.address);
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    // ── 1. Mnemonic ────────────────────────────────────────────────────────
    let mnemonic: string;

    const useOwnMnemonic = await askYesNo(rl, "Do you want to use your own 24-word mnemonic?");

    if (useOwnMnemonic) {
      console.log("\nEnter your 24 words separated by spaces:");
      mnemonic = (await ask(rl, "> ")).trim();

      if (!bip39.validateMnemonic(mnemonic, wordlist)) {
        console.error("\n❌ Invalid mnemonic. Please check your words and try again.");
        rl.close();
        return;
      }
      console.log("✅ Mnemonic validated.\n");
    } else {
      mnemonic = bip39.generateMnemonic(wordlist, 256);
      console.log("\n⚠️  SAVE THESE 24 WORDS IN A SAFE PLACE — shown only once:");
      displayMnemonic(mnemonic);
    }

    // ── 2. BIP39 Passphrase ────────────────────────────────────────────────
    let bip39Passphrase: string;

    const useOwnPassphrase = await askYesNo(rl, "Do you want to use your own BIP39 passphrase (extra word)?");

    if (useOwnPassphrase) {
      bip39Passphrase = (await ask(rl, "Enter your BIP39 passphrase (leave empty for none): ")).trim();
      // if (!bip39Passphrase) {
      //   console.error("\n❌ Passphrase cannot be empty.");
      //   rl.close();
      //   return;
      // }
      console.log("✅ BIP39 passphrase set.\n");
    } else {
      bip39Passphrase = wordlist[crypto.randomInt(wordlist.length)];
      console.log("\n🔑 BIP39 PASSPHRASE (SAVE with your 24 words):");
      console.log("  ", bip39Passphrase);
      console.log("\n⚠️  Without this passphrase + 24 words, wallet recovery is impossible.\n");
    }

    // ── 3. Encryption password ─────────────────────────────────────────────
    let encryptionPassword: string;
    let savePasswordFile = false;

    const useOwnPassword = await askYesNo(rl, "Do you want to use your own encryption password for the keystore?");

    if (useOwnPassword) {
      encryptionPassword = (await ask(rl, "Enter your encryption password: ")).trim();
      if (!encryptionPassword) {
        console.error("\n❌ Password cannot be empty.");
        rl.close();
        return;
      }
      console.log("✅ Encryption password set.\n");
      console.log("⚠️  Remember this password — you will need it every time the agent starts.\n");
    } else {
      encryptionPassword = crypto.randomBytes(32).toString("hex");
      savePasswordFile = true;
      console.log("\n🔐 Encryption password generated automatically and saved to disk.\n");
    }

    // ── 4. Derive keys ─────────────────────────────────────────────────────
    const seed = await bip39.mnemonicToSeed(mnemonic, bip39Passphrase);
    const privateKeyBytes = slip10DeriveEd25519(seed, RADIX_PATH);
    const privateKeyHex = Buffer.from(privateKeyBytes).toString("hex");
    const publicKeyBytes = derivePublicKey(privateKeyBytes);
    const publicKey = new PublicKey.Ed25519(publicKeyBytes.toString("hex"));

    // ── 5. Radix address ───────────────────────────────────────────────────
    const address = await RadixEngineToolkit.Derive.virtualAccountAddressFromPublicKey(
      publicKey,
      NetworkId.Mainnet
    );

    // ── 6. Encrypt and save keystore ───────────────────────────────────────
    const encrypted = Keystore.encrypt(privateKeyHex, encryptionPassword);

    Keystore.save({
      version: 1,
      address: address.toString(),
      bip39Passphrase,
      ...encrypted,
    });

    // ── 7. Save password file if auto-generated ────────────────────────────
    if (savePasswordFile) {
      const passwordFile = Keystore.path().replace("keystore.json", "passphrase.key");
      const { writeFileSync } = await import("fs");
      writeFileSync(passwordFile, encryptionPassword, { mode: 0o600 });
      console.log("🔐 Encryption password saved to:", passwordFile);
    }

    // ── 8. Final output ────────────────────────────────────────────────────
    console.log("📍 Agent-Notarized Wallet Address — SAVE THIS:");
    console.log("  ", address.toString());
    console.log();
    console.log("💰 Deposit at least 20 XRD to this address for transaction fees.");
    console.log("   This XRD is used for notarization only — not for operations.");
    console.log();
    console.log("ℹ️  You can optionally import these seeds into the Radix Wallet app");
    console.log("   to control the Agent-Notarized Wallet manually when needed.");
    console.log();
    console.log("✅ Keystore saved to:", Keystore.path());
    console.log("\n🚀 Next step: go to the AgentWallet web dashboard and instantiate your component.\n");

  } finally {
    rl.close();
  }
}
