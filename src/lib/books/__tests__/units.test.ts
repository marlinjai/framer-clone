import { describe, expect, it } from 'vitest';

import { date, money, moneyInput, parseMoney, parseQuantity, quantity, rate } from '../units';

describe('Books input units', () => {
  it('parses German and plain decimals into integer units', () => {
    expect(parseQuantity('1,5')).toBe(1500);
    expect(parseQuantity('2')).toBe(2000);
    expect(parseQuantity('0,125')).toBe(125);
    expect(parseMoney('80,00')).toBe(8000);
    expect(parseMoney('1.234,56')).toBe(123456);
    expect(parseMoney('1,234.56')).toBe(123456);
    expect(parseMoney('12.5')).toBe(1250);
    expect(parseMoney('80 €')).toBe(8000);
  });

  it('refuses what it cannot read exactly', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('1,234')).toBeNull(); // three decimals of a cent amount
    expect(parseQuantity('1,2345')).toBeNull();
  });

  it('formats for display and for editing', () => {
    expect(money(123456)).toBe('1.234,56 €');
    expect(moneyInput(123456)).toBe('1234,56');
    expect(quantity(1500)).toBe('1,5');
    expect(rate(700)).toBe('7 %');
    expect(date('2026-12-31')).toBe('31.12.2026');
  });
});
