import { describe, expect, it } from 'vitest';

import { exportedNames } from './exports';

describe('exportedNames', () => {
  it('finds default, const, let, function, class, interface, type and enum exports', () => {
    const source = `
export default App;
export const alpha = 1;
export let beta = 2;
export function gamma() {}
export async function delta() {}
export class Epsilon {}
export abstract class Zeta {}
export interface Eta {}
export type Theta = string;
export enum Iota { A }
export const enum Kappa { B }
`;
    expect(exportedNames(source)).toEqual([
      'App',
      'Epsilon',
      'Eta',
      'Iota',
      'Kappa',
      'Theta',
      'Zeta',
      'alpha',
      'beta',
      'delta',
      'gamma',
    ]);
  });

  it('finds names in an export { a, b as c } list', () => {
    const source = `
const a = 1;
const b = 2;
export { a, b as c };
export type { Foo, Bar as Baz } from './types';
export {
  multi,
  line as renamed,
};
`;
    expect(exportedNames(source)).toEqual(['Baz', 'Foo', 'a', 'c', 'multi', 'renamed']);
  });

  it('answers [] for unparseable content and never throws', () => {
    expect(exportedNames('')).toEqual([]);
    expect(exportedNames('\u0000�{{{ not code')).toEqual([]);
    expect(exportedNames('export')).toEqual([]);
    expect(exportedNames('export {')).toEqual([]);
    expect(exportedNames(undefined as unknown as string)).toEqual([]);
  });

  it('answers sorted unique names', () => {
    const source = `
export const z = 1;
export const a = 2;
export { z, a };
export function a() {}
`;
    expect(exportedNames(source)).toEqual(['a', 'z']);
  });
});
