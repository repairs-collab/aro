import { createHmac } from 'node:crypto';
import type { AroFloCredentials } from '../config.js';
import { encodePairs } from './query.js';

export interface SigningInput {
  method: 'GET' | 'POST';
  hostIp?: string;
  authorization: string;
  timestamp: string;
  varString: string;
}

export function buildAuthorization(credentials: AroFloCredentials): string {
  return encodePairs([
    ['uencoded', credentials.uEncoded],
    ['pencoded', credentials.pEncoded],
    ['orgEncoded', credentials.orgEncoded]
  ]);
}

export function buildSigningPayload(input: SigningInput): string {
  const fields: string[] = [input.method];

  if (input.hostIp !== undefined) fields.push(input.hostIp);

  fields.push('', 'text/json', input.authorization, input.timestamp, input.varString);
  return fields.join('+');
}

export function signRequest(input: SigningInput, secretKey: string): string {
  return createHmac('sha512', secretKey).update(buildSigningPayload(input), 'utf8').digest('hex');
}

export function signedHeaders(
  credentials: AroFloCredentials,
  method: 'GET' | 'POST',
  varString: string,
  now: Date
): Record<string, string> {
  const authorization = buildAuthorization(credentials);
  const timestamp = now.toISOString();
  const signingInput: SigningInput = {
    method,
    authorization,
    timestamp,
    varString,
    ...(credentials.hostIp === undefined ? {} : { hostIp: credentials.hostIp })
  };
  const headers: Record<string, string> = {
    Authentication: `HMAC ${signRequest(signingInput, credentials.secretKey)}`,
    afdatetimeutc: timestamp
  };

  if (credentials.hostIp !== undefined) headers.HostIP = credentials.hostIp;
  return headers;
}
