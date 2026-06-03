import { init } from "./init";
import { recover } from "./recover";
import { unlockKeystore, getNotarizerAddress } from "./unlock";

const command = process.argv[2];

switch (command) {
  case "init":
    init().catch(console.error);
    break;
  case "status":
    try {
      unlockKeystore();
      console.log("✅ Keystore OK");
      console.log("📍 Direction:", getNotarizerAddress());
    } catch (e: any) {
      console.log(e.message);
    }
    break;
  case "recover":
    recover().catch(console.error);
    break;
 default:
    console.log("  recover — Recover wallet from 24 seeds + pass word");
    console.log("Use: agent-wallet <comand>");
    console.log("Comands:");
    console.log("  init    — Begin the wallet notarized");
    console.log("  status  — Verificate keystore and show direction");
    break;
}
