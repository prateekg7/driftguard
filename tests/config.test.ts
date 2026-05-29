import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig, getDefaultModelForProvider, loadConfig } from '../src/utils/config.js';

describe('config', () => {
  it('keeps autoCreatePR disabled by default', () => {
    expect(defaultConfig).toMatchObject({
      provider: 'anthropic',
      model: 'claude-3-haiku-20240307',
      ollamaBaseUrl: 'http://localhost:11434',
      groqBaseUrl: 'https://api.groq.com/openai/v1',
    });
    expect(defaultConfig.prMode).toMatchObject({
      enabled: false,
      autoCreatePR: false,
      baseBranch: 'main',
      titleTemplate: 'chore(driftguard): update {filename} — {trigger}',
      labels: ['context-drift', 'automated'],
    });
  });

  it('validates and merges prMode config with zod', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'driftguard-config-'));
    writeFileSync(
      path.join(repoRoot, 'driftguard.config.json'),
      JSON.stringify({
        confidenceThreshold: 0.8,
        provider: 'openai',
        prMode: {
          enabled: true,
          baseBranch: 'develop',
          labels: ['context-drift'],
        },
      }),
    );

    expect(loadConfig(repoRoot)).toMatchObject({
      confidenceThreshold: 0.8,
      provider: 'openai',
      model: 'gpt-4o-mini',
      prMode: {
        enabled: true,
        autoCreatePR: false,
        baseBranch: 'develop',
        labels: ['context-drift'],
      },
    });
  });

  it('uses provider-specific default models unless model is explicit', () => {
    const openaiRoot = mkdtempSync(path.join(tmpdir(), 'driftguard-openai-config-'));
    const ollamaRoot = mkdtempSync(path.join(tmpdir(), 'driftguard-ollama-config-'));
    const groqRoot = mkdtempSync(path.join(tmpdir(), 'driftguard-groq-config-'));
    const explicitRoot = mkdtempSync(path.join(tmpdir(), 'driftguard-explicit-config-'));

    writeFileSync(
      path.join(openaiRoot, 'driftguard.config.json'),
      JSON.stringify({ provider: 'openai' }),
    );
    writeFileSync(
      path.join(ollamaRoot, 'driftguard.config.json'),
      JSON.stringify({ provider: 'ollama' }),
    );
    writeFileSync(
      path.join(groqRoot, 'driftguard.config.json'),
      JSON.stringify({ provider: 'groq' }),
    );
    writeFileSync(
      path.join(explicitRoot, 'driftguard.config.json'),
      JSON.stringify({ provider: 'openai', model: 'gpt-4.1-mini' }),
    );

    expect(loadConfig(openaiRoot).model).toBe('gpt-4o-mini');
    expect(loadConfig(ollamaRoot).model).toBe('llama3');
    expect(loadConfig(groqRoot).model).toBe('llama-3.3-70b-versatile');
    expect(loadConfig(explicitRoot).model).toBe('gpt-4.1-mini');
    expect(getDefaultModelForProvider('anthropic')).toBe('claude-3-haiku-20240307');
  });

  it('falls back to defaults when config types are invalid', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'driftguard-config-invalid-'));
    writeFileSync(
      path.join(repoRoot, 'driftguard.config.json'),
      JSON.stringify({
        prMode: {
          autoCreatePR: 'please do not',
        },
      }),
    );

    expect(loadConfig(repoRoot)).toEqual(defaultConfig);
  });
});
