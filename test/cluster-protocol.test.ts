import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createEnvelope,
  encodeEnvelope,
  decodeEnvelope,
  ProtocolError,
  MAX_MESSAGE_SIZE_BYTES,
} from "../src/cluster/protocol/message-codec.js";
import { CLUSTER_PROTOCOL_VERSION } from "../src/cluster/protocol/types.js";

describe("Nash Cluster Protocol & Codec", () => {
  it("应正确创建并编码标准信封", () => {
    const envelope = createEnvelope(
      "node.hello",
      { name: "test-node", platform: "darwin" },
      "node-1",
      "coordinator"
    );

    assert.equal(envelope.protocolVersion, CLUSTER_PROTOCOL_VERSION);
    assert.equal(envelope.sourceNodeId, "node-1");
    assert.equal(envelope.targetNodeId, "coordinator");
    assert.equal(envelope.type, "node.hello");
    assert.ok(envelope.messageId.startsWith("msg-"));
    assert.ok(typeof envelope.timestamp === "number");

    const json = encodeEnvelope(envelope);
    assert.ok(typeof json === "string");
  });

  it("应正确解码并校验合法 JSON 信封", () => {
    const envelope = createEnvelope(
      "task.progress",
      { currentStep: 2, activitySummary: "Running tool" },
      "worker-1",
      "coordinator"
    );

    const raw = encodeEnvelope(envelope);
    const decoded = decodeEnvelope(raw);

    assert.equal(decoded.messageId, envelope.messageId);
    assert.equal(decoded.type, "task.progress");
    assert.deepEqual(decoded.payload, envelope.payload);
  });

  it("当协议版本不匹配时应抛出 VERSION_MISMATCH 错误", () => {
    const fake = {
      protocolVersion: "99.0",
      messageId: "msg-123",
      type: "node.hello",
      sourceNodeId: "n1",
      targetNodeId: "c1",
      timestamp: Date.now(),
      payload: {},
    };

    assert.throws(
      () => decodeEnvelope(JSON.stringify(fake)),
      (err: any) => err instanceof ProtocolError && err.code === "VERSION_MISMATCH"
    );
  });

  it("当缺少必填信封字段时应抛出 INVALID_ENVELOPE 错误", () => {
    const incomplete = {
      protocolVersion: CLUSTER_PROTOCOL_VERSION,
      // 缺少 messageId
      type: "node.hello",
      sourceNodeId: "n1",
      targetNodeId: "c1",
      timestamp: Date.now(),
      payload: {},
    };

    assert.throws(
      () => decodeEnvelope(JSON.stringify(incomplete)),
      (err: any) => err instanceof ProtocolError && err.code === "INVALID_ENVELOPE"
    );
  });

  it("当输入不是合法 JSON 时应抛出 MALFORMED_JSON 错误", () => {
    assert.throws(
      () => decodeEnvelope("{ invalid json"),
      (err: any) => err instanceof ProtocolError && err.code === "MALFORMED_JSON"
    );
  });

  it("当单条消息体积超出上限时应拦截拒绝", () => {
    const bigPayload = {
      data: "A".repeat(MAX_MESSAGE_SIZE_BYTES + 1024),
    };
    const env = createEnvelope("node.hello", bigPayload, "n1", "c1");

    assert.throws(
      () => encodeEnvelope(env),
      (err: any) => err instanceof ProtocolError && err.code === "MESSAGE_TOO_LARGE"
    );
  });
});
