import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildDriftguardPRBody,
  buildPRBranchName,
  buildPRTitle,
  buildTriggerSummary,
  createDriftguardPR,
} from '../src/github/prCreator.js';
import type { FlaggedStatement } from '../src/types.js';

const repoDir = process.argv[2];
const fixtureFile = process.argv[3];

if (!repoDir || !fixtureFile) {
  throw new Error('Usage: phase2-synthetic-pr-test.ts <repo-dir> <fixture-file>');
}

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token) {
  throw new Error('GITHUB_TOKEN or GH_TOKEN is required.');
}

const askpassPath = path.join(repoDir, '.git', 'driftguard-askpass.sh');
writeFileSync(
  askpassPath,
  `#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *) echo "\${GITHUB_TOKEN:-$GH_TOKEN}" ;;
esac
`,
  { mode: 0o700 },
);

process.env.GIT_ASKPASS = askpassPath;
process.env.GIT_TERMINAL_PROMPT = '0';

const contextPath = path.join(repoDir, 'CLAUDE.md');
const originalContent = await readFile(contextPath, 'utf8');
const staleLine = `- Driftguard E2E auth fixture lives in \`${fixtureFile}\`.`;
const proposedContent = originalContent.replace(
  staleLine,
  `- Driftguard E2E auth fixture \`${fixtureFile}\` was removed during Phase 2 PR testing.`,
);

if (proposedContent === originalContent) {
  throw new Error(`Could not find stale context line for ${fixtureFile}.`);
}

const flaggedStatement: FlaggedStatement = {
  statement: {
    lineNumber: originalContent.split('\n').findIndex((line) => line === staleLine) + 1,
    rawText: staleLine,
    section: 'Driftguard Phase 2 E2E',
    suppressedByComment: false,
    tokens: [{ type: 'filepath', value: fixtureFile, confidence: 0.95 }],
  },
  matchedChanges: [
    {
      changedFilePath: fixtureFile,
      matchedToken: { type: 'filepath', value: fixtureFile, confidence: 0.95 },
      changeType: 'deleted',
      evidence: `diff --git a/${fixtureFile} b/${fixtureFile}`,
    },
  ],
  overallConfidence: 0.95,
};

const commitHash = await runGit(repoDir, ['rev-parse', 'HEAD']);
const commitMessage = await runGit(repoDir, ['log', '-1', '--pretty=%B']);
const baseBranch = await runGit(repoDir, ['branch', '--show-current']);
const trigger = buildTriggerSummary(commitMessage);
const branch = buildPRBranchName(commitHash);
const title = buildPRTitle(
  'chore(driftguard): update {filename} — {trigger}',
  'CLAUDE.md',
  trigger,
);
const body = buildDriftguardPRBody({
  flaggedStatements: [flaggedStatement],
  confidence: 0.95,
  reasoning: 'Synthetic Phase 2 smoke test proposal after Anthropic rejected the live API call.',
});

const prUrl = await createDriftguardPR({
  title,
  body,
  branch,
  baseBranch,
  files: [{ path: contextPath, content: proposedContent }],
  repoRoot: repoDir,
  commitMessage: `chore(driftguard): update CLAUDE.md — ${trigger}`,
  labels: [],
  assignees: [],
  reviewers: [],
});

const finalBranch = await runGit(repoDir, ['branch', '--show-current']);
console.log(JSON.stringify({ prUrl, branch, baseBranch, finalBranch }, null, 2));

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { execa } = await import('execa');
  const { stdout } = await execa('git', args, { cwd });
  return stdout.trim();
}
