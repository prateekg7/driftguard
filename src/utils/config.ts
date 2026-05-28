import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export interface DriftguardConfig {
  contextFiles: string[];
  confidenceThreshold: number;
  ignorePaths: string[];
  ignoreCommitPatterns: string[];
  provider: 'anthropic' | 'openai' | 'ollama' | 'groq';
  model: string;
  ollamaBaseUrl: string;
  groqBaseUrl: string;
  maxTokensPerProposal: number;
  prMode: {
    enabled: boolean;
    autoCreatePR: boolean;
    baseBranch: string;
    titleTemplate: string;
    labels: string[];
    assignees: string[];
    reviewers: string[];
  };
  output: {
    mode: 'local' | 'pr';
    verbose: boolean;
    hookMode: boolean;
  };
}

export const defaultConfig: DriftguardConfig = {
  contextFiles: ['CLAUDE.md', 'AGENTS.md'],
  confidenceThreshold: 0.65,
  ignorePaths: ['node_modules/**', 'dist/**', '*.lock', '*.snap', '*.generated.*'],
  ignoreCommitPatterns: ['^chore\\(driftguard\\):', '^Merge pull request'],
  provider: 'anthropic',
  model: 'claude-3-haiku-20240307',
  ollamaBaseUrl: 'http://localhost:11434',
  groqBaseUrl: 'https://api.groq.com/openai/v1',
  maxTokensPerProposal: 2000,
  prMode: {
    enabled: false,
    autoCreatePR: false,
    baseBranch: 'main',
    titleTemplate: 'chore(driftguard): update {filename} — {trigger}',
    labels: ['context-drift', 'automated'],
    assignees: [],
    reviewers: [],
  },
  output: {
    mode: 'local',
    verbose: false,
    hookMode: false,
  },
};

export const prModeConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    autoCreatePR: z.boolean().optional(),
    baseBranch: z.string().min(1).optional(),
    titleTemplate: z.string().min(1).optional(),
    labels: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
    reviewers: z.array(z.string()).optional(),
  })
  .strict();

export const driftguardConfigSchema = z
  .object({
    $schema: z.string().optional(),
    contextFiles: z.array(z.string()).optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    ignorePaths: z.array(z.string()).optional(),
    ignoreCommitPatterns: z.array(z.string()).optional(),
    provider: z.enum(['anthropic', 'openai', 'ollama', 'groq']).optional(),
    model: z.string().min(1).optional(),
    ollamaBaseUrl: z.string().url().optional(),
    groqBaseUrl: z.string().url().optional(),
    maxTokensPerProposal: z.number().int().positive().optional(),
    prMode: prModeConfigSchema.optional(),
    output: z
      .object({
        mode: z.enum(['local', 'pr']).optional(),
        verbose: z.boolean().optional(),
        hookMode: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strip();

export function loadConfig(repoRoot = process.cwd()): DriftguardConfig {
  const configPath = path.join(repoRoot, 'driftguard.config.json');

  if (!existsSync(configPath)) {
    return defaultConfig;
  }

  try {
    const parsedConfig = driftguardConfigSchema.parse(
      JSON.parse(readFileSync(configPath, 'utf8')),
    ) as Partial<DriftguardConfig>;
    return mergeConfig(defaultConfig, parsedConfig);
  } catch {
    return defaultConfig;
  }
}

export function writeDefaultConfig(repoRoot = process.cwd()): boolean {
  const configPath = path.join(repoRoot, 'driftguard.config.json');

  if (existsSync(configPath)) {
    return false;
  }

  writeFileSync(`${configPath}`, `${JSON.stringify(defaultConfig, null, 2)}\n`);
  return true;
}

function mergeConfig(
  baseConfig: DriftguardConfig,
  overrideConfig: Partial<DriftguardConfig>,
): DriftguardConfig {
  const provider = overrideConfig.provider ?? baseConfig.provider;

  return {
    ...baseConfig,
    ...overrideConfig,
    provider,
    model: overrideConfig.model ?? getDefaultModelForProvider(provider),
    ollamaBaseUrl: overrideConfig.ollamaBaseUrl ?? baseConfig.ollamaBaseUrl,
    groqBaseUrl: overrideConfig.groqBaseUrl ?? baseConfig.groqBaseUrl,
    contextFiles: overrideConfig.contextFiles ?? baseConfig.contextFiles,
    ignorePaths: overrideConfig.ignorePaths ?? baseConfig.ignorePaths,
    ignoreCommitPatterns: overrideConfig.ignoreCommitPatterns ?? baseConfig.ignoreCommitPatterns,
    prMode: {
      ...baseConfig.prMode,
      ...overrideConfig.prMode,
      labels: overrideConfig.prMode?.labels ?? baseConfig.prMode.labels,
      assignees: overrideConfig.prMode?.assignees ?? baseConfig.prMode.assignees,
      reviewers: overrideConfig.prMode?.reviewers ?? baseConfig.prMode.reviewers,
    },
    output: {
      ...baseConfig.output,
      ...overrideConfig.output,
    },
  };
}

export function getDefaultModelForProvider(provider: DriftguardConfig['provider']): string {
  if (provider === 'openai') {
    return 'gpt-4o-mini';
  }

  if (provider === 'ollama') {
    return 'llama3';
  }

  if (provider === 'groq') {
    return 'llama-3.1-8b-instant';
  }

  return 'claude-3-haiku-20240307';
}
