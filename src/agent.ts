import { config } from "dotenv";
config({ path: ".env.agent" });
import * as readline from "readline";

import { ChatGroq } from "@langchain/groq";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { AgentWallet } from "./core/AgentWallet";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createAgentWalletTools } from "./tools/LangChainTools";
import { unlockKeystore, getNotarizerAddress } from "./cli/unlock";


// ─── Keystore ─────────────────────────────────────────────────────────────────
const privateKey = unlockKeystore();
const notarizerAddress = getNotarizerAddress();
console.log(`[Agent] Notarizer: ${notarizerAddress}`);

// ─── AgentWallet ──────────────────────────────────────────────────────────────
const wallet = new AgentWallet({
  network: "mainnet",
  privateKey,
  notarizerAddress,
  componentAddress: process.env.COMPONENT_ADDRESS!,
  badgeResourceAddress: process.env.BADGE_RESOURCE_ADDRESS!,
  badgeLocalId: process.env.BADGE_LOCAL_ID ?? "#1#",
  ownerBadgeAddress: process.env.OWNER_BADGE_ADDRESS!,
  aggrConfig: {
    endpoint: "https://api.astrolescent.com",
    partnerId: process.env.AGGR_PARTNER_ID ?? "agentwallet",
    mockMode: false,
  },
  onLowFunds: (warnings) => warnings.forEach(w => console.log(`⚠️ ${w}`)),
  onTransferApproved: (details) => console.log(`✅ Transfer approved:`, details),
  onTransferRejected: (details) => console.log(`❌ Transfer rejected:`, details),
});

// ─── LangChain Tools ──────────────────────────────────────────────────────────
const agentWalletTools = createAgentWalletTools(wallet);

const langchainTools = agentWalletTools.map(tool =>
  new DynamicStructuredTool({
    name: tool.name,
    description: tool.description,
    schema: z.object(
      Object.fromEntries(
        Object.entries((tool.parameters as any).properties ?? {}).map(([k, v]: [string, any]) => [
          k,
          v.type === "number" ? z.number().describe(v.description ?? "") :
          v.enum ? z.enum(v.enum as [string, ...string[]]).describe(v.description ?? "") :
          z.string().describe(v.description ?? "")
        ])
      )
    ),
    func: async (params) => tool.call(params),
  })
);

// ─── LLM ──────────────────────────────────────────────────────────────────────
const llm = new ChatGroq({
  apiKey: process.env.GROQ_API_KEY!,
  model: "openai/gpt-oss-120b",
  temperature: 0,
});

// ─── Telegram ─────────────────────────────────────────────────────────────────
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

async function notify(text: string) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
}

// ─── Agent ────────────────────────────────────────────────────────────────────
const agent = createReactAgent({
  llm,
  tools: langchainTools,
  prompt: `You are AgentWallet — an autonomous AI agent that manages a crypto wallet on the Radix blockchain.
You have access to tools to transfer tokens, swap assets, create conditional orders, and check balances.
Always check the balance and config before operating.
Be precise with amounts and addresses.
Always provide a reason for every transfer or swap.
If a transfer exceeds the multisig threshold, request owner approval automatically.`,
});

// ─── Main ─────────────────────────────────────────────────────────────────────
async function runInstruction(instruction: string): Promise<string> {
  const result = await agent.invoke({
    messages: [{ role: "user", content: instruction }]
  });
  const lastMessage = result.messages[result.messages.length - 1];
  return typeof lastMessage.content === "string"
    ? lastMessage.content
    : JSON.stringify(lastMessage.content);
}

async function main() {
  console.log("\n🤖 AgentWallet Agent ready — Mainnet");
  console.log("Type your instructions in natural language. Type 'exit' to quit.\n");
  await notify("🤖 AgentWallet Agent online — Mainnet. Ready for instructions.");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = () => {
    rl.question("👤 You: ", async (instruction) => {
      if (!instruction.trim()) {
        askQuestion();
        return;
      }

      if (instruction.toLowerCase() === "exit") {
        console.log("👋 Bye!");
        await notify("🤖 Agent offline.");
        rl.close();
        return;
      }

      try {
        await notify(`👤 ${instruction}`);
        console.log("\n⏳ Processing...\n");
        const output = await runInstruction(instruction);
        console.log(`\n🤖 Agent: ${output}\n`);
        await notify(`🤖 ${output}`);
      } catch (err: any) {
        console.error(`❌ Error: ${err.message}`);
        await notify(`❌ Error: ${err.message}`);
      }

      askQuestion();
    });
  };

  askQuestion();
}

main().catch(async (err) => {
  console.error(err);
  await notify(`❌ Agent error: ${err.message}`);
});
