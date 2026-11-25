import type { ReferenceObject, SchemaObject } from "openapi3-ts";

type SingleChild = "items" | "not" | "additionalProperties";
type Branches = "oneOf" | "anyOf" | "allOf";
type SchemaWithBooleanChildren = {
    items?: SchemaInput;
    not?: SchemaInput;
    additionalProperties?: SchemaInput;
    properties?: Record<string, SchemaInput>;
    oneOf?: SchemaInput[];
    anyOf?: SchemaInput[];
    allOf?: SchemaInput[];
} & Omit<SchemaObject, SingleChild | Branches | "properties">;
export type SchemaInput = SchemaWithBooleanChildren | ReferenceObject | boolean;

// OAS 3.1 boolean schemas are equivalent to an empty schema or an empty enum.
// Visit only schema-valued keywords. Literal/default/example booleans are instance data,
// and additionalProperties' boolean form also controls the generator's object parsing policy.
export function normalizeBooleanSchema(schema: SchemaInput, cache = new WeakMap<object, SchemaObject>()): SchemaObject {
    if (schema === true) return {};
    if (schema === false) return { enum: [] };
    const known = cache.get(schema);
    if (known) return known;

    // The object is already usable as a 3.0 schema if its schema-valued children need no conversion.
    // Copy on change so existing callers and schemaRefiner retain ordinary schema object identity.
    const input: SchemaWithBooleanChildren = { ...schema };
    const original = schema as SchemaObject;
    const result = { ...original };
    cache.set(schema, result);
    let hasChanges = false;
    const child = (value: SchemaInput) => {
        const normalized = normalizeBooleanSchema(value, cache);
        hasChanges ||= value !== normalized;
        return normalized;
    };

    if (input.items !== undefined) result.items = child(input.items);
    if (input.not !== undefined) {
        if (typeof input.not === "boolean") {
            hasChanges = true;
            delete result.not;
            if (input.not) result.enum = [];
        } else {
            result.not = child(input.not);
        }
    }

    for (const key of ["oneOf", "anyOf", "allOf"] as const) {
        const branches = input[key];
        if (branches) result[key] = branches.map(child);
    }

    if (input.allOf?.includes(true)) {
        hasChanges = true;
        const remaining = input.allOf.filter((branch) => branch !== true);
        if (remaining.length > 0) result.allOf = remaining.map(child);
        else delete result.allOf;
    }

    if (input.anyOf?.includes(true)) {
        hasChanges = true;
        delete result.anyOf;
    }

    if (input.oneOf?.includes(true)) {
        // Exactly one always-valid option means every remaining option must fail.
        hasChanges = true;
        delete result.oneOf;
        const assertions = exclusiveAlternatives(input.oneOf, child);
        if (assertions.length > 0) result.allOf = [...(result.allOf ?? []), ...assertions];
    }

    if (original.properties) {
        result.properties = Object.fromEntries(
            Object.entries(original.properties).map(([name, value]) => [name, child(value)])
        );
    }

    if (typeof original.additionalProperties === "object")
        result.additionalProperties = child(original.additionalProperties);
    const normalized = hasChanges ? result : original;
    cache.set(schema, normalized);
    return normalized;
}

// Once true supplies the one required match, exclude every remaining alternative.
// A complement of whole JSON types is representable in both the validator and the public type.
function exclusiveAlternatives(branches: SchemaInput[], child: (schema: SchemaInput) => SchemaObject): SchemaObject[] {
    if (branches.filter((branch) => branch === true).length > 1) return [{ enum: [] }];
    const others = branches.filter((branch) => typeof branch !== "boolean");
    if (others.length === 0) return [];
    const excludedTypes = new Set<string>();
    for (const branch of others) {
        if (typeof branch !== "object" || !("type" in branch) || !branch.type || Object.keys(branch).length !== 1) {
            return others.map((schema) => ({ not: child(schema) }));
        }

        const types = Array.isArray(branch.type) ? branch.type : [branch.type];
        if (types.includes("integer")) return others.map((schema) => ({ not: child(schema) }));
        for (const type of types) excludedTypes.add(type);
    }

    const kinds = ["object", "array", "string", "number", "boolean", "null"] as const;
    const types = kinds.filter((type) => !excludedTypes.has(type));
    return [types.length > 0 ? { type: types } : { enum: [] }];
}
