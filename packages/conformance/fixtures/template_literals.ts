/** Template literal stress for conformance (nested, tagged, interpolation edges). */
export function templateFixture(): string {
  const tagged = String.raw`tagged-${1 + 2}`;
  const nested = `outer ${`inner ${42}`} end`;
  return `${tagged}:${nested}`;
}
