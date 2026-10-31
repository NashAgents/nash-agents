import { runWindowsProductService } from "./windows-product-service.js";

try {
  await runWindowsProductService(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Windows product service failed");
  process.exitCode = 78;
}
