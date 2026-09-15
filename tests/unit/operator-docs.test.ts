import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('operator documentation', () => {
  it('states that create and update discovery is joint while each area still validates its operation', async () => {
    const readme = await readFile('README.md', 'utf8');

    expect(readme).toContain('both `aroflo_create_record` and `aroflo_update_record` appear together');
    expect(readme).toContain('Each selected area still validates whether create or update is supported');
  });

  it('shows how to add a separately extracted delivery tree to the secret scan', async () => {
    const deployment = await readFile('DEPLOYMENT.md', 'utf8');

    expect(deployment).toContain('pnpm scan:secrets -- C:\\path\\to\\extracted-delivery');
    expect(deployment).toContain('Scan the extracted tree, not the archive file itself');
  });
});
