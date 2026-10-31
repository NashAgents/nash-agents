import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveModelFormat,
  resolveEndpointUrl,
  buildHeaders,
  serializeCompletionsRequest,
  deserializeCompletionsResponse,
  serializeResponsesRequest,
  deserializeResponsesResponse,
  serializeMessagesRequest,
  deserializeMessagesResponse,
  transformResponsesStream,
  transformMessagesStream,
} from "../src/model/model-adapter.js";
import type { ChatCompletionRequest } from "../src/model/chat-completions-client.js";

describe("Model Format Adapters", () => {
  it("resolves model format correctly from explicit config and baseUrl", () => {
    assert.equal(resolveModelFormat("completions"), "completions");
    assert.equal(resolveModelFormat("responses"), "responses");
    assert.equal(resolveModelFormat("messages"), "messages");
    assert.equal(resolveModelFormat("MESSAGES"), "messages");

    // Auto inference from baseUrl
    assert.equal(resolveModelFormat(undefined, "https://api.deepseek.com/anthropic"), "messages");
    assert.equal(resolveModelFormat(undefined, "https://api.deepseek.com/anthropic/v1"), "messages");
    assert.equal(resolveModelFormat(undefined, "https://api.deepseek.com/v1/responses"), "responses");
    assert.equal(resolveModelFormat(undefined, "https://api.deepseek.com/responses"), "responses");
    assert.equal(resolveModelFormat(undefined, "https://api.deepseek.com/v1"), "completions");
    assert.equal(resolveModelFormat(undefined, "https://api.deepseek.com"), "completions");
  });

  it("resolves endpoint URLs correctly for all formats", () => {
    assert.equal(
      resolveEndpointUrl("https://api.deepseek.com", "completions"),
      "https://api.deepseek.com/chat/completions"
    );
    assert.equal(
      resolveEndpointUrl("https://api.deepseek.com/v1", "completions"),
      "https://api.deepseek.com/v1/chat/completions"
    );

    assert.equal(
      resolveEndpointUrl("https://api.deepseek.com", "responses"),
      "https://api.deepseek.com/v1/responses"
    );
    assert.equal(
      resolveEndpointUrl("https://api.deepseek.com/v1", "responses"),
      "https://api.deepseek.com/v1/responses"
    );

    assert.equal(
      resolveEndpointUrl("https://api.deepseek.com/anthropic", "messages"),
      "https://api.deepseek.com/anthropic/v1/messages"
    );
    assert.equal(
      resolveEndpointUrl("https://api.deepseek.com", "messages"),
      "https://api.deepseek.com/anthropic/v1/messages"
    );
  });

  it("builds appropriate headers per format", () => {
    const completionsHeaders = buildHeaders("test-key", "completions");
    assert.equal(completionsHeaders["Authorization"], "Bearer test-key");
    assert.equal(completionsHeaders["Content-Type"], "application/json");

    const messagesHeaders = buildHeaders("test-key", "messages");
    assert.equal(messagesHeaders["x-api-key"], "test-key");
    assert.equal(messagesHeaders["anthropic-version"], "2023-06-01");
  });

  it("serializes and deserializes OpenAI Responses format correctly", () => {
    const request: ChatCompletionRequest = {
      model: "deepseek-flash",
      messages: [
        { role: "system", content: "System instruction" },
        { role: "user", content: "Calculate 1+1" },
        {
          role: "assistant",
          reasoning_content: "I need to call calculator",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "calc", arguments: '{"expr":"1+1"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "2",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "calc",
            description: "Calculate",
            parameters: { type: "object", properties: { expr: { type: "string" } } },
          },
        },
      ],
    };

    const serialized = serializeResponsesRequest(request, false);
    assert.equal(serialized.model, "deepseek-flash");
    const input = serialized.input as any[];
    assert.equal(input.length, 5);
    assert.equal(input[0].type, "message");
    assert.equal(input[0].role, "system");
    assert.equal(input[1].type, "message");
    assert.equal(input[1].role, "user");
    assert.equal(input[2].type, "reasoning");
    assert.equal(input[2].content[0].text, "I need to call calculator");
    assert.equal(input[3].type, "function_call");
    assert.equal(input[3].call_id, "call_1");
    assert.equal(input[4].type, "function_call_output");
    assert.equal(input[4].call_id, "call_1");
    assert.equal(input[4].output, "2");

    const rawResponse = {
      id: "resp_123",
      model: "deepseek-flash",
      output: [
        {
          type: "reasoning",
          content: [{ type: "reasoning_text", text: "The answer is 2" }],
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "1 + 1 equals 2." }],
        },
      ],
      usage: { input_tokens: 15, output_tokens: 8, total_tokens: 23 },
    };

    const deserialized = deserializeResponsesResponse(rawResponse);
    assert.equal(deserialized.id, "resp_123");
    assert.equal(deserialized.choices[0].message.content, "1 + 1 equals 2.");
    assert.equal(deserialized.choices[0].message.reasoning_content, "The answer is 2");
    assert.equal(deserialized.usage?.total_tokens, 23);
  });

  it("serializes and deserializes Anthropic Messages format correctly", () => {
    const request: ChatCompletionRequest = {
      model: "deepseek-flash",
      messages: [
        { role: "system", content: "System instruction" },
        { role: "user", content: "What is the weather?" },
        {
          role: "assistant",
          reasoning_content: "Need to check weather",
          tool_calls: [
            {
              id: "call_99",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_99",
          content: "Sunny 25C",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
    };

    const serialized = serializeMessagesRequest(request, false);
    assert.equal(serialized.model, "deepseek-flash");
    assert.equal(serialized.system, "System instruction");
    const msgs = serialized.messages as any[];
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[1].role, "assistant");
    assert.equal(msgs[2].role, "user");
    assert.equal(msgs[2].content[0].type, "tool_result");
    assert.equal(msgs[2].content[0].tool_use_id, "call_99");

    const rawResponse = {
      id: "msg_456",
      type: "message",
      role: "assistant",
      model: "deepseek-flash",
      content: [
        { type: "thinking", thinking: "Paris is sunny." },
        { type: "text", text: "Paris is currently sunny at 25°C." },
      ],
      usage: { input_tokens: 30, output_tokens: 12 },
    };

    const deserialized = deserializeMessagesResponse(rawResponse);
    assert.equal(deserialized.id, "msg_456");
    assert.equal(deserialized.choices[0].message.content, "Paris is currently sunny at 25°C.");
    assert.equal(deserialized.choices[0].message.reasoning_content, "Paris is sunny.");
    assert.equal(deserialized.usage?.prompt_tokens, 30);
    assert.equal(deserialized.usage?.completion_tokens, 12);
  });

  it("transforms Responses SSE stream events to standard chunks", async () => {
    async function* mockEvents() {
      yield { event: "response.created", data: JSON.stringify({ response: { id: "stream_1", model: "deepseek-flash" } }) };
      yield { event: "response.output_item.added", data: JSON.stringify({ output_index: 0, item: { type: "reasoning" } }) };
      yield { event: "response.reasoning_text.delta", data: JSON.stringify({ delta: "Thinking..." }) };
      yield { event: "response.output_item.added", data: JSON.stringify({ output_index: 1, item: { type: "message" } }) };
      yield { event: "response.output_text.delta", data: JSON.stringify({ delta: "Hello!" }) };
      yield { event: "response.done", data: JSON.stringify({ response: { usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } }) };
    }

    const chunks = [];
    for await (const chunk of transformResponsesStream(mockEvents())) {
      chunks.push(chunk);
    }

    assert.ok(chunks.length >= 3);
    const thoughtChunk = chunks.find((c) => c.choices[0].delta.reasoning_content);
    assert.equal(thoughtChunk?.choices[0].delta.reasoning_content, "Thinking...");
    const contentChunk = chunks.find((c) => c.choices[0].delta.content);
    assert.equal(contentChunk?.choices[0].delta.content, "Hello!");
    const doneChunk = chunks.find((c) => c.usage);
    assert.equal(doneChunk?.usage?.total_tokens, 7);
  });

  it("transforms Messages SSE stream events to standard chunks", async () => {
    async function* mockEvents() {
      yield { event: "message_start", data: JSON.stringify({ message: { id: "msg_stream_1", model: "deepseek-flash", usage: { input_tokens: 10, output_tokens: 0 } } }) };
      yield { event: "content_block_start", data: JSON.stringify({ index: 0, content_block: { type: "thinking" } }) };
      yield { event: "content_block_delta", data: JSON.stringify({ index: 0, delta: { type: "thinking_delta", thinking: "Pondering..." } }) };
      yield { event: "content_block_start", data: JSON.stringify({ index: 1, content_block: { type: "text" } }) };
      yield { event: "content_block_delta", data: JSON.stringify({ index: 1, delta: { type: "text_delta", text: "Greetings!" } }) };
      yield { event: "message_delta", data: JSON.stringify({ delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) };
    }

    const chunks = [];
    for await (const chunk of transformMessagesStream(mockEvents())) {
      chunks.push(chunk);
    }

    assert.ok(chunks.length >= 3);
    const thoughtChunk = chunks.find((c) => c.choices[0].delta.reasoning_content);
    assert.equal(thoughtChunk?.choices[0].delta.reasoning_content, "Pondering...");
    const contentChunk = chunks.find((c) => c.choices[0].delta.content);
    assert.equal(contentChunk?.choices[0].delta.content, "Greetings!");
    const doneChunk = chunks.find((c) => c.choices[0].finish_reason === "stop");
    assert.ok(doneChunk);
  });
});
