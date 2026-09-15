import { describe, expect, it } from 'vitest';
import { buildAuthorization, buildSigningPayload, signRequest, signedHeaders } from '../../src/aroflo/auth.js';

const credentials = {
  uEncoded: 'user+id==',
  pEncoded: 'api/key',
  orgEncoded: 'org id==',
  secretKey: 'unit-test-secret'
};

const timestamp = '2026-09-10T00:00:00.000Z';
const authorization = 'uencoded=user%2Bid%3D%3D&pencoded=api%2Fkey&orgEncoded=org%20id%3D%3D';
const varString = 'zone=tasks&page=1';
const digest =
  '1b4306f8c1826a35b0fca16df406ef7c91dae7281f73d29223c1afa6566628208227bb3a32b803f0a8d8aa1197c79eb4c141473528fdd238eae072a1f38782e6';

describe('AroFlo request signing', () => {
  it('matches the independently calculated SHA-512 fixture', () => {
    const payload = `GET++text/json+${authorization}+${timestamp}+${varString}`;

    expect(buildAuthorization(credentials)).toBe(authorization);
    expect(buildSigningPayload({ method: 'GET', authorization, timestamp, varString })).toBe(payload);
    expect(signRequest({ method: 'GET', authorization, timestamp, varString }, credentials.secretKey)).toBe(digest);
  });

  it('includes HostIP in the signing payload only when configured', () => {
    expect(
      buildSigningPayload({ method: 'POST', hostIp: '203.0.113.50', authorization, timestamp, varString })
    ).toBe(`POST+203.0.113.50++text/json+${authorization}+${timestamp}+${varString}`);
    expect(buildSigningPayload({ method: 'POST', authorization, timestamp, varString })).toBe(
      `POST++text/json+${authorization}+${timestamp}+${varString}`
    );
  });

  it('uses the injected UTC clock and includes HostIP only when configured in headers', () => {
    expect(signedHeaders(credentials, 'GET', varString, new Date(timestamp))).toEqual({
      Authentication: `HMAC ${digest}`,
      Authorization: authorization,
      Accept: 'text/json',
      afdatetimeutc: timestamp
    });

    expect(
      signedHeaders({ ...credentials, hostIp: '203.0.113.50' }, 'GET', varString, new Date(timestamp))
    ).toMatchObject({
      Authorization: authorization,
      Accept: 'text/json',
      afdatetimeutc: timestamp,
      HostIP: '203.0.113.50'
    });
  });
});
