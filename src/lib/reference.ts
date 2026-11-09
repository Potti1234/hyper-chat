import { Equal, Hash } from 'effect'

/** Large immutable collections are already versioned by reference. Wrapping
 * them keeps hyper-effect's value-based deps from walking every off-screen row.
 * The referenced Model field remains a complete dependency of the region. */
class ReferenceDependency implements Equal.Equal {
  constructor(readonly value: object) {}
  [Equal.symbol](other: Equal.Equal): boolean { return this === other }
  [Hash.symbol](): number { return Hash.random(this) }
}
const references = new WeakMap<object, ReferenceDependency>()
export const referenceDependency = (value: object): ReferenceDependency => {
  let reference = references.get(value)
  if (reference === undefined) { reference = new ReferenceDependency(value); references.set(value, reference) }
  return reference
}
