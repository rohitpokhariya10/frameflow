import { describe, expect, it } from 'vitest';
import { brandInWords, namesName, namesWord, seedBrandOf, seedNamesOf } from './brands.js';

// The brand the user's own words name, read locally: written out, or by a product line of exactly one brand.
describe('brands named in the user\'s own words', () => {
  it('finds a brand written out, in any case, as a whole word', () => {
    expect(brandInWords('Xiaomi phone')).toEqual({ brand: 'Xiaomi', via: 'brand' });
    expect(brandInWords('a slim xiaomi smartphone in blue')).toEqual({ brand: 'Xiaomi', via: 'brand' });
    expect(brandInWords('OnePlus 12')).toEqual({ brand: 'OnePlus', via: 'brand' });
  });

  it('reads a product line as its one brand, and a line with its own brand as one brand', () => {
    expect(brandInWords('Galaxy S24 Ultra')).toEqual({ brand: 'Samsung', via: 'line', line: 'Galaxy' });
    expect(brandInWords('Redmi Note 13')).toEqual({ brand: 'Xiaomi', via: 'line', line: 'Redmi' });
    expect(brandInWords('an iPhone 16 Pro')).toEqual({ brand: 'Apple', via: 'line', line: 'iPhone' });
    expect(brandInWords('Samsung Galaxy Z Flip')).toEqual({ brand: 'Samsung', via: 'brand' });
  });

  it('never finds a brand inside another word, nor an everyday word used as a word', () => {
    for (const text of ['minimal opposite pineapple phone', 'a phone in apple green', 'galaxy-print phone case', 'a lava lamp', 'pixel art cushion', 'red honor badge', 'Apple-green bottle'])
      expect(brandInWords(text), text).toBeUndefined();
    expect(namesWord('minimal', 'Mi')).toBe(false);
    expect(brandInWords('an Apple phone')).toEqual({ brand: 'Apple', via: 'brand' });
  });

  it('reports words naming two brands as ambiguous instead of choosing one', () => {
    expect(brandInWords('Xiaomi phone that looks like an iPhone')).toEqual({ ambiguous: ['Xiaomi', 'Apple'] });
    expect(brandInWords('')).toBeUndefined();
    expect(brandInWords('a brand-new phone')).toBeUndefined();
  });
});

describe('a brand\'s other names (short forms, product lines), for cleaning up an old brand', () => {
  it('a short form or a name taken from a model counts only as written or in capitals, never as an everyday word', () => {
    expect(namesName('Mi fans day', 'Mi')).toBe(true);
    expect(namesName('MI FANS DAY', 'Mi')).toBe(true);
    expect(namesName('hola mi amigo', 'Mi')).toBe(false);
    expect(namesName('minimal design', 'Mi')).toBe(false);
    expect(namesName('The Kestrel collection', 'Kestrel', true)).toBe(true);
    expect(namesName('KESTREL WEEK', 'Kestrel', true)).toBe(true);
    expect(namesName('a kestrel in flight', 'Kestrel', true)).toBe(false);
    expect(namesName('REDMI DAYS', 'Redmi')).toBe(true); // an ordinary line name, in any case
  });

  it('the seed knows which brand a line or short form belongs to, and a brand\'s other names', () => {
    expect(seedBrandOf('Redmi')).toBe('Xiaomi');
    expect(seedBrandOf('mi')).toBe('Xiaomi');
    expect(seedBrandOf('Velora')).toBeUndefined();
    expect(seedNamesOf('Xiaomi')).toEqual({ aliases: ['Mi'], lines: ['Redmi', 'Poco', 'Mijia'] });
    expect(seedNamesOf('Velora')).toEqual({ aliases: [], lines: [] });
  });

  it('a brand mark the image shows that is a line or short form of a brand is that brand, never a second one', () => {
    const seen = ['Xiaomi', 'Redmi', 'mi'];
    expect(brandInWords('Redmi Note 14', seen)).toEqual({ brand: 'Xiaomi', via: 'line', line: 'Redmi' });
    expect(brandInWords('Mi 14 phone', seen)).toEqual({ brand: 'Xiaomi', via: 'brand' });
    expect(brandInWords('a phone for mi familia', seen)).toBeUndefined();
  });
});
