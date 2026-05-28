export interface DiffResult {
  changedFiles: string[];
  deletedFiles: string[];
  renamedFiles: Array<{ from: string; to: string }>;
  diffContent: string;
  commitMessage: string;
  commitHash: string;
}

export interface ContextStatement {
  lineNumber: number;
  rawText: string;
  tokens: ContextToken[];
  section: string;
  suppressedByComment: boolean;
}

export interface ContextToken {
  type: 'filepath' | 'library' | 'command' | 'pattern' | 'generic';
  value: string;
  confidence: number;
}

export interface ContextFile {
  path: string;
  rawContent: string;
  statements: ContextStatement[];
}

export interface FlaggedStatement {
  statement: ContextStatement;
  matchedChanges: MatchedChange[];
  overallConfidence: number;
}

export interface MatchedChange {
  changedFilePath: string;
  matchedToken: ContextToken;
  changeType: 'deleted' | 'renamed' | 'modified' | 'moved';
  evidence: string;
}

export interface Proposal {
  unifiedDiff: string;
  reasoning: string;
  confidence: number;
  tokensUsed: number;
}
