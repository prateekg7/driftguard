import type { ContextToken } from '../types.js';

const COMMAND_PREFIX =
  '(?:npm|pnpm|yarn|npx|bun|python|python3|pip|pip3|poetry|pytest|vitest|jest|cargo|go|make|docker|kubectl)';

const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

export function extractTokens(text: string): ContextToken[] {
  const tokens: ContextToken[] = [];

  for (const value of getBacktickValues(text)) {
    if (isCommand(value)) {
      tokens.push({ type: 'command', value, confidence: 0.9 });
      continue;
    }

    if (isLibrary(value)) {
      tokens.push({ type: 'library', value, confidence: 0.75 });
      continue;
    }

    if (isFilepath(value)) {
      tokens.push({ type: 'filepath', value: normalizePathToken(value), confidence: 0.95 });
      continue;
    }

    tokens.push({ type: 'generic', value, confidence: 0.4 });
  }

  for (const value of getInlineCommands(text)) {
    tokens.push({ type: 'command', value, confidence: 0.9 });
  }

  const patternValue = getPatternToken(text);
  if (patternValue) {
    tokens.push({ type: 'pattern', value: patternValue, confidence: 0.6 });
  }

  return dedupeTokens(tokens);
}

function getBacktickValues(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function getInlineCommands(text: string): string[] {
  const commandPattern = new RegExp(
    `(?:^|\\s)(${COMMAND_PREFIX}(?:\\s+[^\\s.;,)\`]+){0,6})`,
    'gi',
  );

  return [...text.matchAll(commandPattern)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .map(truncateProseCommand)
    .filter((value) => !value.includes('`'));
}

function getPatternToken(text: string): string | undefined {
  const normalized = stripMarkdownBullet(text);
  if (/\b(?:never|always|do not|don't)\b/i.test(normalized)) {
    return normalized;
  }

  if (/\buse\s+.+\s+for\s+.+/i.test(normalized)) {
    return normalized;
  }

  return undefined;
}

function isCommand(value: string): boolean {
  return new RegExp(`^${COMMAND_PREFIX}\\b`, 'i').test(value);
}

function isFilepath(value: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return false;
  }

  return (
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('/') ||
    value.startsWith('src/') ||
    value.includes('/')
  );
}

function isLibrary(value: string): boolean {
  return packageNamePattern.test(value) && !isCommand(value);
}

function normalizePathToken(value: string): string {
  return value.replace(/^\.\//, '');
}

function stripMarkdownBullet(text: string): string {
  return text.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim();
}

function truncateProseCommand(value: string): string {
  const stopWords = new Set([
    'after',
    'and',
    'before',
    'for',
    'if',
    'in',
    'inside',
    'or',
    'outside',
    'unless',
    'when',
    'with',
    'without',
  ]);
  const parts = value.split(/\s+/);
  const truncated = [parts[0]];

  for (const part of parts.slice(1)) {
    if (stopWords.has(part.toLowerCase())) {
      break;
    }

    truncated.push(part);

    if (truncated.length >= 4) {
      break;
    }
  }

  return truncated.join(' ');
}

function dedupeTokens(tokens: ContextToken[]): ContextToken[] {
  const seen = new Set<string>();
  return tokens.filter((token) => {
    const key = `${token.type}:${token.value}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
