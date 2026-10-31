import { it } from "node:test";
import assert from "node:assert/strict";
import { verifyPosixSandbox } from "../src/sandbox/posix-verification.js";

it("POSIX capability verification executes positive controls and both policy boundaries", {
  skip: !["darwin", "linux"].includes(process.platform),
}, () => {
  const result = verifyPosixSandbox();
  if (!result.structuredDetails.installed) {
    assert.equal(result.verified, false);
    assert.equal(result.structuredDetails.filesystemIsolationVerified, false);
    return;
  }
  assert.equal(result.verified, true, result.details.join("; "));
  assert.equal(result.structuredDetails.filesystemIsolationVerified, true);
  assert.equal(result.structuredDetails.networkIsolationVerified, true);
  assert.ok(result.structuredDetails.verificationExpiresAt! > Date.now());
});
