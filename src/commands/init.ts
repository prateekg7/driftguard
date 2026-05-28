import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { findContextFiles } from '../core/contextParser.js';
import { writeDefaultConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { findRepoRoot, getGitPath } from '../utils/repo.js';

const HOOK_CONTENT = `#!/bin/sh
# driftguard post-commit hook
# Installed by: npx driftguard init
# Remove with:  npx driftguard uninstall

npx driftguard scan --hook-mode 2>/dev/null || true
`;

export function initCommand(): Command {
  return new Command('init')
    .description('Install the driftguard post-commit hook.')
    .action(async () => {
      const repoRoot = findRepoRoot();

      if (!repoRoot) {
        logger.warn('driftguard init skipped: no git repository found.');
        return;
      }

      const contextFiles = findContextFiles(repoRoot);
      const hookPath = await getGitPath(repoRoot, 'hooks/post-commit');
      const backupPath = `${hookPath}.driftguard-backup`;
      mkdirSync(path.dirname(hookPath), { recursive: true });

      if (existsSync(hookPath) && !readHookContainsDriftguard(hookPath) && !existsSync(backupPath)) {
        copyFileSync(hookPath, backupPath);
      }

      writeFileSync(hookPath, HOOK_CONTENT);
      chmodSync(hookPath, 0o755);
      const wroteConfig = writeDefaultConfig(repoRoot);

      logger.success('✓ driftguard initialized');
      logger.info('');
      logger.info(`  Repository:    ${repoRoot}`);
      logger.info(`  Git hook:      ${hookPath}`);
      logger.info(
        `  Context files: ${
          contextFiles.length ? contextFiles.map((filePath) => path.basename(filePath)).join(', ') : 'none found yet'
        }`,
      );
      logger.info(`  Config:        ${wroteConfig ? 'created driftguard.config.json' : 'existing driftguard.config.json'}`);

      if (!process.env.ANTHROPIC_API_KEY) {
        logger.warn('');
        logger.warn('  ANTHROPIC_API_KEY is not set. driftguard will write drift reports until it is available.');
      }
    });
}

function readHookContainsDriftguard(hookPath: string): boolean {
  try {
    return existsSync(hookPath) && /driftguard post-commit hook/.test(readFileSync(hookPath, 'utf8'));
  } catch {
    return false;
  }
}
