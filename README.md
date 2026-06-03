# AgentWallet for Radix

A programmable wallet designed for AI agents operating on the Radix network.
Secure, auditable, and easy to integrate with any agent framework.

---

## What is AgentWallet?

AgentWallet lets you give your AI agent the ability to handle payments and trading
on the Radix network — safely and autonomously — without giving it full control
over your funds.

The owner defines the rules. The agent operates within them. On-chain, always.

**The agent CAN:**
- ✓ Transfer XRD, HUSDC, HUSDT, HWBTC and HETH to approved addresses
- ✓ Swap tokens via AGGR (Astrolescent or your own private instance)
- ✓ Place conditional orders that execute automatically at a target price
- ✓ Check vault balance before operating

**The agent CANNOT:**
- ✗ Send funds to addresses not in the whitelist
- ✗ Spend more than the configured limit per operation
- ✗ Access funds beyond what the owner let him on contract
- ✗ Modify its own permissions

---

## How it works
Owner install the SDK for his agent → init it
↓
Owner deploys PolicyVault → funds it → configures rules
↓
Receives 2 badges: Agent session badge (AWB) and PolicyVault Owner badge (PVOB) 
↓
Agent calls wallet.transfer() / wallet.swap() / wallet.createConditionalOrder()
↓
PolicyVault verifies: valid badge + within spend limit + destination in whitelist
↓
Transaction executes on Radix — fully auditable on-chain

---

## Requirements

- Node.js 18 or higher
- A Radix wallet with XRD for the deployment fees.
- Your AI agent running on any framework (LangChain, AutoGen, CrewAI, etc.)

---

## Installation

```bash
npm install wallet-agent-ai
npx agent-wallet init 
```

---

## Owner Setup (done once)

Before your agent can operate, you need to deploy and fund the PolicyVault.
This is a one-time setup done by the human owner.

### Step 1 — Deploy the PolicyVault

Go to the deploy page and connect your Radix Wallet:

👉 **https://wallet-agent-ai.github.io/**

Fill in:

- **Agent Name** — agent name

- **Notarized Account** — The agent notarized account created with the installation and init of these sdk 

- **Max Per Tx** — maximum tokens the agent can send per operation (e.g. 100 XRD)

- **Multisig Threshold** — maximum tokens the agent and owner can spend together in a single tx

- **Daily Cap** — maximum tokens the agent can spend in a day

Click **Instantiate** and approve the transaction in your Radix Wallet.

You will receive:
- `COMPONENT_ADDRESS` — The deployed component address
- `AGENT_BADGE_ADDRESS` — AWB the agent badge resource address
The PVOB go to your account , the AWB to the notarized account of the agent. The AWB cant be moved. Only burn. 
- `POLICY_VAULT_OWNER_BADGE` — PVOB the owner badge resource address, go to the owner wallet.
- `NOTARIZER_ACCOUNT` — The notarized account created on SDK.
Save all. You will need them in the next step.

### Step 2 — Fund the PolicyVault

Send XRD and/or other tokens to your PolicyVault from your Radix Wallet.And some too to the Notarized Agent for fee only. 
These acount need a 25 xrd min account for fees that normally never be used. 
The agent can only spend what you autorized. No more.

### Step 3 — Create your .env.agent file

Create a `.env.agent` file in your agent project
on the package come a example with the required

```bash
NETWORK=mainnet 

# On the SDK init you create a account that is for notarize 
and for the instantiate process , these is the account that you must to put on notarized , on aggent account and the privateKey.
The agent dont use the private key for signs , only to intents signature of tx under notarized, the funds for agent are on the component and it could not use outside its limits. 

# Optional because normally is read from keystore created on initof the SDK
#NOTARIZER_PRIVATE_KEY
NOTARIZER_PRIVATE_KEY=XXXXXXXX 


# Required
#NOTARIZER_ADDRESS
NOTARIZER_ADDRESS=account_XXXXXX
#AGENT_ACCOUNT_ADDRESS
AGENT_ACCOUNT_ADDRESS=account_XXXX
#COMPONENT_ADDRESS or POLICY_VAULT_ADDRESS SAME 
COMPONENT_ADDRESS=component_XXXXXXX
#BADGE_RESOURCE_ADDRESS
BADGE_RESOURCE_ADDRESS=resource_XXXXXX
#BADGE_LOCAL_ID normaly is #1# always 
BADGE_LOCAL_ID="#1#" 
#OWNER_BADGE_ADDRESS
# Needed for: transfers above multisig threshold, badge management
OWNER_BADGE_ADDRESS=resource_XXX


# Optional — only needed for token swaps and conditional orders
# Use Astrolescent (public) or your own AGGR instance (private)
#Need to ask @djtrebel for a api key on telegram  
AGGR_ENDPOINT=https://api.astrolescent.com
AGGR_PARTNER_ID=XXXX
AGGR_TIMEOUT_MS=30000

```

---

## Agent Integration (3 lines of code)

```typescript
import { AgentWallet, createAgentWalletTools } from "agentwallet-radix";

const wallet = new AgentWallet({
  componentAddress: process.env.POLICY_VAULT_ADDRESS!,
  badgeResourceAddress: process.env.AGENT_BADGE_ADDRESS!,
  privateKey: process.env.AGENT_PRIVATE_KEY!,
  network: "mainnet", // or "stokenet" for testing

  // Optional — remove if you don't need trading
  aggrConfig: {
    endpoint: process.env.AGGR_ENDPOINT!,
    partnerId: process.env.AGGR_PARTNER_ID!,
  },
});

const tools = createAgentWalletTools(wallet);

// Pass tools to your agent — it will use them autonomously
```

### LangChain

```typescript
import { AgentExecutor } from "langchain/agents";

const agent = new AgentExecutor({ llm, tools });
await agent.invoke({
  input: "Pay 50 XRD to account_rdx1... for API invoice #42"
});
```

### OpenAI function calling

```typescript
import OpenAI from "openai";

const openai = new OpenAI();

const response = await openai.chat.completions.create({
  model: "gpt-4",
  messages: [{ role: "user", content: "Check my vault balance" }],
  tools: tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }
  })),
});
```

### AutoGen / CrewAI

```typescript
// Any framework that supports function calling works the same way
// Pass the tools array to your agent executor
```

---

## Available Tools

| Tool | Description |
|---|---|
| `wallet_balance` | Check current vault balance for all assets |
| `wallet_transfer` | Transfer tokens to a whitelisted address |
| `wallet_swap` | Swap tokens via AGGR (requires aggrConfig) |
| `wallet_conditional_order` | Buy or sell automatically at a target price |

---

## Adding Custom Assets

Default assets: `XRD`, `HUSDC`, `HUSDT`, `HWBTC`, `HETH`

To add any additional token:

```typescript
wallet.registerAsset("MYTOKEN", {
  mainnet:  "resource_rdx1t...",
  stokenet: "resource_tdx_2_1t...",
});

// Now use it like any default asset
await wallet.transfer({
  to: "account_rdx1...",
  amount: 100,
  asset: "MYTOKEN",
  reason: "payment"
});
```

---

## Networks

| Network | Description |
|---|---|
| `mainnet` | Radix mainnet — real funds |
| `stokenet` | Radix testnet — for development and testing |
| `localnet` | Local resim simulator — for development without network |

---

## Security Model

AgentWallet uses a **PolicyVault** smart contract deployed on Radix.
Every transaction the agent attempts is verified on-chain before execution:

1. **Badge check** — the agent must present a valid session badge (NFT)
2. **Spend limit** — the amount must not exceed the configured maximum per operation
3. **Whitelist** — the destination address must be in the approved list

If any check fails, the transaction is rejected by the Radix Engine — not by the SDK.
This means the rules are enforced at the protocol level, not in application code.

---

## AGGR Integration

AgentWallet supports both public and private AGGR instances for token swaps.
The integration is identical — only the endpoint URL changes
if you have your own aggr:

```bash
# Public — Astrolescent
AGGR_ENDPOINT=https://api.astrolescent.com

# Private — your own instance 
AGGR_ENDPOINT=http://your-server-ip:3001
```

No code changes required. Just update your `.env` file.

---

## Support this project

If AgentWallet is useful to you, consider supporting development:

**Radix donation address:**
Welcome any donation on XRD or other HTOKENS.

account_rdx128m9tq6xhxtmyx9z25s2xudm9g5pzxrypygzwh7ml8sfst46q0t892
---

## License

GPL3  
Owner: Luis Toro Teijeiro aka linuxx @linuxx_xrd on Telegram 

Built on [Radix](https://radixdlt.com) · Powered by [Scrypto](https://docs.radixdlt.com/docs/scrypto)
