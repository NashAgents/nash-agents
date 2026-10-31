import type { NodeHardwareCapability } from "./types.js";
import type { FilesystemMode, NetworkMode } from "../../sandbox/types.js";

export function validateSandboxRequirements(
  platform: string,
  capability: NodeHardwareCapability | undefined,
  filesystem: FilesystemMode,
  network: NetworkMode,
  now = Date.now(),
): { code: "STALE_SANDBOX_CAPABILITY" | "SANDBOX_INCOMPATIBLE"; reason: string } | undefined {
  if (platform === "win32") return validateWindowsSandboxRequirements(capability, filesystem, network, now);
  if (filesystem === "danger-full-access" && network === "allow") return undefined;
  const details = capability?.structuredDetails;
  if (capability?.status !== "verified" || !details?.operational || !details.installed) {
    return { code: "SANDBOX_INCOMPATIBLE", reason: "Restricted execution requires an operational, verified sandbox" };
  }
  if (!details.verificationExpiresAt || details.verificationExpiresAt <= now) {
    return { code: "STALE_SANDBOX_CAPABILITY", reason: "Sandbox verification is missing or expired" };
  }
  const compatible = platform === "darwin" ? details.backend === "seatbelt"
    : platform === "linux" && ["bubblewrap", "landlock"].includes(details.backend);
  if (!compatible || !details.supportedPolicies.includes(filesystem) || !details.supportedNetworkModes.includes(network)
    || (filesystem !== "danger-full-access" && !details.filesystemIsolationVerified)
    || (network === "deny" && !details.networkIsolationVerified)) {
    return { code: "SANDBOX_INCOMPATIBLE", reason: `Verified sandbox cannot satisfy ${platform}: ${filesystem} / network:${network}` };
  }
}

export function validateWindowsSandboxRequirements(
  capability: NodeHardwareCapability | undefined,
  filesystem: FilesystemMode,
  network: NetworkMode,
  now = Date.now(),
): { code: "STALE_SANDBOX_CAPABILITY" | "SANDBOX_INCOMPATIBLE"; reason: string } | undefined {
  if (filesystem === "danger-full-access" && network === "allow") return undefined;
  const details = capability?.structuredDetails;
  if (!details || !details.operational) return { code: "SANDBOX_INCOMPATIBLE", reason: "Windows sandbox has no operational verified capability" };
  if (!details.supportedPolicies.includes(filesystem) || !details.supportedNetworkModes.includes(network) ||
      ((filesystem === "read-only" || filesystem === "workspace-write") && !details.filesystemIsolationVerified) ||
      (network === "deny" && !details.networkIsolationVerified)) {
    return { code: "SANDBOX_INCOMPATIBLE", reason: `Windows Native sandbox cannot satisfy ${filesystem} + network: ${network}; execution denied (Fail-Closed)` };
  }
  if (!details.verificationExpiresAt || details.verificationExpiresAt <= now) return { code: "STALE_SANDBOX_CAPABILITY", reason: "Windows sandbox verification expired or missing" };
  if (!details.helperSha256 || !details.helperPath) return { code: "SANDBOX_INCOMPATIBLE", reason: "Windows helper artifact identity is unverified" };

  return undefined;
}
