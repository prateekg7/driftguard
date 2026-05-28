import path from 'node:path';
import { Command } from 'commander';
import { findContextFiles, parseContextFile } from '../core/contextParser.js';
import { detectDivergence } from '../core/divergenceDetector.js';
import { getDiffFromLastCommit, getDiffFromRange } from '../core/gitDiff.js';
import { createPR, writeLocalSuggestion } from '../core/outputHandler.js';
import { generateProposal } from '../core/proposalGenerator.js';
import {
  buildPRBranchName,
  buildPRTitle,
  buildTriggerSummary,
} from '../github/prCreator.js';
import type { ContextFile, DiffResult, FlaggedStatement } from '../types.js';
import { type DriftguardConfig, loadConfig } from '../utils/config.js';
import { colorUnifiedDiff } from '../utils/diffColor.js';
import { writeLastScan } from '../utils/lastScan.js';
import { logger } from '../utils/logger.js';
import { findRepoRoot } from '../utils/repo.js';

export function scanCommand(): Command {
  return new Command('scan')
    .description('Scan the last commit for context drift.')
    .option('--hook-mode', 'suppress interactive output for git hooks')
    .option('--from <hash>', 'commit/range start')
    .option('--to <hash>', 'commit/range end')
    .option('--context <path>', 'context file path')
    .option('--threshold <n>', 'confidence threshold')
    .option('--dry-run', 'show what would happen without side effects')
    .option('--pr', 'create a GitHub PR with the proposed update')
    .option('--verbose', 'show parser and detector details')
    .action(async (options) => {
      const hookMode = Boolean(options.hookMode);

      try {
        const repoRoot = findRepoRoot();
        if (!repoRoot) {
          if (!hookMode) {
            logger.warn('driftguard scan skipped: no git repository found.');
          }
          return;
        }

        process.chdir(repoRoot);
        const config = loadConfig(repoRoot);
        const threshold = parseThreshold(options.threshold, config.confidenceThreshold);
        const contextPaths = getContextPaths(repoRoot, config.contextFiles, options.context);

        if (contextPaths.length === 0) {
          if (!hookMode) {
            logger.info('driftguard scan skipped: no CLAUDE.md or AGENTS.md found.');
          }
          return;
        }

        const diff = await getRequestedDiff(options);

        if (shouldIgnoreCommit(diff.commitMessage, config.ignoreCommitPatterns)) {
          return;
        }

        if (diff.changedFiles.length === 0) {
          return;
        }

        const scanResults = contextPaths.map((contextPath) => {
          const contextFile = parseContextFile(contextPath);
          const flaggedStatements = detectDivergence(contextFile, diff, {
            confidenceThreshold: threshold,
            ignorePaths: config.ignorePaths,
          });
          return { contextFile, flaggedStatements };
        });

        if (options.verbose && !hookMode) {
          printVerboseResults(scanResults, diff);
        }

        const totalFlagged = scanResults.reduce(
          (count, result) => count + result.flaggedStatements.length,
          0,
        );

        if (totalFlagged === 0) {
          writeLastScan(repoRoot, 0);
          if (!hookMode) {
            printScanSummary(
              scanResults.map((result) => ({
                contextFile: result.contextFile,
                flaggedCount: 0,
                status: 'no-changes',
              })),
            );
          }
          return;
        }

        const prMode = shouldUsePRMode(options, config);

        if (options.dryRun) {
          await printDryRun(scanResults, diff, config, prMode);
          return;
        }

        const summaries: ScanSummary[] = scanResults.map((result) => ({
          contextFile: result.contextFile,
          flaggedCount: result.flaggedStatements.length,
          status: result.flaggedStatements.length > 0 ? 'no-proposal' : 'no-changes',
        }));

        for (const result of scanResults.filter((item) => item.flaggedStatements.length > 0)) {
          const proposal = await generateProposal(
            result.contextFile,
            result.flaggedStatements,
            diff,
            {
              maxTokens: config.maxTokensPerProposal,
              model: config.model,
              groqBaseUrl: config.groqBaseUrl,
              ollamaBaseUrl: config.ollamaBaseUrl,
              provider: config.provider,
            },
          );

          if (!proposal.unifiedDiff.trim()) {
            if (!hookMode) {
              logger.warn(proposal.reasoning);
            }
            markSummary(summaries, result.contextFile.path, 'no-proposal');
            continue;
          }

          if (prMode) {
            await createPR(result.contextFile.path, proposal, {
              config,
              diff,
              flaggedStatements: result.flaggedStatements,
              confidence: proposal.confidence,
              flaggedLines: result.flaggedStatements.length,
              hookMode,
              repoRoot,
            });
            markSummary(summaries, result.contextFile.path, 'pr-created');
            continue;
          }

          await writeLocalSuggestion(result.contextFile.path, proposal, {
            confidence: proposal.confidence,
            flaggedLines: result.flaggedStatements.length,
            hookMode,
            repoRoot,
            suppressSummary: true,
          });
          markSummary(summaries, result.contextFile.path, 'suggested');
        }

        if (!hookMode && !prMode) {
          printScanSummary(summaries);
        }

        writeLastScan(repoRoot, totalFlagged);
      } catch (error) {
        if (!hookMode) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`driftguard scan skipped: ${message}`);
        }
      }
    });
}

interface ScanOptions {
  context?: string;
  dryRun?: boolean;
  from?: string;
  hookMode?: boolean;
  pr?: boolean;
  threshold?: string;
  to?: string;
  verbose?: boolean;
}

interface ScanResult {
  contextFile: ContextFile;
  flaggedStatements: FlaggedStatement[];
}

interface ScanSummary {
  contextFile: ContextFile;
  flaggedCount: number;
  status: 'suggested' | 'no-changes' | 'no-proposal' | 'pr-created';
}

function parseThreshold(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getContextPaths(repoRoot: string, configuredFiles: string[], contextPath?: string): string[] {
  if (contextPath) {
    return [path.resolve(repoRoot, contextPath)];
  }

  return findContextFiles(repoRoot, configuredFiles);
}

async function getRequestedDiff(options: ScanOptions): Promise<DiffResult> {
  if (options.from || options.to) {
    return getDiffFromRange(options.from ?? 'HEAD~1', options.to ?? 'HEAD');
  }

  return getDiffFromLastCommit();
}

function shouldIgnoreCommit(commitMessage: string, ignorePatterns: string[]): boolean {
  return ignorePatterns.some((pattern) => new RegExp(pattern).test(commitMessage));
}

function shouldUsePRMode(options: ScanOptions, config: DriftguardConfig): boolean {
  if (options.pr) {
    return true;
  }

  if (options.hookMode && !config.prMode.autoCreatePR) {
    return false;
  }

  return config.prMode.enabled || config.output.mode === 'pr';
}

function printVerboseResults(scanResults: ScanResult[], diff: DiffResult): void {
  logger.info(`Changed files: ${diff.changedFiles.join(', ') || 'none'}`);

  for (const result of scanResults) {
    logger.info('');
    logger.info(`${path.basename(result.contextFile.path)}:`);
    logger.info(`  Statements parsed: ${result.contextFile.statements.length}`);
    logger.info(`  Flagged statements: ${result.flaggedStatements.length}`);

    for (const flagged of result.flaggedStatements) {
      logger.info(
        `  - Line ${flagged.statement.lineNumber} (${flagged.overallConfidence.toFixed(2)}): ${flagged.statement.rawText}`,
      );
    }
  }
}

function markSummary(
  summaries: ScanSummary[],
  contextFilePath: string,
  status: ScanSummary['status'],
): void {
  const summary = summaries.find((item) => item.contextFile.path === contextFilePath);
  if (summary) {
    summary.status = status;
  }
}

function printScanSummary(summaries: ScanSummary[]): void {
  logger.success('✓ driftguard scan complete');
  logger.info('');

  for (const summary of summaries) {
    const fileName = path.basename(summary.contextFile.path).padEnd(13, ' ');
    logger.info(`  ${fileName} — ${formatScanSummary(summary)}`);
  }
}

function formatScanSummary(summary: ScanSummary): string {
  if (summary.status === 'no-changes') {
    return '0 statements flagged → no changes needed';
  }

  if (summary.status === 'suggested') {
    return `${summary.flaggedCount} statements flagged → ${path.basename(
      summary.contextFile.path,
    )}.suggested written`;
  }

  if (summary.status === 'pr-created') {
    return `${summary.flaggedCount} statements flagged → PR created`;
  }

  return `${summary.flaggedCount} statements flagged → no proposal generated`;
}

async function printDryRun(
  scanResults: ScanResult[],
  diff: DiffResult,
  config: DriftguardConfig,
  prMode: boolean,
): Promise<void> {
  if (prMode) {
    await printPRDryRun(scanResults, diff, config);
    return;
  }

  logger.info('DRY RUN - no files were written and no API call was made.');

  for (const result of scanResults) {
    logger.info('');
    logger.info(`${path.basename(result.contextFile.path)}:`);

    if (result.flaggedStatements.length === 0) {
      logger.info('  No statements flagged.');
      continue;
    }

    for (const flagged of result.flaggedStatements) {
      logger.info(
        `  - Line ${flagged.statement.lineNumber} (${flagged.overallConfidence.toFixed(2)}): ${flagged.statement.rawText}`,
      );
    }
  }
}

async function printPRDryRun(
  scanResults: ScanResult[],
  diff: DiffResult,
  config: DriftguardConfig,
): Promise<void> {
  const flaggedResults = scanResults.filter((result) => result.flaggedStatements.length > 0);
  const trigger = buildTriggerSummary(diff.commitMessage);
  const branch = buildPRBranchName(diff.commitHash);

  for (const result of flaggedResults) {
    const title = buildPRTitle(
      config.prMode.titleTemplate,
      path.basename(result.contextFile.path),
      trigger,
    );
    const relevantDiff = getRelevantEvidence(result.flaggedStatements) || diff.diffContent;
    const coloredDiff = await colorUnifiedDiff(relevantDiff);

    logger.info(`DRY RUN - the following PR would be created:

  Title:    ${title}
  Branch:   ${branch}
  Base:     ${config.prMode.baseBranch}

  Diff:
${indent(coloredDiff, 2)}

  No files were written. No PR was created. No API call was made.`);
  }
}

function getRelevantEvidence(flaggedStatements: FlaggedStatement[]): string {
  return [
    ...new Set(
      flaggedStatements.flatMap((flagged) =>
        flagged.matchedChanges.map((change) => change.evidence.trim()).filter(Boolean),
      ),
    ),
  ].join('\n\n');
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
