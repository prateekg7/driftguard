import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { findContextFiles, parseContextFile } from '../core/contextParser.js';
import { loadConfig } from '../utils/config.js';
import { readLastScan } from '../utils/lastScan.js';
import { logger } from '../utils/logger.js';
import { findRepoRoot, getGitPath } from '../utils/repo.js';

export function statusCommand(): Command {
  return new Command('status')
    .description('Show driftguard configuration and provider health.')
    .action(async () => {
      const repoRoot = findRepoRoot();

      if (!repoRoot) {
        logger.warn('driftguard status skipped: no git repository found.');
        return;
      }

      const config = loadConfig(repoRoot);
      const configPath = path.join(repoRoot, 'driftguard.config.json');
      const contextFiles = findContextFiles(repoRoot, config.contextFiles);
      const hookPath = await getGitPath(repoRoot, 'hooks/post-commit');
      const lastScan = readLastScan(repoRoot);

      logger.info('driftguard v1.0.0');
      logger.info('');
      logger.info('Context files:');

      if (contextFiles.length === 0) {
        logger.info('  ! none found');
      }

      for (const contextPath of contextFiles) {
        const rawContent = existsSync(contextPath) ? readFileSync(contextPath, 'utf8') : '';
        const parsed = parseContextFile(contextPath);
        const filepathTokenCount = parsed.statements.reduce(
          (count, statement) =>
            count + statement.tokens.filter((token) => token.type === 'filepath').length,
          0,
        );
        logger.info(
          `  ✓ ${path.basename(contextPath).padEnd(13, ' ')} (found, ${countLines(
            rawContent,
          )} lines, ${parsed.statements.length} statements parsed, ${filepathTokenCount} filepath tokens)`,
        );
      }

      logger.info('');
      logger.info('Git hook:');
      logger.info(
        existsSync(hookPath)
          ? `  ✓ Installed at ${path.relative(repoRoot, hookPath)}`
          : `  ! Not installed at ${path.relative(repoRoot, hookPath)}`,
      );

      logger.info('');
      logger.info('Configuration:');
      logger.info(
        existsSync(configPath)
          ? '  ✓ driftguard.config.json found'
          : '  ! driftguard.config.json not found, using defaults',
      );
      logger.info(`    provider: ${config.provider}`);
      logger.info(`    model: ${config.model}`);
      logger.info(`    confidenceThreshold: ${config.confidenceThreshold}`);
      logger.info(`    autoCreatePR: ${config.prMode.autoCreatePR}`);

      if (config.provider === 'ollama') {
        logger.info(`    ollamaBaseUrl: ${config.ollamaBaseUrl}`);
      }

      if (config.provider === 'groq') {
        logger.info(`    groqBaseUrl: ${config.groqBaseUrl}`);
      }

      logger.info('');
      logger.info('API:');
      logger.info(`  ${formatProviderKeyStatus(config.provider)}`);

      logger.info('');
      logger.info('Last scan:');
      logger.info(
        lastScan
          ? `  ${formatScanDate(lastScan.scannedAt)} — ${lastScan.flaggedStatements} statements flagged`
          : '  No scan recorded yet',
      );
    });
}

function formatProviderKeyStatus(provider: 'anthropic' | 'openai' | 'ollama' | 'groq'): string {
  if (provider === 'openai') {
    return process.env.OPENAI_API_KEY ? '✓ OPENAI_API_KEY set' : '! OPENAI_API_KEY not set';
  }

  if (provider === 'groq') {
    return process.env.GROQ_API_KEY ? '✓ GROQ_API_KEY set' : '! GROQ_API_KEY not set';
  }

  if (provider === 'ollama') {
    return '✓ no API key required for Ollama';
  }

  return process.env.ANTHROPIC_API_KEY ? '✓ ANTHROPIC_API_KEY set' : '! ANTHROPIC_API_KEY not set';
}

function countLines(content: string): number {
  if (!content) {
    return 0;
  }

  return content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length;
}

function formatScanDate(isoDate: string): string {
  const date = new Date(isoDate);

  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}
