import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildDriftguardPRBody,
  buildPRBranchName,
  buildPRTitle,
  buildTriggerSummary,
  createDriftguardPR,
  PRCreationFallbackError,
} from '../github/prCreator.js';
import type { DiffResult, FlaggedStatement, Proposal } from '../types.js';
import type { DriftguardConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { findRepoRoot } from '../utils/repo.js';

export interface LocalSuggestionOptions {
  confidence?: number;
  flaggedLines?: number;
  hookMode?: boolean;
  repoRoot?: string;
  suppressSummary?: boolean;
}

export interface CreatePROptions extends LocalSuggestionOptions {
  config: DriftguardConfig;
  diff: DiffResult;
  flaggedStatements: FlaggedStatement[];
}

export async function writeLocalSuggestion(
  contextFilePath: string,
  proposal: Proposal,
  options: LocalSuggestionOptions = {},
): Promise<void> {
  if (!proposal.unifiedDiff.trim()) {
    return;
  }

  const originalContent = readFileSync(contextFilePath, 'utf8');
  const suggestedContent = applyUnifiedDiff(originalContent, proposal.unifiedDiff);
  const suggestionPath = `${contextFilePath}.suggested`;

  writeFileSync(suggestionPath, suggestedContent);
  ensureGitignoreEntry(
    options.repoRoot ?? findRepoRoot(path.dirname(contextFilePath)) ?? process.cwd(),
    path.basename(suggestionPath),
  );

  if (!options.hookMode && !options.suppressSummary) {
    printLocalSummary(contextFilePath, suggestionPath, proposal, options);
  }
}

export async function createPR(
  contextFilePath: string,
  proposal: Proposal,
  options: CreatePROptions,
): Promise<void> {
  if (!proposal.unifiedDiff.trim()) {
    return;
  }

  const repoRoot = options.repoRoot ?? findRepoRoot(path.dirname(contextFilePath)) ?? process.cwd();
  const originalContent = readFileSync(contextFilePath, 'utf8');
  const proposedContent = applyUnifiedDiff(originalContent, proposal.unifiedDiff);
  const trigger = buildTriggerSummary(options.diff.commitMessage);
  const title = buildPRTitle(
    options.config.prMode.titleTemplate,
    path.basename(contextFilePath),
    trigger,
  );
  const branch = buildPRBranchName(options.diff.commitHash);
  const body = buildDriftguardPRBody({
    flaggedStatements: options.flaggedStatements,
    confidence: options.confidence ?? proposal.confidence,
    reasoning: proposal.reasoning,
  });

  try {
    const prUrl = await createDriftguardPR({
      title,
      body,
      branch,
      baseBranch: options.config.prMode.baseBranch,
      files: [{ path: contextFilePath, content: proposedContent }],
      repoRoot,
      commitMessage: `chore(driftguard): update ${path.basename(contextFilePath)} — ${trigger}`,
      labels: options.config.prMode.labels,
      assignees: options.config.prMode.assignees,
      reviewers: options.config.prMode.reviewers,
    });

    if (!options.hookMode) {
      logger.success(`✓ driftguard created PR: ${prUrl}`);
    }
  } catch (error) {
    if (error instanceof PRCreationFallbackError) {
      if (!options.hookMode) {
        logger.warn(error.message);
        if (error.compareUrl) {
          logger.info(`PR URL that would have been created: ${error.compareUrl}`);
        }
        logger.info('Writing local suggestion fallback instead.');
      }

      await writeLocalSuggestion(contextFilePath, proposal, options);
      return;
    }

    throw error;
  }
}

export function applyUnifiedDiff(originalContent: string, unifiedDiff: string): string {
  const originalLines = originalContent.split('\n');
  const outputLines: string[] = [];
  let originalIndex = 0;
  const diffLines = unifiedDiff.split('\n');

  for (let index = 0; index < diffLines.length; index += 1) {
    const line = diffLines[index] ?? '';
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);

    if (!hunk) {
      continue;
    }

    const oldStart = Number(hunk[1]) - 1;
    while (originalIndex < oldStart) {
      outputLines.push(originalLines[originalIndex] ?? '');
      originalIndex += 1;
    }

    index += 1;

    for (; index < diffLines.length; index += 1) {
      const hunkLine = diffLines[index] ?? '';

      if (hunkLine.startsWith('@@ ')) {
        index -= 1;
        break;
      }

      if (hunkLine.startsWith('\\ No newline')) {
        continue;
      }

      const prefix = hunkLine[0];
      const value = hunkLine.slice(1);

      if (prefix === ' ') {
        outputLines.push(originalLines[originalIndex] ?? value);
        originalIndex += 1;
      } else if (prefix === '-') {
        originalIndex += 1;
      } else if (prefix === '+') {
        outputLines.push(value);
      }
    }
  }

  while (originalIndex < originalLines.length) {
    outputLines.push(originalLines[originalIndex] ?? '');
    originalIndex += 1;
  }

  return originalContent.endsWith('\n') ? outputLines.join('\n') : trimTrailingSyntheticNewline(outputLines);
}

function trimTrailingSyntheticNewline(lines: string[]): string {
  if (lines.at(-1) === '') {
    return lines.slice(0, -1).join('\n');
  }

  return lines.join('\n');
}

function ensureGitignoreEntry(repoRoot: string, entry: string): void {
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const existingContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  const entries = new Set(existingContent.split(/\r?\n/).map((line) => line.trim()));

  if (entries.has(entry)) {
    return;
  }

  const separator = existingContent && !existingContent.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignorePath, `${existingContent}${separator}${entry}\n`);
}

function printLocalSummary(
  contextFilePath: string,
  suggestionPath: string,
  proposal: Proposal,
  options: LocalSuggestionOptions,
): void {
  const confidence = options.confidence ?? proposal.confidence;
  console.log(`✓ driftguard detected context drift

  Context file:  ${path.basename(contextFilePath)}
  Flagged lines: ${options.flaggedLines ?? 'unknown'}
  Confidence:    ${confidence.toFixed(2)}

  Suggestion written to: ${path.basename(suggestionPath)}

  Review with:   diff ${path.basename(contextFilePath)} ${path.basename(suggestionPath)}
  Apply with:    mv ${path.basename(suggestionPath)} ${path.basename(contextFilePath)}`);
}
