import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseContextFile } from '../src/core/contextParser.js';
import { detectDivergence } from '../src/core/divergenceDetector.js';
import type { DiffResult } from '../src/types.js';

describe('divergenceDetector', () => {
  it('flags a deleted file referenced by a context statement', () => {
    const flagged = detectDivergence(getTechStackContext(), makeDiff({
      changedFiles: ['src/middleware/auth.ts'],
      deletedFiles: ['src/middleware/auth.ts'],
      diffContent: [
        'diff --git a/src/middleware/auth.ts b/src/middleware/auth.ts',
        'deleted file mode 100644',
        '--- a/src/middleware/auth.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-import { jwtVerify } from "jose";',
        '-export function authenticate() {}',
      ].join('\n'),
    }));

    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.statement.rawText).toContain('Auth is handled');
    expect(flagged[0]?.overallConfidence).toBe(0.95);
    expect(flagged[0]?.matchedChanges[0]).toMatchObject({
      changedFilePath: 'src/middleware/auth.ts',
      changeType: 'deleted',
    });
  });

  it('flags a renamed file when the old path is referenced', () => {
    const flagged = detectDivergence(getTechStackContext(), makeDiff({
      changedFiles: ['src/lib/session.ts'],
      renamedFiles: [{ from: 'src/middleware/auth.ts', to: 'src/lib/session.ts' }],
      diffContent: [
        'diff --git a/src/middleware/auth.ts b/src/lib/session.ts',
        'similarity index 91%',
        'rename from src/middleware/auth.ts',
        'rename to src/lib/session.ts',
      ].join('\n'),
    }));

    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.overallConfidence).toBeCloseTo(0.9025);
    expect(flagged[0]?.matchedChanges[0]).toMatchObject({
      changedFilePath: 'src/lib/session.ts',
      changeType: 'renamed',
    });
  });

  it('does not flag internal changes when the referenced path is still valid', () => {
    const flagged = detectDivergence(getTechStackContext(), makeDiff({
      changedFiles: ['src/middleware/auth.ts'],
      diffContent: [
        'diff --git a/src/middleware/auth.ts b/src/middleware/auth.ts',
        '--- a/src/middleware/auth.ts',
        '+++ b/src/middleware/auth.ts',
        '@@ -10,7 +10,7 @@ function getRetries() {',
        '-  return 2;',
        '+  return 3;',
        ' }',
      ].join('\n'),
    }));

    expect(flagged).toEqual([]);
  });

  it('applies confidence threshold filtering', () => {
    const diff = makeDiff({
      changedFiles: ['src/lib/session.ts'],
      renamedFiles: [{ from: 'src/middleware/auth.ts', to: 'src/lib/session.ts' }],
      diffContent: [
        'diff --git a/src/middleware/auth.ts b/src/lib/session.ts',
        'rename from src/middleware/auth.ts',
        'rename to src/lib/session.ts',
      ].join('\n'),
    });

    expect(detectDivergence(getTechStackContext(), diff, { confidenceThreshold: 0.9 })).toHaveLength(1);
    expect(detectDivergence(getTechStackContext(), diff, { confidenceThreshold: 0.93 })).toEqual([]);
  });

  it('skips statements suppressed by driftguard-ignore', () => {
    const flagged = detectDivergence(getTechStackContext(), makeDiff({
      changedFiles: ['src/utils/legacy/index.ts'],
      deletedFiles: ['src/utils/legacy/index.ts'],
      diffContent: [
        'diff --git a/src/utils/legacy/index.ts b/src/utils/legacy/index.ts',
        'deleted file mode 100644',
        '--- a/src/utils/legacy/index.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-export const legacy = true;',
      ].join('\n'),
    }));

    expect(flagged).toEqual([]);
  });

  it('ignores fixture and lockfile changes', () => {
    const context = parseContextFile(
      path.join(process.cwd(), 'tests/fixtures/sample-claude-md/conventions.md'),
    );
    const flagged = detectDivergence(context, makeDiff({
      changedFiles: ['tests/fixtures/src/lib/apiClient.ts', 'pnpm-lock.yaml'],
      deletedFiles: ['tests/fixtures/src/lib/apiClient.ts'],
      diffContent: '',
    }));

    expect(flagged).toEqual([]);
  });
});

function getTechStackContext() {
  return parseContextFile(path.join(process.cwd(), 'tests/fixtures/sample-claude-md/tech-stack.md'));
}

function makeDiff(overrides: Partial<DiffResult>): DiffResult {
  return {
    changedFiles: [],
    deletedFiles: [],
    renamedFiles: [],
    diffContent: '',
    commitMessage: 'test commit',
    commitHash: 'abc123',
    ...overrides,
  };
}
