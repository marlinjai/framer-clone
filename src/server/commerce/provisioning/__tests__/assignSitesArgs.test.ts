import { describe, expect, it } from 'vitest';

import { parseAssignSitesArgs } from '../assignSitesArgs';

describe('catalogue:assign-sites arguments', () => {
  it('takes the tenant group alone as a dry run of every company', () => {
    expect(parseAssignSitesArgs(['tg_demo'])).toEqual({ tenantGroupId: 'tg_demo', companyId: undefined, apply: false });
    expect(parseAssignSitesArgs(['tg_demo', '--apply'])).toEqual({ tenantGroupId: 'tg_demo', companyId: undefined, apply: true });
  });

  it('takes --company with its value, before or after the tenant group', () => {
    const expected = { tenantGroupId: 'tg_demo', companyId: 'c1', apply: false };
    expect(parseAssignSitesArgs(['tg_demo', '--company', 'c1'])).toEqual(expected);
    expect(parseAssignSitesArgs(['--company', 'c1', 'tg_demo'])).toEqual(expected);
    expect(parseAssignSitesArgs(['tg_demo', '--company', 'c1', '--apply'])).toEqual({ ...expected, apply: true });
  });

  it.each([
    [[]],
    [['--apply']],
    [['tg_demo', 'tg_other']],
    [['tg_demo', '--company']],
    [['tg_demo', '--company', '--apply']],
    [['tg_demo', '--company', 'c1', '--company', 'c2']],
    [['tg_demo', '--aply']],
  ])('refuses %j', (args) => {
    expect(parseAssignSitesArgs(args)).toBeNull();
  });
});
