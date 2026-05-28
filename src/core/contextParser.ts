import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ContextFile } from '../types.js';
import { defaultConfig } from '../utils/config.js';
import { extractTokens } from '../utils/tokenizer.js';

export function parseContextFile(filePath: string): ContextFile {
  const rawContent = readFileSync(filePath, 'utf8');
  const lines = rawContent.split(/\r?\n/);
  let section = 'General';

  return {
    path: filePath,
    rawContent,
    statements: lines.flatMap((line, index) => {
      const trimmed = line.trim();
      const heading = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*$/);

      if (heading) {
        section = heading[2]?.trim() || section;
        return [];
      }

      if (!trimmed || isHtmlComment(trimmed)) {
        return [];
      }

      return [
        {
          lineNumber: index + 1,
          rawText: trimmed,
          tokens: extractTokens(trimmed),
          section,
          suppressedByComment: hasIgnoreCommentAbove(lines, index),
        },
      ];
    }),
  };
}

export function findContextFiles(
  repoRoot: string,
  candidates = defaultConfig.contextFiles,
): string[] {
  return candidates
    .map((fileName) => path.join(repoRoot, fileName))
    .filter((filePath) => existsSync(filePath));
}

function isHtmlComment(text: string): boolean {
  return /^<!--.*-->$/.test(text);
}

function hasIgnoreCommentAbove(lines: string[], index: number): boolean {
  if (index === 0) {
    return false;
  }

  return /^\s*<!--\s*driftguard-ignore\b/i.test(lines[index - 1] ?? '');
}
