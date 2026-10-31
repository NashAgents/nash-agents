import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  parseSseStream,
  accumulateChatCompletionStream,
  type ChatCompletionChunk,
} from "../src/model/chat-completions-client.js";

describe("Chat Completions SSE Streaming & Reasoning Subsystem", () => {
  describe("1. parseSseStream Chunk Boundary & Robustness", () => {
    it("1.1 正确处理跨数据包 (TCP fragmentation) 切割的 SSE 数据行", async () => {
      // 模拟两个物理 chunk，将一条 data: {"foo": "bar"} 从中间切开
      const chunk1 = "data: {\"id\": \"chunk-1\", \"cho";
      const chunk2 = "ices\": []}\n\ndata: [DONE]\n\n";

      const stream = Readable.from([chunk1, chunk2]);
      const events: string[] = [];

      for await (const data of parseSseStream(stream)) {
        events.push(data);
      }

      assert.strictEqual(events.length, 2);
      assert.strictEqual(events[0], '{"id": "chunk-1", "choices": []}');
      assert.strictEqual(events[1], "[DONE]");
    });

    it("1.2 自动忽略注释行 (: ping) 与空行分隔符", async () => {
      const raw = ": keep-alive ping\n\ndata: {\"test\": 1}\n\n: another comment\ndata: [DONE]\n";
      const stream = Readable.from([raw]);
      const events: string[] = [];

      for await (const data of parseSseStream(stream)) {
        events.push(data);
      }

      assert.strictEqual(events.length, 2);
      assert.strictEqual(events[0], '{"test": 1}');
      assert.strictEqual(events[1], "[DONE]");
    });
  });

  describe("2. accumulateChatCompletionStream Reasoning & Tool Calls Assembly", () => {
    it("2.1 累积流式 reasoning_content 并在回调中实时触发 onThoughtDelta", async () => {
      const chunks: ChatCompletionChunk[] = [
        {
          id: "msg-1",
          choices: [
            {
              index: 0,
              delta: { reasoning_content: "Let me think about " },
              finish_reason: null,
            },
          ],
        },
        {
          id: "msg-1",
          choices: [
            {
              index: 0,
              delta: { reasoning_content: "the project structure." },
              finish_reason: null,
            },
          ],
        },
        {
          id: "msg-1",
          choices: [
            {
              index: 0,
              delta: { content: "Here is the answer." },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 50,
            completion_tokens: 25,
            total_tokens: 75,
          },
        },
      ];

      const thoughtDeltas: string[] = [];
      const contentDeltas: string[] = [];

      const result = await accumulateChatCompletionStream(
        chunks,
        {
          onThoughtDelta: (d) => thoughtDeltas.push(d),
          onContentDelta: (c) => contentDeltas.push(c),
        }
      );

      assert.strictEqual(thoughtDeltas.join(""), "Let me think about the project structure.");
      assert.strictEqual(contentDeltas.join(""), "Here is the answer.");
      assert.strictEqual(result.reasoning_content, "Let me think about the project structure.");
      assert.strictEqual(result.response.choices[0]?.message.content, "Here is the answer.");
      assert.strictEqual(result.response.choices[0]?.message.reasoning_content, "Let me think about the project structure.");
      assert.strictEqual(result.response.usage?.total_tokens, 75);
    });

    it("2.2 跨多个 delta 按 index 组装完整的工具调用与参数 JSON", async () => {
      const chunks: ChatCompletionChunk[] = [
        {
          id: "msg-tool",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_abc123",
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: "{\"pa",
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "msg-tool",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: "th\": \"package.json\"}",
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ];

      const result = await accumulateChatCompletionStream(chunks);
      const toolCalls = result.response.choices[0]?.message.tool_calls;

      assert.ok(toolCalls);
      assert.strictEqual(toolCalls.length, 1);
      assert.strictEqual(toolCalls[0]?.id, "call_abc123");
      assert.strictEqual(toolCalls[0]?.function.name, "read_file");
      assert.strictEqual(toolCalls[0]?.function.arguments, "{\"path\": \"package.json\"}");
      assert.strictEqual(JSON.parse(toolCalls[0]!.function.arguments).path, "package.json");
    });

    it("2.3 支持从 content 中的 <think>...</think> 标签中流式剥离思考与正文", async () => {
      const chunks: ChatCompletionChunk[] = [
        {
          id: "msg-think-tag",
          choices: [
            {
              index: 0,
              delta: { content: "<think>我将首先检查配置" },
              finish_reason: null,
            },
          ],
        },
        {
          id: "msg-think-tag",
          choices: [
            {
              index: 0,
              delta: { content: "文件，然后进行分析。</think>你好，我已经完成分析。" },
              finish_reason: "stop",
            },
          ],
        },
      ];

      const thoughtDeltas: string[] = [];
      const contentDeltas: string[] = [];

      const result = await accumulateChatCompletionStream(
        chunks,
        {
          onThoughtDelta: (d) => thoughtDeltas.push(d),
          onContentDelta: (c) => contentDeltas.push(c),
        }
      );

      assert.strictEqual(thoughtDeltas.join(""), "我将首先检查配置文件，然后进行分析。");
      assert.strictEqual(contentDeltas.join(""), "你好，我已经完成分析。");
      assert.strictEqual(result.reasoning_content, "我将首先检查配置文件，然后进行分析。");
      assert.strictEqual(result.response.choices[0]?.message.content, "你好，我已经完成分析。");
      assert.strictEqual(result.response.choices[0]?.message.reasoning_content, "我将首先检查配置文件，然后进行分析。");
    });
  });
});
