/**
 * `repeatable` primitive — a marker. The actual cardinality + heading-
 * claim logic lives in the body orchestrator (`applyBodySchema`); this
 * file exists so meta-validation recognises `repeatable` as a known
 * section-rules key and `PRIMITIVES.repeatable(...)` can still be
 * called as a no-op.
 */

function validate(_value, _param, _ctx) {
  return [];
}

export const repeatablePrimitive = {
  name: "repeatable",
  validate,
};
