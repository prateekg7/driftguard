import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { Command } from 'commander';
import { logger } from '../utils/logger.js';
import { findRepoRoot, getGitPath } from '../utils/repo.js';

export function uninstallCommand(): Command {
  return new Command('uninstall')
    .description('Remove the driftguard post-commit hook.')
    .action(async () => {
      const repoRoot = findRepoRoot();

      if (!repoRoot) {
        logger.warn('driftguard uninstall skipped: no git repository found.');
        return;
      }

      const hookPath = await getGitPath(repoRoot, 'hooks/post-commit');
      const backupPath = `${hookPath}.driftguard-backup`;

      if (!existsSync(hookPath)) {
        logger.info('No post-commit hook found.');
        return;
      }

      const hookContent = readFileSync(hookPath, 'utf8');
      if (!/driftguard post-commit hook/.test(hookContent)) {
        logger.info('No driftguard-managed post-commit hook found.');
        return;
      }

      if (existsSync(backupPath)) {
        rmSync(hookPath);
        renameSync(backupPath, hookPath);
        logger.success('✓ driftguard hook removed and previous post-commit hook restored');
        return;
      }

      rmSync(hookPath);
      logger.success('✓ driftguard hook removed');
    });
}
