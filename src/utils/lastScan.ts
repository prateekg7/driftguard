import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface LastScanRecord {
  scannedAt: string;
  flaggedStatements: number;
}

const lastScanPath = '.driftguard/last-scan.json';

export function writeLastScan(repoRoot: string, flaggedStatements: number): void {
  const filePath = path.join(repoRoot, lastScanPath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify({ scannedAt: new Date().toISOString(), flaggedStatements }, null, 2)}\n`,
  );
}

export function readLastScan(repoRoot: string): LastScanRecord | undefined {
  const filePath = path.join(repoRoot, lastScanPath);

  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as LastScanRecord;
    return typeof parsed.scannedAt === 'string' && typeof parsed.flaggedStatements === 'number'
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
