import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDriftguardPRBody,
  buildPRBranchName,
  buildPRTitle,
  buildTriggerSummary,
  parseGitHubRemote,
  resolveGitHubToken,
} from '../src/github/prCreator.js';
import type { FlaggedStatement } from '../src/types.js';

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ stdout: 'gh-token\n' }),
}));

describe('prCreator helpers', () => {
  const originalGithubToken = process.env.GITHUB_TOKEN;
  const originalGhToken = process.env.GH_TOKEN;

  afterEach(() => {
    process.env.GITHUB_TOKEN = originalGithubToken;
    process.env.GH_TOKEN = originalGhToken;
    vi.clearAllMocks();
  });

  it('builds the required driftguard branch name', () => {
    expect(buildPRBranchName('abcdef1234567890', new Date('2026-05-27T14:32:00'))).toBe(
      'driftguard/2026-05-27-1432-abcdef1',
    );
  });

  it('fills PR title template values', () => {
    expect(
      buildPRTitle(
        'chore(driftguard): update {filename} — {trigger}',
        'CLAUDE.md',
        'auth refactor detected',
      ),
    ).toBe('chore(driftguard): update CLAUDE.md — auth refactor detected');
  });

  it('builds the PR body with flagged statements table and confidence score', () => {
    const body = buildDriftguardPRBody({
      flaggedStatements: [makeFlaggedStatement()],
      confidence: 0.87,
      reasoning: 'Updated the stale auth middleware reference.',
    });

    expect(body).toContain('## 🔄 Context Drift Detected');
    expect(body).toContain('| src/middleware/auth.ts | deleted | Line 7: Auth uses `src/middleware/auth.ts` |');
    expect(body).toContain('### Confidence score: 0.87/1.0');
    expect(body).toContain('driftguard proposes — you decide');
  });

  it('parses GitHub SSH and HTTPS remotes', () => {
    expect(parseGitHubRemote('git@github.com:acme/driftguard.git')).toEqual({
      owner: 'acme',
      repo: 'driftguard',
    });
    expect(parseGitHubRemote('https://github.com/acme/driftguard.git')).toEqual({
      owner: 'acme',
      repo: 'driftguard',
    });
    expect(parseGitHubRemote('https://gitlab.com/acme/driftguard.git')).toBeUndefined();
  });

  it('resolves GitHub token from env before gh CLI', async () => {
    process.env.GITHUB_TOKEN = 'github-token';
    process.env.GH_TOKEN = 'gh-env-token';

    await expect(resolveGitHubToken()).resolves.toBe('github-token');
  });

  it('uses GH_TOKEN when GITHUB_TOKEN is not set', async () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = 'gh-env-token';

    await expect(resolveGitHubToken()).resolves.toBe('gh-env-token');
  });

  it('falls back to gh auth token', async () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;

    await expect(resolveGitHubToken()).resolves.toBe('gh-token');
  });

  it('summarizes trigger from the first commit message line', () => {
    expect(buildTriggerSummary('refactor auth\n\nMore details')).toBe('refactor auth');
    expect(buildTriggerSummary('')).toBe('context drift detected');
  });
});

function makeFlaggedStatement(): FlaggedStatement {
  return {
    statement: {
      lineNumber: 7,
      rawText: 'Auth uses `src/middleware/auth.ts`',
      section: 'Tech Stack',
      suppressedByComment: false,
      tokens: [
        {
          type: 'filepath',
          value: 'src/middleware/auth.ts',
          confidence: 0.95,
        },
      ],
    },
    matchedChanges: [
      {
        changedFilePath: 'src/middleware/auth.ts',
        matchedToken: {
          type: 'filepath',
          value: 'src/middleware/auth.ts',
          confidence: 0.95,
        },
        changeType: 'deleted',
        evidence: 'diff --git a/src/middleware/auth.ts b/src/middleware/auth.ts',
      },
    ],
    overallConfidence: 0.87,
  };
}
