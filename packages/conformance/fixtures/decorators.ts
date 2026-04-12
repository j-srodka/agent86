/** Class decorator for conformance (grammar must parse cleanly). */
function logClass(_constructor: Function) {}

@logClass
export class Decorated {
  m(): void {}
}

export function expose(): typeof Decorated {
  return Decorated;
}
