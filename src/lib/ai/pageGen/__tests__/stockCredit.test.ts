import { describe, expect, it } from 'vitest';
import { hasStockCredit, stockCreditProps, withoutStockCredit } from '../stockCredit';

const credit = {
  photoId: 'a',
  photographerName: 'Ana',
  photographerUrl: 'https://unsplash.com/@ana?utm_source=lumitra&utm_medium=referral',
  unsplashUrl: 'https://unsplash.com/?utm_source=lumitra&utm_medium=referral',
};

describe('stock photo credit props', () => {
  it('writes a visible title plus the linked credit attributes', () => {
    expect(stockCreditProps(credit)).toEqual({
      title: 'Photo by Ana on Unsplash',
      'data-credit-name': 'Ana',
      'data-credit-url': credit.photographerUrl,
      'data-credit-source-url': credit.unsplashUrl,
    });
  });

  it('removes the credit (and its title) when the image is replaced', () => {
    const props = { src: 'https://images.unsplash.com/x', alt: 'A', style: { width: '1px' }, ...stockCreditProps(credit) };
    expect(hasStockCredit(props)).toBe(true);
    expect(withoutStockCredit(props)).toEqual({ src: 'https://images.unsplash.com/x', alt: 'A', style: { width: '1px' } });
  });

  it('leaves props without a credit alone, including a user title', () => {
    const props = { src: '/a.jpg', title: 'My own tooltip' };
    expect(withoutStockCredit(props)).toBe(props);
  });
});
