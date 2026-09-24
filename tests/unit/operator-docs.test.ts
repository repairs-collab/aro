import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('operator documentation', () => {
  it('documents the complete v2 invoice boundary and exact-confirmation flow', async () => {
    const skill = await readFile('skills/aroflo-operator/SKILL.md', 'utf8');
    const readme = await readFile('README.md', 'utf8');
    const deployment = await readFile('DEPLOYMENT.md', 'utf8');
    const documentation = `${skill}\n${readme}\n${deployment}`;
    const tools = [
      'aroflo_v2_connection_status',
      'aroflo_v2_list_invoices',
      'aroflo_v2_get_invoice',
      'aroflo_v2_get_invoice_default_recipients',
      'aroflo_v2_list_invoice_line_items',
      'aroflo_v2_preview_create_invoice',
      'aroflo_v2_preview_update_invoice_line_item',
      'aroflo_v2_create_invoice',
      'aroflo_v2_update_invoice_line_item'
    ];

    for (const tool of tools) expect(skill).toContain(`\`${tool}\``);
    expect(skill).toMatch(/exact preview/i);
    expect(skill).toMatch(/explicit confirmation/i);
    for (const refused of ['delete', 'send', 'approve', 'payment', 'add-line', 'remove-line']) {
      expect(skill.toLowerCase()).toContain(refused);
    }
    expect(documentation).toContain('Never use `arfoflo_v2`; it is a typo.');
    expect(documentation).toContain('`aroflo_v2`');
    expect(readme).toMatch(/open beta/i);
    expect(readme).toContain('AROFLO_V2_API_TOKEN');
    expect(readme).toContain('AROFLO_V2_SMOKE_BUSINESS_UNIT_ID');
    expect(readme).toContain('AROFLO_WRITE_ENABLED');
    expect(readme).toContain('AROFLO_FINANCIAL_WRITES_ENABLED');
    expect(readme).toMatch(/create one invoice/i);
    expect(readme).toMatch(/update one existing invoice line item/i);
    expect(deployment).toContain('pnpm smoke:v2-read-only');
    expect(deployment).toContain('all five v2 read tools and both v2 preview tools');
    expect(deployment).toMatch(/without.*AROFLO_V2_SMOKE_BUSINESS_UNIT_ID.*healthcheck/is);
    expect(deployment).toMatch(/with.*AROFLO_V2_SMOKE_BUSINESS_UNIT_ID.*details, recipients, and lines/is);
  });

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
