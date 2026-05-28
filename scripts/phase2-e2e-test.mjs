#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoUrl = process.argv[2] ?? 'https://github.com/prateekg7/throwaway-test.git';
const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
const cliPath = path.join(projectRoot, 'dist/index.cjs');
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!process.env.GROQ_API_KEY) {
  throw new Error('GROQ_API_KEY is required for the Phase 2 E2E test.');
}

if (!token) {
  throw new Error('GITHUB_TOKEN or GH_TOKEN is required for the Phase 2 E2E test.');
}

if (!existsSync(cliPath)) {
  throw new Error(`Built CLI not found at ${cliPath}. Run pnpm build first.`);
}

const workspace = mkdtempSync(path.join(tmpdir(), 'driftguard-phase2-e2e-'));
const repoDir = path.join(workspace, 'repo');
const askpassPath = path.join(workspace, 'git-askpass.sh');
const testId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const fixtureDir = `src/driftguard-e2e-${testId}`;
const fixtureFile = `${fixtureDir}/auth.ts`;
const contextLine = `- Driftguard E2E auth fixture lives in \`${fixtureFile}\`.`;

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

const env = {
  ...process.env,
  GIT_ASKPASS: askpassPath,
  GIT_TERMINAL_PROMPT: '0',
};

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoDir,
    env,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

function git(args, options = {}) {
  return run('git', args, options);
}

function appendContextLine() {
  const claudePath = path.join(repoDir, 'CLAUDE.md');
  const existing = existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : '# Agent Context\n';
  const separator = existing.endsWith('\n') ? '' : '\n';
  writeFileSync(
    claudePath,
    `${existing}${separator}\n## Driftguard Phase 2 E2E ${testId}\n${contextLine}\n`,
  );
}

git(['clone', repoUrl, repoDir], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
git(['config', 'user.email', 'driftguard-e2e@example.com']);
git(['config', 'user.name', 'driftguard e2e']);

const baseBranch = git(['branch', '--show-current']).trim() || 'main';
git(['checkout', '-B', baseBranch]);

mkdirSync(path.join(repoDir, fixtureDir), { recursive: true });
writeFileSync(
  path.join(repoDir, fixtureFile),
  'export function driftguardE2EAuthFixture() {\n  return true;\n}\n',
);
appendContextLine();
writeFileSync(
  path.join(repoDir, 'driftguard.config.json'),
  `${JSON.stringify(
    {
      contextFiles: ['CLAUDE.md'],
      confidenceThreshold: 0.65,
      ignorePaths: ['node_modules/**', 'dist/**', '*.lock', '*.snap', '*.generated.*'],
      ignoreCommitPatterns: ['^chore\\(driftguard\\):', '^Merge pull request'],
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
      groqBaseUrl: 'https://api.groq.com/openai/v1',
      maxTokensPerProposal: 500,
      prMode: {
        enabled: false,
        autoCreatePR: false,
        baseBranch,
        titleTemplate: 'chore(driftguard): update {filename} — {trigger}',
        labels: [],
        assignees: [],
        reviewers: [],
      },
      output: {
        mode: 'local',
        verbose: false,
        hookMode: false,
      },
    },
    null,
    2,
  )}\n`,
);

git(['add', 'CLAUDE.md', fixtureFile, 'driftguard.config.json']);
git(['commit', '-m', `test: add driftguard e2e fixture ${testId}`]);
git(['push', 'origin', baseBranch]);

rmSync(path.join(repoDir, fixtureFile));
git(['add', fixtureFile]);
git(['commit', '-m', `test: remove driftguard e2e fixture ${testId}`]);
git(['push', 'origin', baseBranch]);

const scanOutput = run('node', [cliPath, 'scan', '--pr', '--context', 'CLAUDE.md'], {
  cwd: repoDir,
});
const finalBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();

console.log(
  JSON.stringify(
    {
      workspace,
      repoDir,
      baseBranch,
      fixtureFile,
      finalBranch,
      scanOutput,
    },
    null,
    2,
  ),
);
