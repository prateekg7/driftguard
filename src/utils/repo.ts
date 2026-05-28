import { existsSync } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';

export function findRepoRoot(startDirectory = process.cwd()): string | undefined {
  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    if (existsSync(path.join(currentDirectory, '.git'))) {
      return currentDirectory;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

export async function getGitPath(repoRoot: string, gitPath: string): Promise<string> {
  const rawPath = await simpleGit(repoRoot).raw(['rev-parse', '--git-path', gitPath]);
  const trimmedPath = rawPath.trim();
  return path.isAbsolute(trimmedPath) ? trimmedPath : path.join(repoRoot, trimmedPath);
}
