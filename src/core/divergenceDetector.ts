import type { ContextFile, DiffResult, FlaggedStatement } from '../types.js';
import type { ContextToken, MatchedChange } from '../types.js';
import { defaultConfig } from '../utils/config.js';

export interface DivergenceOptions {
  confidenceThreshold?: number;
  ignorePaths?: string[];
}

export function detectDivergence(
  contextFile: ContextFile,
  diff: DiffResult,
  options: DivergenceOptions = {},
): FlaggedStatement[] {
  const confidenceThreshold = options.confidenceThreshold ?? defaultConfig.confidenceThreshold;
  const ignorePaths = [...defaultConfig.ignorePaths, ...(options.ignorePaths ?? [])];

  return contextFile.statements
    .filter((statement) => !statement.suppressedByComment)
    .map((statement) => {
      const matchedChanges = statement.tokens
        .filter((token) => token.type === 'filepath')
        .flatMap((token) => getMatchedChanges(token, diff, ignorePaths));
      const overallConfidence = Math.max(
        0,
        ...matchedChanges.map((change) => getChangeConfidence(change)),
      );

      return {
        statement,
        matchedChanges,
        overallConfidence,
      };
    })
    .filter(
      (flaggedStatement) =>
        flaggedStatement.matchedChanges.length > 0 &&
        flaggedStatement.overallConfidence >= confidenceThreshold,
    );
}

function getMatchedChanges(
  token: ContextToken,
  diff: DiffResult,
  ignorePaths: string[],
): MatchedChange[] {
  const matches: MatchedChange[] = [];

  for (const deletedFile of diff.deletedFiles) {
    if (shouldIgnorePath(deletedFile, ignorePaths) || !pathMatchesToken(deletedFile, token.value)) {
      continue;
    }

    matches.push({
      changedFilePath: deletedFile,
      matchedToken: token,
      changeType: 'deleted',
      evidence: getFileEvidence(diff.diffContent, deletedFile),
    });
  }

  for (const renamedFile of diff.renamedFiles) {
    if (
      shouldIgnorePath(renamedFile.from, ignorePaths) ||
      !pathMatchesToken(renamedFile.from, token.value)
    ) {
      continue;
    }

    matches.push({
      changedFilePath: renamedFile.to,
      matchedToken: token,
      changeType: 'renamed',
      evidence: getFileEvidence(diff.diffContent, renamedFile.from, renamedFile.to),
    });
  }

  for (const changedFile of diff.changedFiles) {
    if (
      diff.deletedFiles.includes(changedFile) ||
      diff.renamedFiles.some((rename) => rename.to === changedFile) ||
      shouldIgnorePath(changedFile, ignorePaths) ||
      !pathMatchesToken(changedFile, token.value)
    ) {
      continue;
    }

    const evidence = getFileEvidence(diff.diffContent, changedFile);
    if (!hasStructuralChange(evidence)) {
      continue;
    }

    matches.push({
      changedFilePath: changedFile,
      matchedToken: token,
      changeType: 'modified',
      evidence,
    });
  }

  return dedupeMatchedChanges(matches);
}

function getChangeConfidence(change: MatchedChange): number {
  if (change.changeType === 'deleted') {
    return change.matchedToken.confidence;
  }

  if (change.changeType === 'renamed' || change.changeType === 'moved') {
    return change.matchedToken.confidence * 0.95;
  }

  return change.matchedToken.confidence * (isHeavyModification(change.evidence) ? 0.8 : 0.5);
}

function pathMatchesToken(changedFilePath: string, tokenValue: string): boolean {
  const normalizedPath = normalizePath(changedFilePath);
  const normalizedToken = normalizePath(tokenValue);

  if (normalizedPath === normalizedToken) {
    return true;
  }

  return normalizedToken.endsWith('/') && normalizedPath.startsWith(normalizedToken);
}

function normalizePath(value: string): string {
  return value.replace(/^\.\//, '');
}

function shouldIgnorePath(filePath: string, ignorePaths: string[]): boolean {
  const normalizedPath = normalizePath(filePath);

  if (
    normalizedPath.startsWith('node_modules/') ||
    normalizedPath.startsWith('dist/') ||
    normalizedPath.startsWith('.git/') ||
    normalizedPath.includes('/fixtures/') ||
    normalizedPath.startsWith('fixtures/') ||
    isLockOrGeneratedFile(normalizedPath)
  ) {
    return true;
  }

  return ignorePaths.some((pattern) => globMatches(pattern, normalizedPath));
}

function isLockOrGeneratedFile(filePath: string): boolean {
  return (
    filePath.endsWith('.lock') ||
    filePath.endsWith('.snap') ||
    filePath.endsWith('.generated.ts') ||
    filePath.endsWith('.generated.js') ||
    filePath.endsWith('.generated.tsx') ||
    filePath.endsWith('.generated.jsx') ||
    ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'].includes(filePath)
  );
}

function globMatches(pattern: string, filePath: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  const regex = new RegExp(
    `^${normalizedPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')}$`,
  );

  return regex.test(filePath);
}

function getFileEvidence(diffContent: string, oldPath: string, newPath = oldPath): string {
  const chunks = diffContent.split(/^diff --git /m).filter(Boolean);

  for (const chunk of chunks) {
    const fullChunk = `diff --git ${chunk}`;
    const header = fullChunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const chunkOldPath = header?.[1];
    const chunkNewPath = header?.[2];

    if (chunkOldPath === oldPath || chunkNewPath === oldPath || chunkNewPath === newPath) {
      return trimEvidence(fullChunk);
    }
  }

  return `Changed path: ${oldPath}${newPath !== oldPath ? ` -> ${newPath}` : ''}`;
}

function trimEvidence(evidence: string): string {
  return evidence.split('\n').slice(0, 80).join('\n').trim();
}

function hasStructuralChange(evidence: string): boolean {
  return getChangedCodeLines(evidence).some((line) =>
    /^\s*(?:import|export|function|class|interface|type)\b/.test(line) ||
    /^\s*(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/.test(line) ||
    /\bfrom\s+['"][^'"]+['"]/.test(line),
  );
}

function isHeavyModification(evidence: string): boolean {
  const lines = evidence.split('\n');
  const changedLineCount = getChangedCodeLines(evidence).length;
  const contextLineCount = lines.filter((line) => line.startsWith(' ') && !line.startsWith(' ---')).length;

  return changedLineCount > 0 && changedLineCount / (changedLineCount + contextLineCount) > 0.5;
}

function getChangedCodeLines(evidence: string): string[] {
  return evidence
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !/^(?:\+\+\+|---)/.test(line))
    .map((line) => line.slice(1).trim());
}

function dedupeMatchedChanges(matches: MatchedChange[]): MatchedChange[] {
  const seen = new Set<string>();

  return matches.filter((match) => {
    const key = `${match.changeType}:${match.changedFilePath}:${match.matchedToken.value}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
