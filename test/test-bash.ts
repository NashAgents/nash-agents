import "dotenv/config";
import { executeBash, bashTool, toChatCompletionTool } from "../src/tools/index.js";

console.log("=== bashTool Definition ===");
console.log(toChatCompletionTool(bashTool));

console.log("\n=== Test 1: Normal command (echo) ===");
const res1 = await executeBash('echo "Hello from executeBash"');
console.log(res1);

console.log("\n=== Test 2: Custom working directory (pwd with cwd: /tmp) ===");
const res2 = await executeBash("pwd", { cwd: "/tmp" });
console.log(res2);

console.log("\n=== Test 3: Command with stderr and non-zero exit code ===");
const res3 = await executeBash("ls nonexistent_file_for_test");
console.log(res3);

console.log("\n=== Test 4: Command with no output ===");
const res4 = await executeBash("true");
console.log(res4);

console.log("\n=== Test 5: Timeout handling (sleep 2 with timeoutMs: 500) ===");
const res5 = await executeBash("sleep 2", { timeoutMs: 500 });
console.log(res5);
