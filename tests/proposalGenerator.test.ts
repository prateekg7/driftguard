import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseContextFile } from '../src/core/contextParser.js';
import { detectDivergence } from '../src/core/divergenceDetector.js';
import { callLLM, generateProposal } from '../src/core/proposalGenerator.js';
import type { DiffResult } from '../src/types.js';

describe('proposalGenerator', () => {
  it('generates a proposal from a mocked Claude response', async () => {
    const client = makeClient(`--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -2,4 +2,3 @@
 ## Tech Stack
-- Auth is handled via JWT middleware in \`src/middleware/auth.ts\` using the \`jose\` library.
+- Auth is handled via Supabase auth in \`src/lib/supabaseAuth.ts\`.
 - Tests live in \`__tests__/\` and use \`npm run test\`.`);
    const proposal = await generateProposal(getContextFile(), getFlaggedStatements(), getAuthDiff(), {
      client,
      writeReportOnError: false,
    });

    expect(proposal.unifiedDiff).toContain('src/lib/supabaseAuth.ts');
    expect(proposal.confidence).toBe(0.95);
    expect(proposal.tokensUsed).toBe(0);
    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        max_tokens: 2000,
        model: 'claude-3-haiku-20240307',
        messages: [
          expect.objectContaining({
            content: expect.stringContaining('Evidence from the git diff'),
          }),
        ],
      }),
    );
    expect(client.messages.create.mock.calls[0]?.[0].messages[0]?.content).not.toContain(
      'package.json',
    );
  });

  it('handles empty or non-diff responses gracefully', async () => {
    const proposal = await generateProposal(getContextFile(), getFlaggedStatements(), getAuthDiff(), {
      client: makeClient('No changes needed.'),
      writeReportOnError: false,
    });

    expect(proposal.unifiedDiff).toBe('');
    expect(proposal.reasoning).toBe('Model returned no applicable unified diff.');
  });

  it('handles API errors without throwing', async () => {
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error('network down')),
      },
    };

    await expect(
      generateProposal(getContextFile(), getFlaggedStatements(), getAuthDiff(), {
        client,
        writeReportOnError: false,
      }),
    ).resolves.toMatchObject({
      unifiedDiff: '',
      reasoning: 'LLM proposal generation failed: network down.',
    });
  });

  it('calls OpenAI with the shared prompts and provider default model', async () => {
    const openaiClient = makeOpenAICompatibleClient();

    await expect(
      callLLM('system prompt', 'user prompt', {
        openaiClient,
        provider: 'openai',
      }),
    ).resolves.toContain('+++ b/CLAUDE.md');

    expect(openaiClient.chat.completions.create).toHaveBeenCalledWith({
      model: 'gpt-4o-mini',
      max_tokens: 2000,
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
    });
  });

  it('calls Groq with the shared prompts and free-tier-friendly default model', async () => {
    const groqClient = makeOpenAICompatibleClient();

    await expect(
      callLLM('system prompt', 'user prompt', {
        groqClient,
        provider: 'groq',
      }),
    ).resolves.toContain('+++ b/CLAUDE.md');

    expect(groqClient.chat.completions.create).toHaveBeenCalledWith({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 2000,
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
    });
  });

  it('calls Ollama generate endpoint without requiring an API key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        response: '--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1 +1 @@\n-old\n+new',
      }),
    });

    await expect(
      callLLM('system prompt', 'user prompt', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        ollamaBaseUrl: 'http://localhost:11434',
        provider: 'ollama',
      }),
    ).resolves.toContain('+++ b/CLAUDE.md');

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:11434/api/generate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'llama3',
          system: 'system prompt',
          prompt: 'user prompt',
          stream: false,
          options: {
            num_predict: 2000,
          },
        }),
      }),
    );
  });

  it('reports missing provider-specific API keys', async () => {
    await expect(
      callLLM('system prompt', 'user prompt', {
        apiKey: '',
        provider: 'openai',
      }),
    ).rejects.toThrow('OPENAI_API_KEY is not set.');

    await expect(
      callLLM('system prompt', 'user prompt', {
        apiKey: '',
        provider: 'groq',
      }),
    ).rejects.toThrow('GROQ_API_KEY is not set.');
  });

  it.skipIf(!process.env.ANTHROPIC_API_KEY)(
    'produces a reasonable diff with a real Anthropic API call',
    async () => {
      const proposal = await generateProposal(getContextFile(), getFlaggedStatements(), getAuthDiff(), {
        writeReportOnError: false,
      });

      expect(proposal.reasoning).toBeTruthy();
      expect(proposal.confidence).toBeGreaterThan(0.6);
    },
  );
});

function getContextFile() {
  return parseContextFile(path.join(process.cwd(), 'tests/fixtures/sample-claude-md/tech-stack.md'));
}

function getAuthDiff(): DiffResult {
  return {
    changedFiles: ['src/middleware/auth.ts', 'src/lib/supabaseAuth.ts'],
    deletedFiles: ['src/middleware/auth.ts'],
    renamedFiles: [],
    diffContent: readFileSync(
      path.join(process.cwd(), 'tests/fixtures/sample-diffs/auth-refactor.diff'),
      'utf8',
    ),
    commitMessage: 'refactor auth to supabase',
    commitHash: 'abc123',
  };
}

function getFlaggedStatements() {
  return detectDivergence(getContextFile(), getAuthDiff());
}

function makeClient(text: string) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text }],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
        },
      }),
    },
  };
}

function makeOpenAICompatibleClient() {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: '--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1 +1 @@\n-old\n+new',
              },
            },
          ],
        }),
      },
    },
  };
}
