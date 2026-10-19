// @vitest-environment node
//
// The start-time OpenFGA warning: it fires only when the URL is set and the
// pre-shared key is missing, never fails anything, and names variables only.

import { describe, it, expect, vi } from 'vitest';
import { openfgaTokenWarning, warnIfOpenfgaTokenMissing } from '../openfgaConfig';

describe('openfgaTokenWarning', () => {
  it('warns when OPENFGA_API_URL is set and OPENFGA_API_TOKEN is not', () => {
    const msg = openfgaTokenWarning({ OPENFGA_API_URL: 'http://openfga:8080' });
    expect(msg).toContain('OPENFGA_API_TOKEN');
    expect(msg).toContain('authz_unavailable');
  });

  it('treats a blank token as missing', () => {
    expect(
      openfgaTokenWarning({ OPENFGA_API_URL: 'http://openfga:8080', OPENFGA_API_TOKEN: '  ' }),
    ).not.toBeNull();
  });

  it('stays silent when the token is set', () => {
    expect(
      openfgaTokenWarning({ OPENFGA_API_URL: 'http://openfga:8080', OPENFGA_API_TOKEN: 'set' }),
    ).toBeNull();
  });

  it('stays silent when OpenFGA is not configured at all', () => {
    expect(openfgaTokenWarning({})).toBeNull();
    expect(openfgaTokenWarning({ OPENFGA_API_URL: '' })).toBeNull();
  });
});

describe('warnIfOpenfgaTokenMissing', () => {
  it('logs once through the given logger and never throws', () => {
    const warn = vi.fn();
    expect(warnIfOpenfgaTokenMissing({ OPENFGA_API_URL: 'http://openfga:8080' }, warn)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not log when nothing is wrong', () => {
    const warn = vi.fn();
    expect(
      warnIfOpenfgaTokenMissing(
        { OPENFGA_API_URL: 'http://openfga:8080', OPENFGA_API_TOKEN: 'set' },
        warn,
      ),
    ).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
