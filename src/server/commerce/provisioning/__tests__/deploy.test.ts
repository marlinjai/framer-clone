// Unit test for the wiring checks of the container start step (deploy.ts). The
// database half (current_user, the migrations) is proven in roles.itest.ts.

import { describe, expect, it } from 'vitest';

import { assertOwnerUrlShape } from '../deploy';

describe('assertOwnerUrlShape', () => {
  it('refuses an unset owner URL, naming the variable', () => {
    expect(() => assertOwnerUrlShape({ ownerUrl: undefined, appUrl: 'postgresql://a@h/db' })).toThrow(
      /COMMERCE_OWNER_DATABASE_URL is not set/,
    );
    expect(() => assertOwnerUrlShape({ ownerUrl: '', appUrl: undefined })).toThrow(/is not set/);
  });

  it('refuses a placeholder', () => {
    expect(() => assertOwnerUrlShape({ ownerUrl: 'PLACEHOLDER_REPLACE_ME', appUrl: undefined })).toThrow(
      /placeholder/,
    );
  });

  it('refuses the app URL as the owner URL', () => {
    const same = 'postgresql://commerce_app@h:5432/db';
    expect(() => assertOwnerUrlShape({ ownerUrl: same, appUrl: same })).toThrow(/never as the app role/);
  });

  it('returns a distinct, real owner URL', () => {
    const owner = 'postgresql://commerce_ddl@h:5432/db';
    expect(assertOwnerUrlShape({ ownerUrl: owner, appUrl: 'postgresql://commerce_app@h:5432/db' })).toBe(owner);
    expect(assertOwnerUrlShape({ ownerUrl: owner, appUrl: undefined })).toBe(owner);
  });
});
