/**
 * Central export surface for the demo: cross-file `rename_symbol` with `cross_file: true`
 * should find many reference sites (see consumers/).
 */
export function authenticate(token: string): boolean {
  return token.length > 0;
}
