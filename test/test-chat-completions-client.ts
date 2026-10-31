import "dotenv/config";
import { getEnvConfig } from "../src/config/env.js";
import { callChatCompletions } from "../src/model/chat-completions-client.js";
import { bashTool, toChatCompletionTool } from "../src/tools/index.js";

const config = getEnvConfig();

console.log("=== Test 1: Basic Chat Completion ===");
const textResponse = await callChatCompletions(config.baseUrl, config.apiKey, {
  model: config.model,
  messages: [
    {
      role: "user",
      content: "介绍一下自己",
    },
  ],
  temperature: 0,
});

console.log("Message:", textResponse.choices[0].message);
console.log("Usage:", textResponse.usage);

console.log("\n=== Test 2: Tool Calling (Function Call) ===");
const toolResponse = await callChatCompletions(config.baseUrl, config.apiKey, {
  model: config.model,
  messages: [
    {
      role: "user",
      content: "请使用 bash 工具执行命令：echo 'Hello Agent'",
    },
  ],
  tools: [toChatCompletionTool(bashTool)],
});

console.log("Message:", JSON.stringify(toolResponse.choices[0].message, null, 2));
console.log("Finish Reason:", toolResponse.choices[0].finish_reason);
