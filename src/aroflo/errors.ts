export type ConnectorErrorCode =
  | 'CONFIGURATION'
  | 'AUTHENTICATION'
  | 'PERMISSION'
  | 'VALIDATION'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'UPSTREAM'
  | 'MALFORMED_RESPONSE'
  | 'RESPONSE_TOO_LARGE';

export class ConnectorError extends Error {
  constructor(
    public readonly code: ConnectorErrorCode,
    message: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

export class RateBudgetExceededError extends ConnectorError {
  constructor(message = 'The AroFlo daily request budget has been exhausted') {
    super('RATE_LIMIT', message, false);
    this.name = 'RateBudgetExceededError';
  }
}
