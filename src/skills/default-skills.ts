import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { formatSkillMarkdown } from "./frontmatter.js";

export interface DefaultSkillDefinition {
  name: string;
  description: string;
  whenToUse: string;
  procedure: string;
  verification: string;
  references?: Record<string, string>;
}

export const DEFAULT_BUILTIN_SKILLS: DefaultSkillDefinition[] = [
  {
    name: "code-review",
    description: "Review recent code changes, Git diff, or uncommitted files for bugs, security vulnerabilities, edge cases, and code quality.",
    whenToUse: "Use when asked to review code, check git diff, inspect recent commits, evaluate PR changes, analyze bugs, or audit code quality and defensive security.",
    procedure: `1. Identify code changes:
   - Run \`git status --short\` to identify modified, added, or untracked files.
   - Run \`git diff\` (or \`git diff --cached\` / \`git diff HEAD~1\`) to inspect exact diffs.
2. Read affected files:
   - Use \`read_file\` to read modified files and inspect surrounding context.
   - Trace callers and callees when modifying function signatures or contracts.
3. Check code quality and correctness:
   - Look for off-by-one errors, null/undefined exceptions, unhandled Promise rejections.
   - Verify asynchronous flow, race conditions, and error recovery.
4. Audit defensive security:
   - Ensure fail-closed invariants: no silent fallback on failure.
   - Verify input validation and boundaries (prevent path traversal, injection, shell escapes).
   - Check credential and API key hygiene: no sensitive secrets committed or logged.
5. Check performance and resource lifecycle:
   - Check for memory leaks, unbounded timers/intervals, or hanging child processes.
   - Verify teardown and cleanup routines.
6. Provide structured feedback:
   - Categorize issues by severity: Critical, High, Medium, Low.
   - Reference exact \`file_path:line_number\` for each finding with actionable fixes.`,
    verification: `1. Ensure all findings cite exact file paths and line numbers with concrete failure scenarios.
2. Verify that suggested fixes pass project type checking (\`npm run typecheck\` or equivalent).
3. Verify that existing automated test suites pass without regression.`,
    references: {
      "review-checklist.md": `# Code Review Checklist

### 1. Correctness & Robustness
- [ ] Boundary conditions and empty/null/undefined handling
- [ ] Concurrency and async safety (no race conditions, locks properly released)
- [ ] Idempotent operations where state transitions occur

### 2. Security (Fail-Closed)
- [ ] Strict input validation and path traversal defenses
- [ ] No credential or secret leaks in logs, tests, or code
- [ ] Fail-closed guarantees on auth, sandbox, or permission checks

### 3. Maintainability & Performance
- [ ] Resource cleanup (streams, timers, sockets, child processes closed)
- [ ] Clean type annotations with zero TypeScript errors
- [ ] Test coverage for new or modified functionality`,
    },
  },
  {
    name: "git-commit",
    description: "Analyze git diff, stage relevant files, and author clear, conventional commit messages without AI co-author watermarks.",
    whenToUse: "Use when asked to commit changes, write commit messages, review staged diffs before committing, or structure git commits.",
    procedure: `1. Inspect working tree status:
   - Run \`git status --short\` to identify modified, untracked, and deleted files.
   - Run \`git diff\` and \`git diff --staged\` to understand the exact logical change set.
2. Verify clean commit hygiene:
   - Ensure temporary logs, test dumps, and credentials (.env, keys) are excluded.
   - Verify code compiles and passes relevant checks before committing.
3. Formulate Conventional Commit message:
   - Format: \`<type>(<scope>): <concise imperative summary>\`
   - Common types: feat, fix, refactor, perf, test, docs, chore.
   - Provide an optional concise bullet list explaining rationale if change is non-trivial.
4. Strict Git contributor purity invariant:
   - NEVER add AI attribution watermarks (for example Co-authored-by trailers).
   - Author and committer must strictly remain the local user account.
5. Stage and execute commit:
   - Run \`git add <files>\` on intended files.
   - Run \`git commit -m "<message>"\`.`,
    verification: `1. Run \`git log -1\` to confirm commit message structure and author purity.
2. Run \`git status\` to ensure working tree reflects expected clean state.`,
    references: {
      "commit-conventions.md": `# Conventional Commits Reference

### Format
\`\`\`
<type>(<optional scope>): <description>

[optional body]
\`\`\`

### Types
- feat: A new feature
- fix: A bug fix
- refactor: Code change that neither fixes a bug nor adds a feature
- perf: A code change that improves performance
- test: Adding missing tests or correcting existing tests
- docs: Documentation only changes
- chore: Tooling, dependency, or configuration updates

### Hard Rules
1. Imperative mood in summary line (e.g., "add feature", not "added feature").
2. No AI authorship signatures or Co-authored-by trailers.`,
    },
  },
  {
    name: "test-runner",
    description: "Execute automated test suites, capture failure traces, isolate flaky tests, and diagnose regression root causes.",
    whenToUse: "Use when asked to run tests, verify test passes, debug failing test cases, check regression status, or measure test coverage.",
    procedure: `1. Discover test runner environment:
   - Detect runner config (package.json scripts, vitest, pytest, cargo test, etc.).
   - Identify test commands and targeted execution parameters.
2. Execute tests and stream output:
   - Run targeted test suite first to isolate suspected failures.
   - If targeted pass, run full test suite to guarantee zero regression.
3. Capture failure diagnostics:
   - Extract assertion error messages, stack traces, and exact file paths with line numbers.
   - Inspect test setup, teardown hooks, and shared fixture state.
4. Debug and root cause analysis:
   - Determine if failure is a logic bug, timing/concurrency race, or test environment pollution.
   - Use read_file to inspect both test and implementation sources.
5. Verify fix and clean state:
   - Re-run failing tests until 100% green.
   - Ensure test teardown cleaned all temporary files, locks, and child processes.`,
    verification: `1. Confirm all test suites pass with Exit Code 0.
2. Confirm zero lingering child processes or temporary test artifacts in the workspace.`,
    references: {
      "testing-best-practices.md": `# Test Runner & Teardown Best Practices

### Key Invariants
1. Test Isolation: Every test must create its own temporary sandbox/fixtures and clean them up upon exit.
2. Teardown Hooks: Use afterEach/finally blocks to ensure cleanup runs even when assertions fail.
3. Zero Unhandled Rejections: Ensure all asynchronous promises are awaited or caught to prevent node warnings.`,
    },
  },
];

/**
 * 确保全局 Skills 目录已预置默认内置技能 (如 code-review)
 */
export async function ensureDefaultSkills(globalSkillsDir: string): Promise<string[]> {
  const installed: string[] = [];

  try {
    if (!fsSync.existsSync(globalSkillsDir)) {
      await fs.mkdir(globalSkillsDir, { recursive: true });
    }

    for (const skill of DEFAULT_BUILTIN_SKILLS) {
      const skillDir = path.join(globalSkillsDir, skill.name);
      const skillMdPath = path.join(skillDir, "SKILL.md");

      if (!fsSync.existsSync(skillMdPath)) {
        await fs.mkdir(skillDir, { recursive: true });

        const content = formatSkillMarkdown({
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse,
          procedure: skill.procedure,
          verification: skill.verification,
        });

        await fs.writeFile(skillMdPath, content, "utf-8");

        if (skill.references) {
          const refDir = path.join(skillDir, "references");
          await fs.mkdir(refDir, { recursive: true });
          for (const [refName, refContent] of Object.entries(skill.references)) {
            await fs.writeFile(path.join(refDir, refName), refContent, "utf-8");
          }
        }

        installed.push(skill.name);
      }
    }
  } catch {
    // 写入失败时不阻断主流程
  }

  return installed;
}
