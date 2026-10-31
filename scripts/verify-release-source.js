import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "nash-agents";
const REPOSITORY_SLUG = "NashAgents/nash-agents";
const REPOSITORY_URL = "https://github.com/NashAgents/nash-agents";
const RELEASE_BRANCH = "main";
const REQUIRED_NODE_RANGE = ">=24.14.0 <25";

export class ReleaseGuardError extends Error {}

function git(root, ...args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? "").trim();
    throw new ReleaseGuardError(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

function requireValue(value, message) {
  if (value === undefined || value === null || value === "") throw new ReleaseGuardError(message);
  return value;
}

function assertPackageMetadata(pkg, expectedVersion) {
  if (pkg.name !== PACKAGE_NAME) {
    throw new ReleaseGuardError(`package.json name must be ${PACKAGE_NAME}, got ${JSON.stringify(pkg.name)}`);
  }
  if (pkg.version !== expectedVersion) {
    throw new ReleaseGuardError(`package.json version must be ${expectedVersion}, got ${JSON.stringify(pkg.version)}`);
  }
  if (pkg.private === true) throw new ReleaseGuardError("package.json must not be private");
  if (pkg.license !== "Apache-2.0") {
    throw new ReleaseGuardError(`package.json license must be Apache-2.0, got ${JSON.stringify(pkg.license)}`);
  }
  if (!String(pkg.repository?.url ?? "").includes(REPOSITORY_URL)) {
    throw new ReleaseGuardError(`package.json repository.url must point to ${REPOSITORY_URL}`);
  }
  if (pkg.publishConfig?.access !== "public") {
    throw new ReleaseGuardError("package.json publishConfig.access must be public");
  }
  if (pkg.publishConfig?.registry !== "https://registry.npmjs.org/") {
    throw new ReleaseGuardError("package.json publishConfig.registry must be https://registry.npmjs.org/");
  }
  if (pkg.engines?.node !== REQUIRED_NODE_RANGE) {
    throw new ReleaseGuardError(`package.json engines.node must be ${REQUIRED_NODE_RANGE}`);
  }
  for (const bin of ["nash", "nash-agents"]) {
    if (pkg.bin?.[bin] !== "./dist/index.js") {
      throw new ReleaseGuardError(`package.json bin.${bin} must be ./dist/index.js`);
    }
  }
}

async function fetchValidationRuns({ env, commit, fetchImpl }) {
  const token = requireValue(env.GITHUB_TOKEN, "GITHUB_TOKEN is required for the CI gate");
  const repository = requireValue(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY is required for the CI gate");
  if (repository !== REPOSITORY_SLUG) {
    throw new ReleaseGuardError(`release must run in ${REPOSITORY_SLUG}, got ${repository}`);
  }
  const api = requireValue(env.GITHUB_API_URL, "GITHUB_API_URL is required for the CI gate").replace(/\/+$/, "");
  const runs = [];
  for (let page = 1; page <= 10; page += 1) {
    const url = `${api}/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${commit}&per_page=100&page=${page}`;
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "nash-release-guard",
      },
    });
    if (!response.ok) {
      throw new ReleaseGuardError(`GitHub Actions API returned HTTP ${response.status} while reading Validation runs`);
    }
    const body = await response.json();
    const pageRuns = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
    runs.push(...pageRuns);
    if (pageRuns.length < 100 || runs.length >= (body.total_count ?? 0)) break;
  }
  return runs;
}

function requireSuccessfulRun(runs, { commit, event }) {
  const matching = runs
    .filter((run) => run.event === event && run.head_sha === commit)
    .sort((a, b) => b.id - a.id);
  if (matching.length === 0) {
    throw new ReleaseGuardError(
      `no Validation run with event=${event} exists for ${commit}; ` +
      `wait for the push run and start a workflow_dispatch Validation run on ${RELEASE_BRANCH} for this exact commit`,
    );
  }
  const run = matching[0];
  if (run.status !== "completed") {
    throw new ReleaseGuardError(
      `latest Validation run (${event}) for ${commit} is still ${run.status}; wait for it to finish and rerun this workflow`,
    );
  }
  if (run.conclusion !== "success") {
    throw new ReleaseGuardError(
      `latest Validation run (${event}) for ${commit} concluded ${run.conclusion}: ${run.html_url}`,
    );
  }
  if (run.head_branch !== RELEASE_BRANCH) {
    throw new ReleaseGuardError(
      `latest successful Validation run (${event}) for ${commit} ran on ${JSON.stringify(run.head_branch)}, not ${RELEASE_BRANCH}`,
    );
  }
  return {
    event,
    id: run.id,
    attempt: run.run_attempt,
    conclusion: run.conclusion,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    url: run.html_url,
    createdAt: run.created_at,
  };
}

export async function verifyReleaseSource({
  root = process.cwd(),
  expectedVersion = "0.1.0",
  expectedTag = `v${expectedVersion}`,
  requireCi = false,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const packagePath = path.join(root, "package.json");
  if (!fs.existsSync(packagePath)) throw new ReleaseGuardError("package.json not found");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  assertPackageMetadata(pkg, expectedVersion);

  const head = git(root, "rev-parse", "--verify", "HEAD");
  if (!/^[a-f0-9]{40}$/.test(head)) throw new ReleaseGuardError(`HEAD is not a full commit SHA: ${head}`);

  let tagType;
  try {
    tagType = git(root, "cat-file", "-t", `refs/tags/${expectedTag}`);
  } catch {
    throw new ReleaseGuardError(`tag ${expectedTag} does not exist`);
  }
  if (tagType !== "commit") {
    throw new ReleaseGuardError(
      `tag ${expectedTag} must be a lightweight tag (git cat-file -t returned ${tagType}); ` +
      "annotated tags make GITHUB_SHA and npm provenance record the tag object instead of the commit",
    );
  }
  const tagCommit = git(root, "rev-parse", "--verify", `refs/tags/${expectedTag}`);
  if (!/^[a-f0-9]{40}$/.test(tagCommit)) throw new ReleaseGuardError(`tag ${expectedTag} does not resolve to a commit`);
  if (tagCommit !== head) {
    throw new ReleaseGuardError(`tag ${expectedTag} points to ${tagCommit}, but the checkout/build commit is ${head}`);
  }

  const worktree = git(root, "status", "--porcelain", "--untracked-files=all");
  if (worktree) throw new ReleaseGuardError(`release worktree is not clean:\n${worktree}`);

  if (env.GITHUB_ACTIONS === "true") {
    if (env.GITHUB_REF_TYPE !== "tag") {
      throw new ReleaseGuardError(`release workflow must run from a tag ref, got ${JSON.stringify(env.GITHUB_REF_TYPE)}`);
    }
    if (env.GITHUB_REF !== `refs/tags/${expectedTag}`) {
      throw new ReleaseGuardError(`release workflow ref must be refs/tags/${expectedTag}, got ${env.GITHUB_REF}`);
    }
    if (env.GITHUB_SHA !== head) {
      throw new ReleaseGuardError(
        `GITHUB_SHA ${env.GITHUB_SHA} differs from the tagged commit ${head}; use a lightweight tag`,
      );
    }
    try {
      git(root, "fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${RELEASE_BRANCH}:refs/remotes/origin/${RELEASE_BRANCH}`);
    } catch (error) {
      throw new ReleaseGuardError(`could not fetch origin/${RELEASE_BRANCH}: ${error.message}`);
    }
    try {
      git(root, "merge-base", "--is-ancestor", head, `refs/remotes/origin/${RELEASE_BRANCH}`);
    } catch {
      throw new ReleaseGuardError(`${head} is not reachable from origin/${RELEASE_BRANCH}`);
    }
  }

  let ci = null;
  if (requireCi) {
    const runs = await fetchValidationRuns({ env, commit: head, fetchImpl });
    ci = {
      push: requireSuccessfulRun(runs, { commit: head, event: "push" }),
      workflow_dispatch: requireSuccessfulRun(runs, { commit: head, event: "workflow_dispatch" }),
    };
  }

  return {
    status: "PASSED",
    package: pkg.name,
    version: expectedVersion,
    tag: expectedTag,
    tagType,
    commit: head,
    worktreeClean: true,
    ci,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expectedVersion = process.env.EXPECTED_VERSION ?? "0.1.0";
  const expectedTag = process.env.EXPECTED_TAG ?? `v${expectedVersion}`;
  try {
    const result = await verifyReleaseSource({
      expectedVersion,
      expectedTag,
      requireCi: process.argv.includes("--require-ci"),
    });
    console.log(JSON.stringify(result, null, 2));
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, [
        `commit=${result.commit}`,
        `tag=${result.tag}`,
        `version=${result.version}`,
        `push_run_url=${result.ci?.push?.url ?? ""}`,
        `dispatch_run_url=${result.ci?.workflow_dispatch?.url ?? ""}`,
      ].join("\n") + "\n");
    }
  } catch (error) {
    console.error(`RELEASE-GUARD FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
