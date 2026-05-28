import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findContextFiles, parseContextFile } from '../src/core/contextParser.js';
import { detectDivergence } from '../src/core/divergenceDetector.js';
import type { DiffResult } from '../src/types.js';
import { extractTokens } from '../src/utils/tokenizer.js';

describe('contextParser', () => {
  it('extracts filepath, library, command, and pattern tokens from typical context markdown', () => {
    const contextFile = parseContextFile(
      path.join(process.cwd(), 'tests/fixtures/sample-claude-md/tech-stack.md'),
    );

    const authStatement = contextFile.statements.find((statement) =>
      statement.rawText.includes('Auth is handled'),
    );
    const testsStatement = contextFile.statements.find((statement) =>
      statement.rawText.includes('Tests live'),
    );
    const commandStatement = contextFile.statements.find((statement) =>
      statement.rawText.includes('Run pnpm test'),
    );

    expect(authStatement?.section).toBe('Tech Stack');
    expect(authStatement?.tokens).toEqual(
      expect.arrayContaining([
        { type: 'filepath', value: 'src/middleware/auth.ts', confidence: 0.95 },
        { type: 'library', value: 'jose', confidence: 0.75 },
      ]),
    );
    expect(testsStatement?.tokens).toEqual(
      expect.arrayContaining([
        { type: 'filepath', value: '__tests__/', confidence: 0.95 },
        { type: 'command', value: 'npm run test', confidence: 0.9 },
      ]),
    );
    expect(commandStatement?.section).toBe('Commands');
    expect(commandStatement?.tokens).toContainEqual({
      type: 'command',
      value: 'pnpm test',
      confidence: 0.9,
    });
  });

  it('handles driftguard-ignore comments on the statement immediately below', () => {
    const contextFile = parseContextFile(
      path.join(process.cwd(), 'tests/fixtures/sample-claude-md/tech-stack.md'),
    );

    const ignoredStatement = contextFile.statements.find((statement) =>
      statement.rawText.includes('Never import directly'),
    );
    const followingStatement = contextFile.statements.find((statement) =>
      statement.rawText.includes('Always use'),
    );

    expect(ignoredStatement?.suppressedByComment).toBe(true);
    expect(ignoredStatement?.tokens).toEqual(
      expect.arrayContaining([
        {
          type: 'pattern',
          value: 'Never import directly from `src/utils/legacy/` - use `src/adapters/legacyAdapter.ts`.',
          confidence: 0.6,
        },
      ]),
    );
    expect(followingStatement?.suppressedByComment).toBe(false);
    expect(followingStatement?.section).toBe('Conventions');
  });

  it('supports driftguard-ignore comments with reasons and detector suppression', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'driftguard-ignore-'));
    const contextPath = path.join(repoRoot, 'CLAUDE.md');
    writeFileSync(
      contextPath,
      [
        '## Architecture',
        '<!-- driftguard-ignore: this reference is intentionally abstract -->',
        '- Auth patterns live in `src/services/auth.ts`.',
        '- API calls use `src/lib/apiClient.ts`.',
        '',
      ].join('\n'),
    );

    const contextFile = parseContextFile(contextPath);
    expect(contextFile.statements).toMatchObject([
      {
        rawText: '- Auth patterns live in `src/services/auth.ts`.',
        suppressedByComment: true,
      },
      {
        rawText: '- API calls use `src/lib/apiClient.ts`.',
        suppressedByComment: false,
      },
    ]);

    const diff = makeDiff({
      changedFiles: ['src/services/auth.ts', 'src/lib/apiClient.ts'],
      deletedFiles: ['src/services/auth.ts', 'src/lib/apiClient.ts'],
    });
    const flagged = detectDivergence(contextFile, diff);

    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.statement.rawText).toBe('- API calls use `src/lib/apiClient.ts`.');
  });

  it('handles empty files and files with no references', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'driftguard-parser-'));
    const emptyPath = path.join(repoRoot, 'CLAUDE.md');
    const plainPath = path.join(repoRoot, 'AGENTS.md');
    writeFileSync(emptyPath, '');
    writeFileSync(plainPath, '## Notes\n\n- Prefer readable code.\n');

    expect(parseContextFile(emptyPath).statements).toEqual([]);
    expect(parseContextFile(plainPath).statements).toEqual([
      {
        lineNumber: 3,
        rawText: '- Prefer readable code.',
        tokens: [],
        section: 'Notes',
        suppressedByComment: false,
      },
    ]);
  });

  it('finds supported context files at the repository root', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'driftguard-find-'));
    writeFileSync(path.join(repoRoot, 'CLAUDE.md'), '# Claude\n');
    writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# Agents\n');
    writeFileSync(path.join(repoRoot, 'README.md'), '# Readme\n');

    expect(findContextFiles(repoRoot)).toEqual([
      path.join(repoRoot, 'CLAUDE.md'),
      path.join(repoRoot, 'AGENTS.md'),
    ]);
  });

  it('parses AGENTS.md fixtures independently from CLAUDE.md', () => {
    const contextFile = parseContextFile(
      path.join(process.cwd(), 'tests/fixtures/sample-claude-md/agents.md'),
    );

    expect(contextFile.path.endsWith('agents.md')).toBe(true);
    expect(contextFile.statements).toHaveLength(2);
    expect(contextFile.statements[0]).toMatchObject({
      section: 'Runtime',
      tokens: expect.arrayContaining([
        { type: 'filepath', value: 'src/jobs/scheduler.ts', confidence: 0.95 },
      ]),
    });
  });

  it('classifies package names without slash characters as libraries', () => {
    expect(extractTokens('Use `@anthropic-ai/sdk`, `jose`, and `react-dom`.')).toEqual([
      { type: 'library', value: '@anthropic-ai/sdk', confidence: 0.75 },
      { type: 'library', value: 'jose', confidence: 0.75 },
      { type: 'library', value: 'react-dom', confidence: 0.75 },
    ]);
  });
});

function makeDiff(overrides: Partial<DiffResult>): DiffResult {
  return {
    changedFiles: [],
    deletedFiles: [],
    renamedFiles: [],
    diffContent: '',
    commitHash: 'abc123',
    commitMessage: 'test',
    ...overrides,
  };
}
