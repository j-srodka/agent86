/** Same shape as `packages/ts-adapter/src/apply.test.ts` homonym case — naive rename breaks the string literal. */
export function victim(): number {
  return victim();
}
const lit = "victim";
