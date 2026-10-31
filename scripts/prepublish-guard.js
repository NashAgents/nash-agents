#!/usr/bin/env node
if (process.env.NASH_PERMIT_PUBLISH !== "true") {
  console.error("\n=======================================================");
  console.error("  [SAFETY GUARD] npm publish is BLOCKED.");
  console.error("  Formal releases require explicit user authorization.");
  console.error("  To publish, run with NASH_PERMIT_PUBLISH=true.");
  console.error("=======================================================\n");
  process.exit(1);
}
console.log("Pre-publish safety check passed.");
