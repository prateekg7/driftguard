import { simpleGit, type SimpleGit } from 'simple-git';
import type { DiffResult } from '../types.js';

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export async function getDiffFromLastCommit(): Promise<DiffResult> {
  const git = simpleGit(process.cwd());

  if (!(await hasCommit(git, 'HEAD'))) {
    return getEmptyDiffResult();
  }

  const parents = await getCommitParents(git, 'HEAD');

  if (parents.length === 0) {
    return getDiffFromRange(EMPTY_TREE_HASH, 'HEAD');
  }

  if (parents.length === 1) {
    return getDiffFromRange(parents[0], 'HEAD');
  }

  const parentDiffs = await Promise.all(
    parents.map((parent) => getDiffParts(git, parent, 'HEAD')),
  );
  const metadata = await getCommitMetadata(git, 'HEAD');

  return combineDiffResults(parentDiffs, metadata);
}

export async function getDiffFromRange(from: string, to: string): Promise<DiffResult> {
  const git = simpleGit(process.cwd());

  if (!(await hasCommit(git, to))) {
    return getEmptyDiffResult();
  }

  try {
    const [parts, metadata] = await Promise.all([
      getDiffParts(git, from, to),
      getCommitMetadata(git, to),
    ]);

    return {
      ...parts,
      ...metadata,
    };
  } catch {
    return getEmptyDiffResult();
  }
}

async function getDiffParts(
  git: SimpleGit,
  from: string,
  to: string,
): Promise<Omit<DiffResult, 'commitMessage' | 'commitHash'>> {
  const [nameStatus, diffContent] = await Promise.all([
    git.raw(['diff', '--name-status', '-z', from, to, '--']),
    git.raw(['diff', from, to, '--']),
  ]);

  return {
    ...parseNameStatus(nameStatus),
    diffContent,
  };
}

function parseNameStatus(nameStatus: string): Pick<
  DiffResult,
  'changedFiles' | 'deletedFiles' | 'renamedFiles'
> {
  const changedFiles = new Set<string>();
  const deletedFiles = new Set<string>();
  const renamedFiles: DiffResult['renamedFiles'] = [];
  const parts = nameStatus.split('\0').filter(Boolean);

  for (let index = 0; index < parts.length; ) {
    const status = parts[index++];
    const changeKind = status?.[0];

    if (!status || !changeKind) {
      continue;
    }

    if (changeKind === 'R') {
      const from = parts[index++];
      const to = parts[index++];
      if (from && to) {
        changedFiles.add(to);
        renamedFiles.push({ from, to });
      }
      continue;
    }

    const filePath = parts[index++];
    if (!filePath) {
      continue;
    }

    changedFiles.add(filePath);

    if (changeKind === 'D') {
      deletedFiles.add(filePath);
    }
  }

  return {
    changedFiles: [...changedFiles],
    deletedFiles: [...deletedFiles],
    renamedFiles,
  };
}

async function hasCommit(git: SimpleGit, revision: string): Promise<boolean> {
  try {
    await git.raw(['rev-parse', '--verify', `${revision}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function getCommitParents(git: SimpleGit, revision: string): Promise<string[]> {
  const rawParents = await git.raw(['show', '--no-patch', '--pretty=%P', revision]);
  return rawParents.trim().split(/\s+/).filter(Boolean);
}

async function getCommitMetadata(
  git: SimpleGit,
  revision: string,
): Promise<Pick<DiffResult, 'commitHash' | 'commitMessage'>> {
  const [commitHash, commitMessage] = await Promise.all([
    git.raw(['rev-parse', revision]),
    git.raw(['log', '-1', '--pretty=%B', revision]),
  ]);

  return {
    commitHash: commitHash.trim(),
    commitMessage: commitMessage.trim(),
  };
}

function combineDiffResults(
  results: Array<Omit<DiffResult, 'commitMessage' | 'commitHash'>>,
  metadata: Pick<DiffResult, 'commitMessage' | 'commitHash'>,
): DiffResult {
  const changedFiles = new Set<string>();
  const deletedFiles = new Set<string>();
  const renamedKeys = new Set<string>();
  const renamedFiles: DiffResult['renamedFiles'] = [];

  for (const result of results) {
    for (const filePath of result.changedFiles) {
      changedFiles.add(filePath);
    }

    for (const filePath of result.deletedFiles) {
      deletedFiles.add(filePath);
    }

    for (const rename of result.renamedFiles) {
      const key = `${rename.from}\0${rename.to}`;
      if (!renamedKeys.has(key)) {
        renamedFiles.push(rename);
        renamedKeys.add(key);
      }
    }
  }

  return {
    changedFiles: [...changedFiles],
    deletedFiles: [...deletedFiles],
    renamedFiles,
    diffContent: results.map((result) => result.diffContent.trim()).filter(Boolean).join('\n\n'),
    ...metadata,
  };
}

export function getEmptyDiffResult(): DiffResult {
  return {
    changedFiles: [],
    deletedFiles: [],
    renamedFiles: [],
    diffContent: '',
    commitMessage: '',
    commitHash: '',
  };
}
