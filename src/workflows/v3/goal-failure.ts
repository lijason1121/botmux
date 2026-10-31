/** Only known runtime/provider failures are recoverable. Unknown crashes keep
 * the existing fail-fast behavior; classification never authorizes a replay. */
export interface GoalFailure {
  kind: 'quota' | 'authentication' | 'configuration' | 'timeout' | 'outputBudget' | 'transient';
  code: string;
  recoverable: boolean;
}

export function classifyGoalFailure(detail: string, reason?: string): GoalFailure | undefined {
  if (/\b2067\b|token plan.*(?:exhaust|usage)|insufficient[_ ]quota|quota.*(?:exhaust|exceed)|usage limit|credit balance.*(?:low|insufficient)/i.test(detail)) {
    return { kind: 'quota', code: 'PROVIDER_QUOTA_EXHAUSTED', recoverable: true };
  }
  if (/authentication[_ ](?:failed|required)|AUTH_REQUIRED|invalid[_ ]api[_ ]key|token.*expired|\b(?:401|403|unauthorized|forbidden)\b|login required/i.test(detail)) {
    return { kind: 'authentication', code: 'PROVIDER_AUTH_REQUIRED', recoverable: true };
  }
  if (/model[_ ](?:unavailable|invalid|not found)|unsupported model|PREFLIGHT_CONTRACT_MISMATCH|mcode_acp_version_unsupported|mcode ACP 不支持配置/i.test(detail)) {
    return { kind: 'configuration', code: 'WORKER_CONFIGURATION_INVALID', recoverable: false };
  }
  if (/mcode_acp_(?:output|frame|content)_limit|output budget exceeded/i.test(detail)) {
    return { kind: 'outputBudget', code: 'WORKER_OUTPUT_BUDGET', recoverable: true };
  }
  if (reason === 'timeout' || /node timed out after \d+s|mcode ACP .*超时/.test(detail)) {
    return { kind: 'timeout', code: 'WORKER_TIMEOUT', recoverable: true };
  }
  if (/\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT)\b|\b429\b.*(?:rate|too many)|\b(?:502|503|504)\b.*(?:gateway|unavailable)|overloaded_error/i.test(detail)) {
    return { kind: 'transient', code: 'PROVIDER_TRANSIENT_FAILURE', recoverable: true };
  }
  return undefined;
}
