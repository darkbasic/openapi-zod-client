import type { ReferenceObject, SchemaObject } from "openapi3-ts";

import { isReferenceObject } from "./isReferenceObject";
import type { DocumentResolver } from "./makeSchemaResolver";
import { acceptsScalarBounds } from "./scalarBounds";
import { isPrimitiveType } from "./utils";

export const hasNullableObjectType = (schema: SchemaObject | ReferenceObject) => {
    if (isReferenceObject(schema) || !schema.nullable) return false;
    const type = Array.isArray(schema.type) && schema.type.length === 1 ? schema.type[0] : schema.type;
    return type === "object";
};

// Typed objects handle null in their base validators. On composed objects the other constraints must still match.
export const needsNullableChain = (schema: SchemaObject | ReferenceObject) =>
    "nullable" in schema &&
    !!schema.nullable &&
    !hasNullableObjectType(schema) &&
    !("type" in schema && schema.type && (schema.oneOf || schema.anyOf || schema.allOf)) &&
    (!("enum" in schema) || schema.enum?.includes(null));

export const isObjectOrNull = (type: SchemaObject["type"]) =>
    Array.isArray(type) &&
    type.includes("object") &&
    type.includes("null") &&
    type.every((kind) => kind === "object" || kind === "null");

type Schema = SchemaObject | ReferenceObject;
type SchemaAssertions = SchemaObject & {
    $ref?: string;
    const?: unknown;
    if?: Schema | boolean;
    then?: Schema | boolean;
    else?: Schema | boolean;
};
type NullMatch = boolean | "unknown";

const schemaAnnotations = [
    "default",
    "title",
    "description",
    "example",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
];
// The static references have already been resolved. These keywords do not validate the JSON instance.
const nonAssertionKeys = new Set([
    ...schemaAnnotations,
    "$ref",
    "$comment",
    "$id",
    "$schema",
    "$vocabulary",
    "$anchor",
    "$dynamicAnchor",
    "$defs",
    "contentEncoding",
    "contentMediaType",
    "contentSchema",
    "externalDocs",
    "xml",
]);
const scalarAssertionKeys = [
    "type",
    "enum",
    "const",
    "nullable",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
];
const exactNegationKeys = new Set([...scalarAssertionKeys, "multipleOf", "minItems", "maxItems"]);

const everyMatch = (matches: NullMatch[]): NullMatch =>
    matches.includes(false) ? false : matches.includes("unknown") ? "unknown" : true;

const exactlyOneMatch = (matches: NullMatch[]): NullMatch => {
    const definite = matches.filter((match) => match === true).length;
    if (definite > 1) return false;
    return matches.includes("unknown") ? "unknown" : definite === 1;
};

// Only the selected branch constrains null. A branch without a schema imposes no restriction.
function conditionalNullMatch(schema: SchemaAssertions, visit: (branch: Schema) => NullMatch): NullMatch {
    const match = (branch: Schema | boolean | undefined): NullMatch =>
        typeof branch === "boolean" ? branch : branch ? visit(branch) : true;
    const condition = match(schema.if);
    if (condition !== "unknown") return match(condition ? schema.then : schema.else);
    const yes = match(schema.then);
    return yes === match(schema.else) ? yes : "unknown";
}

// Evaluate null itself. Object, array and string validation keywords have no effect on that instance.
export function acceptsNull(schema: Schema, resolver?: DocumentResolver, seen = new Set<Schema>()): NullMatch {
    if (seen.has(schema)) return "unknown";
    seen.add(schema);
    const visit = (child: Schema) => acceptsNull(child, resolver, seen);
    const local: SchemaAssertions = { ...schema };
    const assertions: NullMatch[] = [];
    if (isReferenceObject(schema)) {
        const target = resolver?.getSchemaByRef(schema.$ref);
        assertions.push(target ? visit(target) : "unknown");
        if (!resolver?.supportsSchemaRefSiblings) {
            seen.delete(schema);
            return assertions[0]!;
        }
    }

    if (resolver?.supportsSchemaRefSiblings && local.if !== undefined) {
        assertions.push(conditionalNullMatch(local, visit));
    }

    if ("$dynamicRef" in local || "$recursiveRef" in local) assertions.push("unknown");

    const types = Array.isArray(local.type) ? local.type : local.type ? [local.type] : [];
    if (types.length > 0) {
        // 3.0 documents also use explicit null enum members on otherwise nonnullable scalar types.
        const hasLegacyEnum =
            !resolver?.supportsSchemaRefSiblings && types.every(isPrimitiveType) && local.enum?.includes(null);
        assertions.push(types.includes("null") || !!local.nullable || !!hasLegacyEnum);
    }

    if (local.enum) assertions.push(local.enum.includes(null));
    if (Object.hasOwn(local, "const")) assertions.push(local.const === null);
    if (local.oneOf) assertions.push(exactlyOneMatch(local.oneOf.map(visit)));
    if (local.anyOf) {
        const matches = new Set(local.anyOf.map(visit));
        assertions.push(matches.has(true) || (matches.has("unknown") ? "unknown" : false));
    }

    if (local.allOf) assertions.push(everyMatch(local.allOf.map(visit)));
    if (local.not) {
        const isExcluded = visit(local.not);
        assertions.push(isExcluded === "unknown" ? "unknown" : !isExcluded);
    }

    seen.delete(schema);
    return everyMatch(assertions);
}

// A plain Zod union already handles zero or one nullable option. Only ambiguous or unresolved counts need a guard.
export function oneOfNullGuard(schema: SchemaObject, resolver?: DocumentResolver) {
    if (!schema.oneOf || schema.oneOf.length < 2) return;
    const matches = schema.oneOf.map((branch) => acceptsNull(branch, resolver));
    const isExact = exactlyOneMatch(matches);
    if (isExact === "unknown") return;
    return !isExact && matches.includes(true) ? "exclude" : undefined;
}

export function schemaNegation(schema: Schema, resolver?: DocumentResolver) {
    const local: SchemaAssertions = { ...schema };
    if (
        resolver?.supportsSchemaRefSiblings &&
        local.if !== undefined &&
        conditionalNullMatch(local, (branch) => acceptsNull(branch, resolver)) === false
    ) {
        const positive = { ...local };
        delete positive.if;
        delete positive.then;
        delete positive.else;
        return { positive, excluded: { type: "null" as const }, excludesNull: true };
    }

    if (!local.not || (local.$ref && !resolver?.supportsSchemaRefSiblings)) return;
    const { not, ...positive } = local;
    // Negating a permissive approximation (e.g. an unimplemented contains) rejects valid data.
    // Only invert predicates the positive validator implements exactly. Other predicates can still decide the null case.
    if ("not" in not && not.not && Object.keys(not).length === 1) {
        return { positive: Object.keys(positive).length > 0 ? { allOf: [positive, not.not] } : not.not };
    }

    const chain = getSchemaReferenceChain(not, resolver);
    const target = chain.at(-1)!;
    let excluded: Schema | undefined;
    if (!isReferenceObject(target)) {
        if (target.enum?.length === 0) return { positive };
        // In 3.1 an assertion on any reference in the chain narrows even an empty target.
        const layers = resolver?.supportsSchemaRefSiblings ? chain : [target];
        const keys = layers
            .flatMap((layer) => Object.keys(layer))
            .filter((key) => !nonAssertionKeys.has(key) && !key.startsWith("x-"));
        if (keys.length === 0) return { positive: { enum: [] } };
        if (keys.every((key) => exactNegationKeys.has(key))) excluded = not;
    }

    const shouldExcludeNull = acceptsNull(not, resolver) === true;
    if (!excluded && !shouldExcludeNull && positive.type) return { positive };
    return { positive, excluded, excludesNull: shouldExcludeNull };
}

// The reference owns the parsed value. A sibling can validate supplied fields, even fields the base strips.
export const hasStructuralKeywords = (schema: SchemaObject) =>
    schema.properties !== undefined ||
    schema.required !== undefined ||
    schema.items !== undefined ||
    schema.additionalProperties !== undefined;

// A structural literal describes the input. The parsed object may gain defaults or lose unknown keys.
export const hasStructuralLiteral = (schema: SchemaAssertions) =>
    (Object.hasOwn(schema, "const") ? [schema.const] : schema.enum ?? []).some(
        (value) => value !== null && typeof value === "object"
    );

export const hasUntypedValueChecks = (schema: SchemaObject) =>
    schema.format === "hostname" ||
    schema.pattern !== undefined ||
    schema.minLength !== undefined ||
    schema.maxLength !== undefined ||
    schema.minItems !== undefined ||
    schema.maxItems !== undefined ||
    schema.minimum !== undefined ||
    schema.maximum !== undefined ||
    schema.exclusiveMinimum !== undefined ||
    schema.exclusiveMaximum !== undefined ||
    schema.multipleOf !== undefined;

function splitLiteralAssertions(siblings: SchemaAssertions): SchemaAssertions[] | undefined {
    if (!siblings.enum) return;
    if (Object.hasOwn(siblings, "const")) {
        const { const: value, ...base } = siblings;
        return [base, { const: value }];
    }

    const types = Array.isArray(siblings.type) ? siblings.type : [siblings.type];
    // A structural validator checks the members of an object/array, while enum checks its full JSON value.
    if (!types.includes("object") && !types.includes("array") && !siblings.properties && !siblings.items) return;
    const { enum: values, ...base } = siblings;
    return [base, { enum: values }];
}

// A reference or composition and its sibling assertions constrain the same instance.
export function schemaAssertionParts(schema: Schema, resolver?: DocumentResolver): SchemaAssertions[] | undefined {
    const local: SchemaAssertions = { ...schema };
    const { $ref, oneOf, anyOf, allOf, discriminator, ...siblings } = local;
    if ($ref && !resolver?.supportsSchemaRefSiblings) return;
    const parts: SchemaAssertions[] = [];
    if ($ref) parts.push({ $ref });
    if (oneOf) parts.push(discriminator ? { oneOf, discriminator } : { oneOf });
    if (anyOf) parts.push({ anyOf });
    if (allOf) parts.push({ allOf });
    if (parts.length === 0) return splitLiteralAssertions(siblings);

    const hasValueAssertions =
        ["enum", "const", "properties", "required", "additionalProperties", "items"].some((key) =>
            Object.hasOwn(siblings, key)
        ) || hasUntypedValueChecks(siblings);

    // The enclosing type adds no constraint if every branch already declares it. Keep the
    // underlying ZodObject / ZodDiscriminatedUnion available to callers in this common case.
    const branches = oneOf ?? anyOf ?? allOf;
    const isAlreadyTyped =
        !hasValueAssertions &&
        !$ref &&
        typeof siblings.type === "string" &&
        branches?.every((branch) => {
            const target = getSchemaReferenceChain(branch, resolver).at(-1);
            return (
                target &&
                !isReferenceObject(target) &&
                target.type === siblings.type &&
                (siblings.nullable || acceptsNull(branch, resolver) === false)
            );
        });
    if (hasValueAssertions || (siblings.type && !isAlreadyTyped)) {
        if (
            $ref &&
            !siblings.format &&
            getSchemaReferenceChain(schema, resolver).some((layer) => "format" in layer && layer.format === "binary")
        ) {
            siblings.format = "binary";
        }

        parts.push(siblings);
    }

    return parts.length > 1 ? parts : undefined;
}

// openapi3-ts also reads 3.1 documents, although its schema interface omits the const keyword.
export function normalizeLiteralAssertion(
    schema: SchemaAssertions,
    resolver?: DocumentResolver
): SchemaObject | undefined {
    if (Object.hasOwn(schema, "const")) {
        const { const: value, ...rest } = schema;
        return { ...rest, enum: [value] };
    }

    if (resolver?.supportsSchemaRefSiblings && schema.type && !schema.nullable && schema.enum?.includes(null)) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.includes("null")) return { ...schema, enum: schema.enum.filter((value) => value !== null) };
    }

    return undefined;
}

export const isUntypedStructural = (schema: Schema): boolean =>
    !isReferenceObject(schema) &&
    !schema.type &&
    !schema.oneOf &&
    !schema.anyOf &&
    !schema.allOf &&
    !schema.not &&
    ["properties", "required", "additionalProperties", "items"].some((key) => Object.hasOwn(schema, key));

// In a composition, structural keywords constrain only the applicable JSON instances. An explicit
// object bound elsewhere in the intersection lets us discard the other alternatives up front.
export function applicableStructuralOperand(schema: Schema): Schema {
    return isUntypedStructural(schema)
        ? { ...schema, type: ["object", "array", "string", "number", "boolean", "null"] }
        : schema;
}

export function intersectionOperands<T extends Schema>(
    operands: T[],
    resolver?: DocumentResolver
): Array<T | SchemaObject> {
    if (!operands.some(isUntypedStructural)) return operands;
    const bound = operands.find((branch) => {
        const target = getSchemaReferenceChain(branch, resolver).at(-1);
        return target && !isReferenceObject(target) && (target.type === "object" || isObjectOrNull(target.type));
    });
    if (!bound) return operands;
    const isNullable = acceptsNull(bound, resolver) !== false;
    return operands.map((branch) =>
        isUntypedStructural(branch) ? { ...branch, type: "object", nullable: isNullable } : branch
    );
}

// Composition branches are emitted without a property's presence chain. Supply the null case
// for a 3.0 scalar or an inferred object when its standalone base validator would omit it.
export function needsCompositionBranchNull(schema: Schema, resolver?: DocumentResolver): boolean {
    const target = getSchemaReferenceChain(schema, resolver).at(-1);
    if (!target || isReferenceObject(target) || target.oneOf || target.anyOf || target.allOf) return false;
    const needsNull =
        (needsNullableChain(target) && !target.enum?.includes(null)) ||
        (!target.type && !!(target.properties ?? target.additionalProperties));
    return needsNull && !schemaAssertionParts(schema, resolver) && acceptsNull(schema, resolver) === true;
}

// Keep reference siblings and their targets as distinct schemas, ordered from the use site inward.
export function getSchemaReferenceChain(schema: SchemaObject | ReferenceObject, resolver?: DocumentResolver) {
    const chain = [schema];
    const visited = new Set<string>();
    while (isReferenceObject(schema) && resolver && !visited.has(schema.$ref)) {
        visited.add(schema.$ref);
        schema = resolver.getSchemaByRef(schema.$ref);
        if (!schema) break;
        chain.push(schema);
    }

    return chain;
}

// Include object keys independently of insertion order when comparing JSON literals.
function sameLiteral(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (
        !left ||
        !right ||
        typeof left !== "object" ||
        typeof right !== "object" ||
        Array.isArray(left) !== Array.isArray(right)
    )
        return false;
    const entries = Object.entries(left);
    return (
        entries.length === Object.keys(right).length &&
        entries.every(([key, item]) => Object.hasOwn(right, key) && sameLiteral(item, Reflect.get(right, key)))
    );
}

const provenScalarKeys = new Set(["$ref", ...scalarAssertionKeys, "pattern", ...schemaAnnotations]);

function excludesLiteral(schema: Schema, candidate: unknown) {
    const local: SchemaAssertions = { ...schema };
    const kind = Array.isArray(candidate) ? "array" : typeof candidate;
    const types = Array.isArray(local.type) ? local.type : local.type ? [local.type] : [];
    return (
        (candidate !== null &&
            types.length > 0 &&
            !types.some((type) => type === kind || (type === "integer" && Number.isInteger(candidate)))) ||
        (local.enum && !local.enum.some((literal) => sameLiteral(literal, candidate))) ||
        (Object.hasOwn(local, "const") && !sameLiteral(local.const, candidate))
    );
}

// Defaults are annotations on individual layers. OAS 3.0 ignores every sibling of a reference.
// Array items only apply a default declared on the item itself, never a component default.
export function useSiteDefault(
    schema: Schema,
    resolver?: DocumentResolver,
    site?: "arrayItem" | "dictionaryEntry",
    hasCustomRefiner = false
) {
    if (!isReferenceObject(schema))
        return schema.default === undefined ? undefined : { owner: schema, needsCheck: false };
    if (!resolver || (site === "arrayItem" && !resolver.supportsSchemaRefSiblings)) return;
    const chain = getSchemaReferenceChain(schema, resolver);
    // A named property only inherits from its immediate target. Walking aliases here can
    // reapply an object default to its own optional child indefinitely.
    const inherited = site === "dictionaryEntry" ? chain.slice(1) : chain.slice(1, 2);
    const layers =
        site === "arrayItem"
            ? [schema]
            : resolver.supportsSchemaRefSiblings
            ? [schema, ...inherited]
            : inherited.filter((layer) => !isReferenceObject(layer));
    const owner = layers.find((layer): layer is SchemaObject => "default" in layer && layer.default !== undefined);
    if (!owner) return;
    const needsCheck =
        resolver.supportsSchemaRefSiblings &&
        (isReferenceObject(owner) ||
            chain.some(
                (layer) =>
                    isReferenceObject(layer) &&
                    (schemaAssertionParts(layer, resolver) || schemaNegation(layer, resolver))
            ));
    // A literal outside a finite domain can never supply a missing input. Other refinements
    // are checked by the generated parser so defaults follow exactly the same validation as supplied values.
    if (!needsCheck) return { owner, needsCheck: false };
    // A caller-supplied refiner can replace assertions at emission time.
    if (hasCustomRefiner) return { owner, needsCheck: true };
    const candidate = owner.default;
    if (chain.some((layer) => excludesLiteral(layer, candidate))) return;
    const nullable = candidate === null && acceptsNull(schema, resolver);
    if (candidate === null && nullable === false && !("nullable" in schema && schema.nullable)) return;

    // The emitter and proof share the same scalar bounds. If these checks exhaust the
    // assertions, a compatible default guarantees a required parsed property.
    const isPlainScalar =
        (nullable === true || ["string", "boolean", "number"].includes(typeof candidate)) &&
        chain.every((layer) => Object.keys(layer).every((key) => provenScalarKeys.has(key)));
    // A format or composition can change how a sibling's keywords apply (e.g. binary
    // references suppress text constraints). Only run the bounds proof on a fully known chain.
    if (!isPlainScalar) return { owner, needsCheck: true };
    if (chain.some((layer) => !acceptsScalarBounds({ ...layer }, candidate))) return;
    return { owner, needsCheck: false };
}

// An object can require keys whose value schemas are supplied by a sibling in allOf.
export const requiredAdditionalKeys = (schema: SchemaObject): string[] =>
    (schema.required ?? []).filter((key) => !Object.hasOwn(schema.properties ?? {}, key));

export const hasImpossibleRequiredKey = (schema: SchemaObject, keys = requiredAdditionalKeys(schema)): boolean =>
    keys.length > 0 && schema.additionalProperties === false && !("patternProperties" in schema);
