/**
 * The check on a `[native.gateways]` name, shared by the config parser and the
 * wizard. Imports nothing, so both can use it without a cycle.
 *
 * Names that cannot be a gateway are refused: an empty name, a control
 * character, an Object.prototype property name (`constructor`, `__proto__`, ...),
 * and the reserved `seeded`, which is the trust file's old marker. Every other
 * name is accepted, spaces and dots included. The lookups keyed by name are
 * own-property reads over null-prototype or `Object.hasOwn` checks, so no name
 * reaches an inherited value, and the key variable a name maps to is plain
 * (`envVarForGateway`).
 */
const RESERVED_GATEWAY_NAMES = new Set(['seeded']);

/** Why a gateway name is refused, or undefined when it may be used. */
export function gatewayNameProblem(name: string): string | undefined {
  if (name === '') return 'a gateway name must not be empty';
  if (/[\x00-\x1f\x7f]/.test(name)) return `gateway name ${JSON.stringify(name)} contains a control character`;
  if (name in Object.prototype) return `gateway name ${JSON.stringify(name)} is a JavaScript object property name, which is reserved`;
  if (RESERVED_GATEWAY_NAMES.has(name)) return `gateway name ${JSON.stringify(name)} is reserved`;
  return undefined;
}

/** Throws, naming the config, for a refused gateway name. */
export function assertGatewayName(name: string): void {
  const problem = gatewayNameProblem(name);
  if (problem !== undefined) {
    throw new Error(`sonata.toml: a [native.gateways] name is not allowed — ${problem}.`);
  }
}
