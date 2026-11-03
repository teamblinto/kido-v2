/**
 * `z.toJSONSchema` of a union (`fs_edit`) is a root `anyOf` with no root `type`, which the
 * providers reject outright: "input_schema does not support oneOf, allOf, or anyOf at the top
 * level". The broker's definitions stay verbatim (contract equality), so the adapters flatten the
 * union here: every branch's properties, `required` only where every branch requires it. The
 * broker still parses the real union when the call comes back, so a mixed input is refused there.
 */
export function toInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { anyOf, ...rest } = schema;
  if (!Array.isArray(anyOf)) {
    return 'type' in schema ? schema : { type: 'object', ...schema };
  }
  const branches = anyOf as { properties?: Record<string, unknown>; required?: string[] }[];
  const properties: Record<string, unknown> = {};
  for (const branch of branches) Object.assign(properties, branch.properties);
  const required = (branches[0]?.required ?? []).filter((key) =>
    branches.every((branch) => branch.required?.includes(key)),
  );
  return { ...rest, type: 'object', properties, required };
}
