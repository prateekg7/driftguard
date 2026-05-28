import * as core from '@actions/core';
import * as github from '@actions/github';
import { findContextFiles, parseContextFile } from './core/contextParser.js';
import { detectDivergence } from './core/divergenceDetector.js';
import { getDiffFromRange } from './core/gitDiff.js';
import { generateProposal } from './core/proposalGenerator.js';
import type { FlaggedStatement, Proposal } from './types.js';
import { loadConfig } from './utils/config.js';

const driftguardCommentMarker = '<!-- driftguard-comment -->';

async function run(): Promise<void> {
  try {
    const pullRequest = github.context.payload.pull_request;

    if (!pullRequest) {
      core.warning('driftguard action only runs on pull_request events. Exiting without changes.');
      setNoDriftOutputs();
      return;
    }

    hydrateProviderEnvironment();

    const repoRoot = process.cwd();
    const config = loadConfig(repoRoot);
    const threshold = Number(core.getInput('confidence-threshold') || config.confidenceThreshold);
    const diff = await getDiffFromRange(pullRequest.base.sha, pullRequest.head.sha);
    const contextFiles = findContextFiles(repoRoot, config.contextFiles);
    const flaggedStatementsByFile = contextFiles.map((contextPath) => {
      const contextFile = parseContextFile(contextPath);
      const flaggedStatements = detectDivergence(contextFile, diff, {
        confidenceThreshold: Number.isFinite(threshold) ? threshold : config.confidenceThreshold,
        ignorePaths: config.ignorePaths,
      });

      return { contextFile, flaggedStatements };
    });
    const allFlaggedStatements = flaggedStatementsByFile.flatMap((item) => item.flaggedStatements);

    if (allFlaggedStatements.length === 0) {
      setNoDriftOutputs();
      return;
    }

    const proposals: Proposal[] = [];

    for (const result of flaggedStatementsByFile.filter((item) => item.flaggedStatements.length > 0)) {
      proposals.push(
        await generateProposal(result.contextFile, result.flaggedStatements, diff, {
          maxTokens: config.maxTokensPerProposal,
          model: config.model,
          groqBaseUrl: config.groqBaseUrl,
          ollamaBaseUrl: config.ollamaBaseUrl,
          provider: config.provider,
        }),
      );
    }

    const proposalText = proposals
      .map((proposal) => proposal.unifiedDiff.trim())
      .filter(Boolean)
      .join('\n\n');
    const confidence = Math.max(0, ...proposals.map((proposal) => proposal.confidence));

    core.setOutput('drift-detected', 'true');
    core.setOutput('proposal', proposalText);
    core.setOutput('confidence', confidence.toFixed(2));

    if (core.getBooleanInput('comment-on-pr')) {
      await upsertDriftguardComment({
        body: buildDriftguardComment(proposalText, confidence, allFlaggedStatements.length),
        issueNumber: pullRequest.number,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`driftguard action skipped after error: ${message}`);
    setNoDriftOutputs();
  } finally {
    process.exit(0);
  }
}

function hydrateProviderEnvironment(): void {
  setEnvFromInput('ANTHROPIC_API_KEY', 'anthropic-api-key');
  setEnvFromInput('GROQ_API_KEY', 'groq-api-key');
  setEnvFromInput('OPENAI_API_KEY', 'openai-api-key');
  setEnvFromInput('GITHUB_TOKEN', 'github-token');
}

function setEnvFromInput(envName: string, inputName: string): void {
  const value = core.getInput(inputName);

  if (value) {
    process.env[envName] = value;
  }
}

function setNoDriftOutputs(): void {
  core.setOutput('drift-detected', 'false');
  core.setOutput('proposal', '');
  core.setOutput('confidence', '0');
}

async function upsertDriftguardComment(options: {
  body: string;
  issueNumber: number;
}): Promise<void> {
  const token = core.getInput('github-token', { required: true });
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const comments = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: options.issueNumber,
    per_page: 100,
  });
  const existingComment = comments.data.find((comment) =>
    comment.body?.includes(driftguardCommentMarker),
  );

  if (existingComment) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body: options.body,
    });
    return;
  }

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: options.issueNumber,
    body: options.body,
  });
}

function buildDriftguardComment(
  proposal: string,
  confidence: number,
  flaggedStatementCount: number,
): string {
  return `${driftguardCommentMarker}
## 🔄 driftguard: Context Drift Warning

This PR changes files that are referenced in \`CLAUDE.md\`.
Your context file may need an update.

<details>
<summary>Proposed update (click to expand)</summary>

\`\`\`diff
${proposal || 'No unified diff was generated. Please inspect the flagged context statements manually.'}
\`\`\`

</details>

**Confidence:** ${confidence.toFixed(2)} · **Flagged statements:** ${flaggedStatementCount}

Apply this suggestion by merging the [auto-generated PR](#link) or editing \`CLAUDE.md\` manually.
*Generated by driftguard · [Disable this comment](link-to-docs)*`;
}

void run();
