import { writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ContextFile, DiffResult, FlaggedStatement, Proposal } from '../types.js';
import {
  defaultConfig,
  type DriftguardConfig,
  getDefaultModelForProvider,
} from '../utils/config.js';

interface AnthropicClient {
  messages: {
    create(input: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: 'user'; content: string }>;
    }): Promise<AnthropicMessageResponse>;
  };
}

interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface OpenAIClient {
  chat: {
    completions: {
      create(input: {
        model: string;
        max_tokens: number;
        messages: Array<{ role: 'system' | 'user'; content: string }>;
      }): Promise<OpenAIMessageResponse>;
    };
  };
}

interface OpenAIMessageResponse {
  choices: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

interface OllamaGenerateResponse {
  response?: string;
}

export interface GenerateProposalOptions {
  apiKey?: string;
  client?: AnthropicClient;
  fetchImpl?: typeof fetch;
  groqBaseUrl?: string;
  groqClient?: OpenAIClient;
  maxTokens?: number;
  model?: string;
  ollamaBaseUrl?: string;
  openaiClient?: OpenAIClient;
  provider?: DriftguardConfig['provider'];
  writeReportOnError?: boolean;
}

interface LLMOptions extends GenerateProposalOptions {
  provider: DriftguardConfig['provider'];
}

const SYSTEM_PROMPT = `You are a surgical editor for CLAUDE.md and AGENTS.md files.

RULES — follow all of them without exception:
1. Output EXACTLY ONE unified diff. No prose. No explanation. No multiple alternatives.
2. Only modify lines where the git diff provides DIRECT evidence of a change.
   - A file being modified is NOT evidence its CLAUDE.md description is wrong.
   - Only act if the diff shows a deletion, rename, or replacement of something the line explicitly references.
3. If you are not certain a line needs changing, leave it UNCHANGED.
4. Never change punctuation, whitespace, or phrasing unless the referenced fact is factually wrong.
5. If no changes are warranted, output exactly: NO_CHANGES_NEEDED

Output only the unified diff or NO_CHANGES_NEEDED. Nothing else before it, nothing after it.`;

export async function generateProposal(
  contextFile: ContextFile,
  flaggedStatements: FlaggedStatement[],
  diff: DiffResult,
  options: GenerateProposalOptions = {},
): Promise<Proposal> {
  if (flaggedStatements.length === 0) {
    return createEmptyProposal('No flagged statements were provided.');
  }

  const confidence = getOverallConfidence(flaggedStatements);
  const provider = options.provider ?? defaultConfig.provider;

  try {
    const userPrompt = buildUserPrompt(contextFile, flaggedStatements, diff);
    const responseText = stripMarkdownFence(
      await callLLM(SYSTEM_PROMPT, userPrompt, {
        ...options,
        provider,
      }),
    );

    await new Promise(resolve => setTimeout(resolve, 0));

    if (responseText.includes('NO_CHANGES_NEEDED')) {
      return createEmptyProposal('✓ No updates needed', confidence);
    }

    const unifiedDiff = isUnifiedDiff(responseText) ? responseText : '';

    return {
      unifiedDiff,
      reasoning: unifiedDiff
        ? `Generated a surgical proposal for ${flaggedStatements.length} flagged statement(s).`
        : 'Model returned no applicable unified diff.',
      confidence,
      tokensUsed: 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reportPath = writeFallbackReportIfEnabled(contextFile, flaggedStatements, message, options);

    return createEmptyProposal(
      reportPath
        ? `LLM proposal generation failed: ${message}. Drift report written to ${reportPath}.`
        : `LLM proposal generation failed: ${message}.`,
      confidence,
    );
  }
}

export async function callLLM(
  systemPrompt: string,
  userPrompt: string,
  options: GenerateProposalOptions = {},
): Promise<string> {
  const provider = options.provider ?? defaultConfig.provider;

  if (provider === 'openai') {
    return callOpenAI(systemPrompt, userPrompt, { ...options, provider });
  }

  if (provider === 'ollama') {
    return callOllama(systemPrompt, userPrompt, { ...options, provider });
  }

  if (provider === 'groq') {
    return callGroq(systemPrompt, userPrompt, { ...options, provider });
  }

  return callAnthropic(systemPrompt, userPrompt, { ...options, provider });
}

async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
  options: LLMOptions,
): Promise<string> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const client = options.client ?? createAnthropicClient(apiKey);

  if (!client) {
    throw new Error('ANTHROPIC_API_KEY is not set.');
  }

  const response = await client.messages.create({
    model: resolveModel(options),
    max_tokens: options.maxTokens ?? defaultConfig.maxTokensPerProposal,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: userPrompt,
      },
    ],
  });

  return extractAnthropicTextResponse(response);
}

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
  options: LLMOptions,
): Promise<string> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const client = options.openaiClient ?? createOpenAIClient(apiKey);

  if (!client) {
    throw new Error('OPENAI_API_KEY is not set.');
  }

  const response = await client.chat.completions.create({
    model: resolveModel(options),
    max_tokens: options.maxTokens ?? defaultConfig.maxTokensPerProposal,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  return extractOpenAITextResponse(response);
}

async function callGroq(
  systemPrompt: string,
  userPrompt: string,
  options: LLMOptions,
): Promise<string> {
  const apiKey = options.apiKey ?? process.env.GROQ_API_KEY;
  const client =
    options.groqClient ??
    createOpenAICompatibleClient(apiKey, options.groqBaseUrl ?? defaultConfig.groqBaseUrl);

  if (!client) {
    throw new Error('GROQ_API_KEY is not set.');
  }

  const response = await client.chat.completions.create({
    model: resolveModel(options),
    max_tokens: options.maxTokens ?? defaultConfig.maxTokensPerProposal,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const rawResponse = extractOpenAITextResponse(response);
  const responseText = await Promise.resolve(rawResponse);
  return responseText;
}

function extractOpenAITextResponse(response: OpenAIMessageResponse): string {
  return response.choices
    .map((choice) => choice.message?.content?.trim())
    .filter((text): text is string => Boolean(text))
    .join('\n')
    .trim();
}

async function callOllama(
  systemPrompt: string,
  userPrompt: string,
  options: LLMOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.ollamaBaseUrl ?? defaultConfig.ollamaBaseUrl).replace(/\/$/, '');
  const response = await fetchImpl(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: resolveModel(options),
      system: systemPrompt,
      prompt: userPrompt,
      stream: false,
      options: {
        num_predict: options.maxTokens ?? defaultConfig.maxTokensPerProposal,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed with HTTP ${response.status}.`);
  }

  const body = (await response.json()) as OllamaGenerateResponse;
  return body.response?.trim() ?? '';
}

function resolveModel(options: LLMOptions): string {
  return options.model ?? getDefaultModelForProvider(options.provider);
}

function createAnthropicClient(apiKey: string | undefined): AnthropicClient | undefined {
  return apiKey ? (new Anthropic({ apiKey }) as AnthropicClient) : undefined;
}

function createOpenAIClient(apiKey: string | undefined): OpenAIClient | undefined {
  return apiKey ? (new OpenAI({ apiKey }) as OpenAIClient) : undefined;
}

function createOpenAICompatibleClient(
  apiKey: string | undefined,
  baseURL: string,
): OpenAIClient | undefined {
  return apiKey ? (new OpenAI({ apiKey, baseURL }) as OpenAIClient) : undefined;
}

function buildUserPrompt(
  contextFile: ContextFile,
  flaggedStatements: FlaggedStatement[],
  diff: DiffResult,
): string {
  return `Current ${contextFile.path}:
<file>
${contextFile.rawContent}
</file>

The following statements were flagged as potentially stale based on this commit:
<flagged>
${flaggedStatements
  .map((flagged) => `Line ${flagged.statement.lineNumber}: "${flagged.statement.rawText}"`)
  .join('\n')}
</flagged>

Evidence from the git diff (only the relevant sections):
<diff>
${getRelevantDiffSections(flaggedStatements, diff)}
</diff>

Propose minimal updates. Output only the unified diff.`;
}

function getRelevantDiffSections(flaggedStatements: FlaggedStatement[], diff: DiffResult): string {
  const sections = flaggedStatements
    .flatMap((flagged) => flagged.matchedChanges.map((change) => change.evidence.trim()))
    .filter(Boolean);

  const uniqueSections = [...new Set(sections)];
  return uniqueSections.length > 0 ? uniqueSections.join('\n\n') : diff.diffContent;
}

function extractAnthropicTextResponse(response: AnthropicMessageResponse): string {
  return response.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join('\n')
    .trim();
}

function stripMarkdownFence(text: string): string {
  const match = text.match(/^```(?:diff)?\s*\n([\s\S]*?)\n```$/);
  return (match?.[1] ?? text).trim();
}

function isUnifiedDiff(text: string): boolean {
  return /^---\s+a\//m.test(text) && /^\+\+\+\s+b\//m.test(text) && /^@@\s/m.test(text);
}

function getOverallConfidence(flaggedStatements: FlaggedStatement[]): number {
  return Math.max(0, ...flaggedStatements.map((flagged) => flagged.overallConfidence));
}

function writeFallbackReportIfEnabled(
  contextFile: ContextFile,
  flaggedStatements: FlaggedStatement[],
  reason: string,
  options: GenerateProposalOptions,
): string | undefined {
  if (options.writeReportOnError === false) {
    return undefined;
  }

  const reportPath = `${contextFile.path}.drift-report.md`;
  writeFileSync(reportPath, buildFallbackReport(contextFile, flaggedStatements, reason));
  return reportPath;
}

function buildFallbackReport(
  contextFile: ContextFile,
  flaggedStatements: FlaggedStatement[],
  reason: string,
): string {
  return [
    '# driftguard drift report',
    '',
    `Context file: ${contextFile.path}`,
    `Reason: ${reason}`,
    '',
    'Flagged statements:',
    ...flaggedStatements.map(
      (flagged) =>
        `- Line ${flagged.statement.lineNumber} (${flagged.overallConfidence.toFixed(2)}): ${flagged.statement.rawText}`,
    ),
    '',
  ].join('\n');
}

function createEmptyProposal(reasoning: string, confidence = 0): Proposal {
  return {
    unifiedDiff: '',
    reasoning,
    confidence,
    tokensUsed: 0,
  };
}
