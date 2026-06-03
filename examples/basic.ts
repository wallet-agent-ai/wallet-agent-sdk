/**
 * AgentWallet for Radix — Basic Usage Example
 *
 * ─── OWNER SETUP (done once by the human owner) ──────────────────────────────
 *
 * Before running this file, the owner must:
 *
 * 1. Deploy the PolicyVault smart contract on Radix network
 *    - Use the deploy page at: https://agentwallet-radix.github.io/deploy
 *    - Or run: resim call-function <package> PolicyVault instantiate <limit> []
 *
 * 2. Fund the PolicyVault with XRD and/or other tokens
 *    - The agent can only spend what the owner deposits
 *
 * 3. Configure the whitelist
 *    - Add the destination addresses the agent is allowed to send funds to
 *
 * 4. Save the following addresses from the deploy output:
 *    - POLICY_VAULT_ADDRESS  → the deployed component address
 *    - AGENT_BADGE_ADDRESS   → the agent badge resource address
 *
 * 5. Create a .env file with the following variables:
 *    POLICY_VAULT_ADDRESS=component_rdx1...
 *    AGENT_BADGE_ADDRESS=resource_rdx1...
 *    AGENT_PRIVATE_KEY=your_agent_private_key
 *    AGGR_ENDPOINT=http://localhost:3001        # optional, only for trading or https://api.astrolescent.com 
 *    AGGR_PARTNER_ID=XXXX                       # optional, only for trading
 *
 * ─── AGENT CAPABILITIES (what the agent can do automatically) ────────────────
 *
 * Once configured, the agent can autonomously:
 *
 * ✓ Check vault balance               → wallet_balance tool
 * ✓ Transfer XRD/HUSDC/HUSDT/HWBTC/HETH to whitelisted addresses
 *                                     → wallet_transfer tool
 * ✓ Swap tokens via AGGR (optional)   → wallet_swap tool
 * ✓ Place conditional orders (optional) → wallet_conditional_order tool
 *
 * The agent CANNOT:
 * ✗ Send funds to addresses not in the whitelist
 * ✗ Spend more than the configured limit per operation
 * ✗ Access funds beyond what the owner deposited
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { AgentWallet, createAgentWalletTools } from "../src";

// ─── Step 1: Load environment variables ──────────────────────────────────────
// Install dotenv if needed: npm install dotenv
// Create a .env file with the variables listed above

const {
  POLICY_VAULT_ADDRESS,
  AGENT_BADGE_ADDRESS,
  AGENT_PRIVATE_KEY,
  AGGR_ENDPOINT,
  AGGR_PARTNER_ID,
} = process.env;

if (!POLICY_VAULT_ADDRESS || !AGENT_BADGE_ADDRESS || !AGENT_PRIVATE_KEY) {
  throw new Error(
    "Missing required environment variables. " +
    "Please create a .env file with POLICY_VAULT_ADDRESS, " +
    "AGENT_BADGE_ADDRESS and AGENT_PRIVATE_KEY."
  );
}

// ─── Step 2: Initialize the AgentWallet ──────────────────────────────────────
// This is the only configuration the developer needs to write.
// The wallet connects to the PolicyVault deployed by the owner.

const wallet = new AgentWallet({
  componentAddress: POLICY_VAULT_ADDRESS,
  badgeResourceAddress: AGENT_BADGE_ADDRESS,
  privateKey: AGENT_PRIVATE_KEY,
  network: "stokenet", // change to "mainnet" for production

  // Optional: only needed if the agent will trade via AGGR
  // Works with both public AGGR (ASTRL) and private AGGR instances
  // Just change the endpoint URL — everything else is identical
  ...(AGGR_ENDPOINT && AGGR_PARTNER_ID && {
    aggrConfig: {
      endpoint: AGGR_ENDPOINT,
      partnerId: AGGR_PARTNER_ID,
      timeoutMs: 5000,
    },
  }),
});

// ─── Step 3: (Optional) Register custom assets ───────────────────────────────
// Default assets available: XRD, HUSDC, HUSDT, HWBTC, HETH
// Add any additional token your agent needs to work with

// wallet.registerAsset("MYTOKEN", {
//   mainnet:  "resource_rdx1t...",
//   stokenet: "resource_tdx_2_1t...",
// });

// ─── Step 4: Create the tools and give them to your agent ────────────────────
// This is all your agent framework needs to start operating autonomously.
// Compatible with LangChain, AutoGen, CrewAI, Vercel AI SDK and any
// framework that supports OpenAI-style function calling.

const tools = createAgentWalletTools(wallet);

// Your agent is now ready. Example with LangChain:
//
// import { AgentExecutor } from "langchain/agents";
// const agent = new AgentExecutor({ llm, tools });
// await agent.invoke({
//   input: "Pay 50 XRD to account_rdx1... for API service invoice #42"
// });
//
// The LLM will automatically decide when and how to use each tool.
// No further human intervention is needed.

// ─── Quick test: check vault balance ─────────────────────────────────────────
// Run this file directly to verify your setup is working:
// ts-node examples/basic.ts

const balance = await wallet.getBalance();
console.log("✓ AgentWallet connected successfully");
console.log("✓ Vault balance:", balance.balances);
console.log("✓ Available assets:", wallet.listAssets());
console.log("✓ Tools ready for agent:", tools.map(t => t.name).join(", "));
console.log("\nYour agent is ready to operate autonomously on Radix.");

