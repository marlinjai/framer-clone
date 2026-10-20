import { describe, expect, it } from 'vitest';
import { hasStockCredit, isSameUnsplashPhoto, stockCreditProps, withImageSrc, withoutStockCredit } from '../stockCredit';
import ComponentModel from '@/models/ComponentModel';

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

describe('editing an image that carries a stock credit', () => {
  const photo = 'https://images.unsplash.com/photo-1?ixid=x&w=480';
  const props = { src: photo, alt: 'A', ...stockCreditProps(credit) };

  it('keeps the credit while the URL still names the same photo, or is cleared mid-edit', () => {
    expect(isSameUnsplashPhoto(photo, 'https://images.unsplash.com/photo-1?w=1200 ')).toBe(true);
    expect(hasStockCredit(withImageSrc(props, 'https://images.unsplash.com/photo-1?w=1200'))).toBe(true);
    expect(hasStockCredit(withImageSrc(props, ''))).toBe(true);
  });

  it('drops the credit for a different picture', () => {
    expect(withImageSrc(props, 'https://example.com/mine.jpg')).toEqual({ src: 'https://example.com/mine.jpg', alt: 'A' });
    expect(hasStockCredit(withImageSrc(props, 'https://images.unsplash.com/photo-2'))).toBe(false);
  });

  it('drops the credit when src is bound to CMS data', () => {
    const node = ComponentModel.create({ id: 'i', type: 'img', componentType: 'host', props });
    node.setBinding('alt', { mode: 'read', source: { kind: 'static', value: 'x' } } as never);
    expect(hasStockCredit(node.props)).toBe(true);
    node.setBinding('src', { mode: 'read', source: { kind: 'static', value: 'x' } } as never);
    expect(hasStockCredit(node.props)).toBe(false);
    expect(node.props.src).toBe(photo);
  });
});
