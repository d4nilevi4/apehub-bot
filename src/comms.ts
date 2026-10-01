import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Bridge } from "./bridge";

/**
 * In-process MCP server given to every session so the agent can talk to the
 * Telegram user instead of blocking on a terminal. Created per-run so it can
 * capture the current topic id.
 */
export function makeCommsServer(bridge: Bridge, topicId: number) {
  return createSdkMcpServer({
    name: "apehub-comms",
    version: "1.0.0",
    tools: [
      tool(
        "ask_user",
        "Ask the Telegram user a free-form question and wait for their reply. Use this instead of ever waiting for terminal/stdin input.",
        { question: z.string().describe("The question to show the user") },
        async (args) => {
          const answer = await bridge.askUser(topicId, args.question);
          return { content: [{ type: "text" as const, text: answer }] };
        },
      ),
    ],
  });
}
