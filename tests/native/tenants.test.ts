import { describe, it, expect } from 'vitest';
import { tenantId, SONATA_PROJECT_HEADER, TenantError } from '../../src/native/tenants.js';

describe('tenantId', () => {
  it('is 12 lowercase hex chars, stable for the same path', () => {
    const id = tenantId('/home/u/proj/sonata.toml');
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(tenantId('/home/u/proj/sonata.toml')).toBe(id);
  });
  it('differs for a different path', () => {
    expect(tenantId('/a/sonata.toml')).not.toBe(tenantId('/b/sonata.toml'));
  });
  it('names the header and exports a typed error', () => {
    expect(SONATA_PROJECT_HEADER).toBe('x-sonata-project');
    expect(new TenantError('x')).toBeInstanceOf(Error);
    expect(new TenantError('x').name).toBe('TenantError');
  });
});
