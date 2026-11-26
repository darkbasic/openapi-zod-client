import type { ReferenceObject, SchemaObject } from "openapi3-ts";
import { pick } from "pastable";

import { isReferenceObject } from "./isReferenceObject";
import type { DocumentResolver } from "./makeSchemaResolver";
import { normalizeBooleanSchema } from "./normalizeBooleanSchema";
import { acceptsScalarBounds, hasLegacyPatternDelimiters } from "./scalarBounds";
import type { TemplateContext } from "./template-context";
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

type ConditionalResolver = Pick<DocumentResolver, "supportsSchemaRefSiblings" | "getSchemaByRef">;
const conditionalKinds = ["object", "array", "string", "boolean", "null", "integer", "number"] as const;
type ConditionalKind = typeof conditionalKinds[number];

function matchingConditionalKinds(
    test: Schema | boolean,
    resolver: ConditionalResolver
): ConditionalKind[] | undefined {
    if (typeof test === "boolean") return test ? [...conditionalKinds] : [];
    const layers = getConjunctiveSchemaLayers(normalizeBooleanSchema(test), resolver, true);
    if (!layers) return;
    if (layers.some((layer) => layer.enum?.length === 0)) return [];
    if (
        !layers.every((layer) =>
            Object.keys(layer).every(
                (key) => key === "type" || key === "nullable" || nonAssertionKeys.has(key) || key.startsWith("x-")
            )
        )
    )
        return;
    return conditionalKinds.filter((kind) =>
        layers.every((layer) => {
            const types = Array.isArray(layer.type) ? layer.type : layer.type ? [layer.type] : [];
            return (
                types.length === 0 ||
                types.includes(kind) ||
                (kind === "integer" && types.includes("number")) ||
                (kind === "null" && layer.nullable)
            );
        })
    );
}

// Split a structural schema on a pure JSON-type condition. During the split, "number"
// denotes the noninteger half of the numeric domain. Recombine both halves when possible.
export function lowerStructuralConditional(
    schema: Schema,
    resolver?: ConditionalResolver,
    options?: TemplateContext["options"]
) {
    if (!resolver?.supportsSchemaRefSiblings || !Object.hasOwn(schema, "if")) return;
    const local: SchemaAssertions = { ...schema };
    const { if: test, then, else: otherwise, ...base } = local;
    if (test === undefined || base.type) return;
    if (
        !hasStructuralKeywords(base) &&
        !getConjunctiveSchemaLayers(base, resolver, true)?.some((layer) => !layer.type && hasStructuralKeywords(layer))
    )
        return;
    if ((then === undefined || then === true) && (otherwise === undefined || otherwise === true))
        return { base, allowed: {} };
    const yes = matchingConditionalKinds(test, resolver);
    if (!yes) {
        // A data-dependent condition validates the supplied JSON. The unconditional
        // schema still owns defaults, stripping and the output type.
        const condition: SchemaAssertions = pick(local, ["if", "then", "else"]);
        const raw = options?.schemaRefiner ? undefined : rawStructuralAssertion(condition, resolver);
        return raw && { base, allowed: {}, raw };
    }

    const option = (kinds: ConditionalKind[], rule: Schema | boolean | undefined): SchemaObject[] => {
        if (rule === false || kinds.length === 0) return [];
        const types = kinds.filter((kind) => kind !== "integer" || !kinds.includes("number"));
        const typed: SchemaObject = { type: types.length === 1 ? types[0]! : types };
        if (kinds.includes("number") && !kinds.includes("integer")) typed.not = { type: "integer" };
        if (rule && typeof rule === "object") typed.allOf = [normalizeBooleanSchema(rule)];
        return [typed];
    };

    const branches = [
        ...option(yes, then),
        ...option(
            conditionalKinds.filter((kind) => !yes.includes(kind)),
            otherwise
        ),
    ];
    return { base, allowed: branches.length > 1 ? { anyOf: branches } : branches[0] ?? { enum: [] } };
}

// A raw predicate can rule out entire JSON kinds. Keep those bounds in the
// generated input and output, while the raw check handles value-dependent rules.
export function structuralConditionalParser(
    schema: Schema,
    resolver?: DocumentResolver,
    options?: TemplateContext["options"]
) {
    const plan = lowerStructuralConditional(schema, resolver, options);
    if (!plan?.raw || !resolver) return plan;

    const local: SchemaAssertions = { ...schema };
    const kinds: Array<InstanceKind | "null"> = instanceKinds.filter(
        (kind) => conditionalKindMatch(local, kind, resolver) !== "never"
    );
    if (conditionalNullMatch(local, (branch) => acceptsNull(branch, resolver)) !== false) kinds.push("null");
    if (kinds.length === instanceKinds.length + 1) return plan;
    const base: SchemaObject =
        kinds.length > 0
            ? { ...plan.base, type: kinds.length === 1 ? kinds[0]! : kinds, nullable: false }
            : { enum: [] };
    return { ...plan, base };
}

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
        typeof branch === "boolean" ? branch : branch ? visit(normalizeBooleanSchema(branch)) : true;
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

const scalarKinds = ["boolean", "number", "string"] as const;
const instanceKinds = ["object", "array", ...scalarKinds] as const;
type InstanceKind = typeof instanceKinds[number];
const keywordDomains = new Map(
    Object.entries({
        object: [
            "properties",
            "additionalProperties",
            "required",
            "patternProperties",
            "minProperties",
            "maxProperties",
            "propertyNames",
            "dependentSchemas",
            "dependentRequired",
            "unevaluatedProperties",
        ],
        array: [
            "items",
            "minItems",
            "maxItems",
            "uniqueItems",
            "prefixItems",
            "contains",
            "minContains",
            "maxContains",
            "unevaluatedItems",
        ],
        number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
        string: ["minLength", "maxLength", "pattern"],
    }).flatMap(([kind, keys]) => keys.map((key) => [key, kind] as const))
);

// A reference and its siblings are a conjunction in 3.1. A composition with one option
// also asserts that option, irrespective of the composition keyword.
export function getConjunctiveSchemaLayers(
    schema: Schema,
    resolver: ConditionalResolver,
    flattenAllOf = false
): SchemaObject[] | undefined {
    const layers: SchemaObject[] = [];
    const active = new Set<string>();
    const complete = new Set<Schema>();
    const visit = (branch: Schema): boolean => {
        if (complete.has(branch)) return true;
        const positive = positiveDoubleNegation(branch, !!resolver.supportsSchemaRefSiblings);
        const { $ref, ...siblings }: SchemaAssertions = { ...(positive ?? branch) };
        const applicable: SchemaObject = $ref && !resolver.supportsSchemaRefSiblings ? {} : siblings;
        const { oneOf, anyOf, allOf, ...assertions } = applicable;
        const local: SchemaObject = assertions;
        const compositions = { allOf, anyOf, oneOf };
        const children: Schema[] = [];
        for (const key of ["allOf", "anyOf", "oneOf"] as const) {
            const options = compositions[key];
            if (!options) continue;
            if (options.length === 1 || (key === "allOf" && flattenAllOf)) children.push(...options);
            else local[key] = options;
        }

        layers.push(local);
        if ($ref) {
            if (active.has($ref)) return false;
            active.add($ref);
            const target = resolver.getSchemaByRef($ref);
            if (!target || !visit(target)) return false;
            active.delete($ref);
        }

        if (!children.every(visit)) return false;
        complete.add(branch);
        return true;
    };

    return visit(schema) ? layers : undefined;
}

function canProveKeyword(schema: SchemaObject, key: string) {
    return (
        exactNegationKeys.has(key) ||
        (key === "pattern" && schema.pattern !== undefined && !hasLegacyPatternDelimiters(schema.pattern))
    );
}

// Prove the raw membership of object/array operands independently of the parser
// which produces their value. Each distinct child/target contributes at most one
// step. Unsupported assertions and recursive re-entry retain the ordinary fallback.
type RawAssertionStep = {
    scalar: SchemaObject;
    required: string[];
    properties: Array<[string, number]>;
    additional: false | number | undefined;
    items: number | undefined;
    all: number[];
    any: number[] | undefined;
    one: number[] | undefined;
    not: number | undefined;
    condition: { test: number; yes: number; no: number } | undefined;
};

export type RawStructuralAssertion = {
    steps: RawAssertionStep[];
    root: number;
    hasUntyped: boolean;
    hasStructure: boolean;
};

// Only a closed object or an additional-value schema needs an extra check.
function rawAdditional(rule: SchemaObject["additionalProperties"], visit: (schema: Schema) => number) {
    if (typeof rule === "object") return visit(rule);
    return rule === false ? false : undefined;
}

function rawCondition(
    test: SchemaAssertions["if"],
    then: SchemaAssertions["then"],
    otherwise: SchemaAssertions["else"],
    visit: (schema: Schema) => number
): RawAssertionStep["condition"] {
    if (test === undefined || (then === undefined && otherwise === undefined)) return;
    const branch = (rule: Schema | boolean = true) => visit(normalizeBooleanSchema(rule));
    return { test: branch(test), yes: branch(then), no: branch(otherwise) };
}

function rawStructuralAssertion(schema: Schema, resolver: ConditionalResolver): RawStructuralAssertion | undefined {
    const steps: RawAssertionStep[] = [];
    const seen = new Map<Schema, number>();
    let hasStructure = false;
    let hasUntyped = false;
    let isExact = true;
    const unresolved = () => {
        isExact = false;
        return -1;
    };

    const visit = (node: Schema): number => {
        if (!isExact) return -1;
        const known = seen.get(node);
        if (known === -1) return unresolved();
        if (known !== undefined) return known;
        // Re-entering a node with no completed step means the proof is cyclic.
        seen.set(node, -1);
        const local: SchemaAssertions = { ...(positiveDoubleNegation(node) ?? node) };
        const {
            $ref,
            properties,
            required,
            additionalProperties,
            items,
            allOf,
            anyOf,
            oneOf,
            not,
            if: test,
            then,
            else: otherwise,
            ...rest
        } = local;
        const entries = Object.entries(rest).filter(([key]) => !nonAssertionKeys.has(key) && !key.startsWith("x-"));
        if (!entries.every(([key]) => canProveKeyword(rest, key))) return unresolved();
        const target = $ref ? resolver.getSchemaByRef($ref) : undefined;
        if ($ref && !target) return unresolved();

        const hasLocalStructure = hasStructuralKeywords(local);
        hasStructure ||= hasLocalStructure;
        hasUntyped ||= hasLocalStructure && !rest.type;
        const layers = [...(allOf ?? []), ...(target ? [target] : [])];
        const all = [...new Set(layers.map(visit))];
        if (
            all.length === 1 &&
            !anyOf &&
            !oneOf &&
            !not &&
            test === undefined &&
            entries.length === 0 &&
            !hasLocalStructure
        ) {
            seen.set(node, all[0]!);
            return all[0]!;
        }

        const step: RawAssertionStep = {
            scalar: Object.fromEntries(entries),
            required: required ?? [],
            all,
            any: anyOf?.map(visit),
            one: oneOf?.map(visit),
            not: not && visit(not),
            properties: Object.entries(properties ?? {}).map(([key, child]) => [key, visit(child)]),
            items: items && visit(items),
            additional: rawAdditional(additionalProperties, visit),
            condition: rawCondition(test, then, otherwise, visit),
        };
        const index = steps.push(step) - 1;
        seen.set(node, index);
        return index;
    };

    const root = visit(schema);
    return isExact ? { steps, root, hasUntyped, hasStructure } : undefined;
}

// Only use a generated parser as an assertion on raw JSON when all applicable keywords
// have exact input semantics. In particular, object parsing may fill a required default
// or strip forbidden keys. A successful parse then cannot prove the object was valid.
function hasExactRawParser(
    schema: Schema,
    resolver: DocumentResolver,
    options?: TemplateContext["options"],
    refs = new Map<string, boolean>()
): boolean {
    if (options?.schemaRefiner) return false;
    const { $ref, allOf, anyOf, oneOf, not, ...local }: SchemaAssertions = { ...schema };
    const visit = (child: Schema) => hasExactRawParser(child, resolver, options, refs);
    if ($ref) {
        if (!refs.has($ref)) {
            refs.set($ref, false);
            const target = resolver.getSchemaByRef($ref);
            if (target) refs.set($ref, visit(target));
        }

        if (!refs.get($ref)) return false;
        if (!resolver.supportsSchemaRefSiblings) return true;
    }

    // The ordinary union does not enforce general oneOf exclusivity.
    if (oneOf && oneOf.length !== 1) return false;
    const children = [...(allOf ?? []), ...(anyOf ?? []), ...(oneOf ?? [])];
    if (not) children.push(not);
    return children.every(visit) && hasExactLocalParser(local, visit, options);
}

function hasExactLocalParser(
    local: SchemaObject,
    visit: (schema: Schema) => boolean,
    options?: TemplateContext["options"]
) {
    const types = Array.isArray(local.type) ? local.type : local.type ? [local.type] : [];
    // A closed strict default rejects extra keys even when the schema permits them.
    if (
        options?.strictObjects &&
        options.additionalPropertiesDefaultValue === false &&
        (types.includes("object") || isUntypedStructural(local))
    )
        return false;
    return Object.keys(local).every((key) => {
        if (nonAssertionKeys.has(key) || key.startsWith("x-") || canProveKeyword(local, key)) return true;
        const domain = keywordDomains.get(key);
        if (domain && types.length > 0 && !types.some((type) => (type === "integer" ? "number" : type) === domain))
            return true;
        return key === "items" && !!local.items && visit(local.items);
    });
}

// "check" means a successful raw parse proves a match. "never" also guarantees the
// parser rejects the input, so that option cannot falsely make a containing union succeed.
type KindMatch = "always" | "never" | "check" | "unknown";

function localKindMatch(
    local: SchemaObject,
    kind: InstanceKind,
    resolver: DocumentResolver,
    options?: TemplateContext["options"]
): KindMatch {
    const types = Array.isArray(local.type) ? local.type : local.type ? [local.type] : [];
    const isRestricted = types.length > 0 && !types.includes(kind);
    if (isRestricted && (kind !== "number" || !types.includes("integer"))) return "never";
    const keys = Object.keys(local).filter((key) => {
        const domain = keywordDomains.get(key);
        return (
            (!domain || domain === kind) &&
            key !== "type" &&
            key !== "nullable" &&
            !nonAssertionKeys.has(key) &&
            !key.startsWith("x-")
        );
    });
    if (
        keys.some((key) =>
            key === "items"
                ? !local.items || !hasExactRawParser(local.items, resolver, options)
                : !canProveKeyword(local, key)
        )
    )
        return "unknown";
    return isRestricted || keys.length > 0 ? "check" : "always";
}

function conjunctionMatch(matches: KindMatch[]): KindMatch {
    if (matches.includes("never")) return "never";
    if (matches.includes("unknown")) return "unknown";
    return matches.includes("check") ? "check" : "always";
}

function alternativeMatch(matches: KindMatch[], exclusive: boolean): KindMatch {
    const possible = matches.filter((match) => match !== "never");
    if (possible.length < 2) return possible[0] ?? "never";
    // A generated oneOf may use an ordinary union. Its successful parse cannot prove
    // exclusivity when two of its children can match this kind.
    if (exclusive) return "unknown";
    if (possible.includes("always")) return "always";
    return possible.includes("unknown") ? "unknown" : "check";
}

function instanceMatch(
    branch: Schema,
    kind: InstanceKind,
    resolver: DocumentResolver,
    options?: TemplateContext["options"]
) {
    const refs = new Map<string, KindMatch>();
    let hasStructural = false;
    const visit = (schema: Schema): KindMatch => {
        const positive = positiveDoubleNegation(schema);
        if (positive) return visit(positive);
        const conditional = lowerStructuralConditional(schema, resolver, options);
        if (conditional) {
            hasStructural = true;
            return conjunctionMatch([visit(conditional.base), conditional.raw ? "check" : visit(conditional.allowed)]);
        }

        const { $ref, oneOf, anyOf, allOf, not, ...local }: SchemaAssertions = { ...schema };
        hasStructural ||= !local.type && hasStructuralKeywords(local);
        const matches = [localKindMatch(local, kind, resolver, options)];
        if (not) {
            const candidate = visit(not);
            const excluded = hasExactRawParser(not, resolver, options) ? candidate : "unknown";
            matches.push(excluded === "always" ? "never" : excluded === "never" ? "always" : excluded);
        }

        if ($ref) {
            if (!refs.has($ref)) {
                // A recursive re-entry has no independent proof.
                refs.set($ref, "unknown");
                const target = resolver.getSchemaByRef($ref);
                if (target) refs.set($ref, visit(target));
            }

            matches.push(refs.get($ref)!);
        }

        if (allOf) matches.push(...allOf.map(visit));
        if (anyOf) matches.push(alternativeMatch(anyOf.map(visit), false));
        if (oneOf) matches.push(alternativeMatch(oneOf.map(visit), true));
        return conjunctionMatch(matches);
    };

    const match = visit(branch);
    return { match, hasStructural };
}

function conditionalKindMatch(schema: SchemaAssertions, kind: InstanceKind, resolver: DocumentResolver): KindMatch {
    const match = (rule: Schema | boolean = true) => {
        if (typeof rule === "boolean") return rule ? "always" : "never";
        return instanceMatch(normalizeBooleanSchema(rule), kind, resolver).match;
    };

    const test = match(schema.if);
    if (test === "always") return match(schema.then);
    if (test === "never") return match(schema.else);
    const yes = match(schema.then);
    return yes === match(schema.else) ? yes : "unknown";
}

function optionMatch(
    { match, hasStructural }: ReturnType<typeof instanceMatch>,
    kind: InstanceKind,
    branch: Schema,
    rawFor: (schema: Schema) => RawStructuralAssertion | undefined
) {
    const plan =
        match !== "never" && (match === "unknown" || kind === "object" || kind === "array")
            ? rawFor(branch)
            : undefined;
    // An object parser may supply or strip fields. Check its raw membership before dispatch.
    const raw = match === "unknown" || kind === "object" ? plan : undefined;
    return {
        match: raw ? "check" : match,
        hasStructural: hasStructural || (kind === "array" && plan?.hasUntyped),
        raw,
    };
}

// Untyped structural options also match values outside the domain of their keywords.
// Use raw object dispatch only when all potentially matching options are understood.
export function structuralOneOfOverlaps(
    branches: Schema[],
    resolver?: DocumentResolver,
    options?: TemplateContext["options"]
) {
    if (!resolver?.supportsSchemaRefSiblings || options?.schemaRefiner) return [];
    const plans = new Map<Schema, RawStructuralAssertion | undefined>();
    const rawFor = (branch: Schema) => {
        if (!plans.has(branch)) plans.set(branch, rawStructuralAssertion(branch, resolver));
        return plans.get(branch);
    };

    return instanceKinds.flatMap((kind) => {
        const candidates = branches.map((branch) => instanceMatch(branch, kind, resolver, options));
        if (candidates.filter(({ match }) => match !== "never").length < 2) return [];
        if (kind !== "array" && !candidates.some(({ hasStructural }) => hasStructural)) return [];
        const matches = candidates.map((candidate, i) => optionMatch(candidate, kind, branches[i]!, rawFor));
        if (kind === "object" && matches.some(({ match, raw }) => match !== "never" && !raw)) return [];
        if (!matches.some(({ hasStructural, match }) => hasStructural && (match === "always" || match === "check")))
            return [];
        const always = matches.filter(({ match }) => match === "always").length;
        const checks = matches.flatMap(({ match, raw }, index) => (match === "check" ? [{ index, raw }] : []));
        return always + checks.length >= 2 ? [{ kind, always, checks }] : [];
    });
}

// An intersection with the remaining kinds can contain a recursive alias. A conditional
// Exclude around the recursive union would be a circular TypeScript type definition.
export function structuralOneOfDomain(overlaps: ReturnType<typeof structuralOneOfOverlaps>) {
    const excluded = new Set(overlaps.filter(({ always }) => always > 1).map(({ kind }) => kind));
    if (excluded.size === 0) return;
    return { allowsArrays: !excluded.has("array"), scalars: scalarKinds.filter((kind) => !excluded.has(kind)) };
}

// This generator parses a double negation with its positive schema. Use the same
// representation when determining which array items and required keys survive parsing.
export function positiveDoubleNegation(schema: Schema, supportsRefSiblings = true): Schema | undefined {
    if (!supportsRefSiblings && isReferenceObject(schema)) return;
    if (!("not" in schema) || !schema.not || !("not" in schema.not)) return;
    const inner = schema.not.not;
    if (!inner || Object.keys(schema.not).length !== 1) return;
    const base = { ...schema };
    delete base.not;
    const positive = positiveDoubleNegation(inner, supportsRefSiblings) ?? inner;
    return Object.keys(base).length > 0 ? { allOf: [base, positive] } : positive;
}

export function schemaNegation(schema: Schema, resolver?: DocumentResolver, options?: TemplateContext["options"]) {
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
    const doubleNegation = positiveDoubleNegation(schema, !!resolver?.supportsSchemaRefSiblings);
    if (doubleNegation) return { positive: doubleNegation };

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
        // A custom refiner can replace item schemas during emission. Keep the existing
        // scalar negations for that mode without assuming their nested parsers are exact.
        const isExact =
            resolver?.supportsSchemaRefSiblings && !options?.schemaRefiner
                ? hasExactRawParser(not, resolver, options)
                : keys.every((key) => exactNegationKeys.has(key));
        if (isExact) excluded = not;
        else if (resolver?.supportsSchemaRefSiblings && !options?.schemaRefiner) {
            const raw = rawStructuralAssertion(not, resolver);
            if (raw?.hasStructure) return { positive, raw, excludesNull: acceptsNull(not, resolver) === true };
        }
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

// Finite JSON values select their own applicable structural rules. A parser can still add
// defaults or strip fields, so keep the exact literal output only when its shape is preserved.
export function finiteStructuralAlternatives(
    schema: Schema,
    resolver?: DocumentResolver,
    options?: TemplateContext["options"]
) {
    if (!resolver?.supportsSchemaRefSiblings || isReferenceObject(schema) || !isUntypedStructural(schema)) return;
    const hasConst = Object.hasOwn(schema, "const");
    if (!hasConst && !schema.enum) return;
    const { const: constant, enum: members, ...base }: SchemaAssertions = schema;
    const values = (members ?? [constant]).filter((value) => !hasConst || sameLiteral(value, constant));
    const kinds = ["object", "array", "string", "number", "boolean", "null"] as const;
    return kinds.flatMap((type) => {
        const literals = values.filter(
            (value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value) === type
        );
        if (literals.length === 0) return [];
        const canPreserveLiteral =
            !options?.schemaRefiner &&
            literals.every((value) =>
                preservesLiteral(base, value, options?.additionalPropertiesDefaultValue !== false)
            );
        return [{ base: { ...base, type, nullable: false }, literal: { enum: literals }, canPreserveLiteral }];
    });
}

function preservesLiteral(schema: Schema | undefined, value: unknown, additionalDefault: boolean): boolean {
    if (!schema || value === null || typeof value !== "object") return true;
    if (isReferenceObject(schema) || schema.oneOf || schema.anyOf || schema.allOf || schema.not) return false;
    if (Array.isArray(value)) return value.every((item) => preservesLiteral(schema.items, item, additionalDefault));
    const properties = schema.properties ?? {};
    // An absent declared property may acquire a default, including through a reference.
    if (Object.keys(properties).some((key) => !Object.hasOwn(value, key))) return false;
    const additional = schema.additionalProperties ?? additionalDefault;
    return Object.entries(value).every(([key, item]) => {
        if (Object.hasOwn(properties, key)) return preservesLiteral(properties[key], item, additionalDefault);
        return typeof additional === "boolean" ? additional : preservesLiteral(additional, item, additionalDefault);
    });
}

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
export function normalizeValueSchema(schema: SchemaAssertions, resolver?: DocumentResolver): SchemaObject | undefined {
    if (Object.hasOwn(schema, "const")) {
        const { const: value, ...rest } = schema;
        return { ...rest, enum: [value] };
    }

    if (resolver?.supportsSchemaRefSiblings && schema.type && !schema.nullable && schema.enum?.includes(null)) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.includes("null")) return { ...schema, enum: schema.enum.filter((value) => value !== null) };
    }

    if (!resolver?.supportsSchemaRefSiblings) return;
    const structural = structuralTypeUnion(schema);
    if (!structural || schema.if === undefined || !(schema.properties || schema.additionalProperties))
        return structural;

    // An unsupported condition previously used the ordinary object parser. Admit another
    // JSON kind only if the conditional is guaranteed to accept that kind.
    const kinds = instanceKinds.filter(
        (kind) => kind === "object" || conditionalKindMatch(schema, kind, resolver) === "always"
    );
    const canAcceptNull = conditionalNullMatch(schema, (branch) => acceptsNull(branch, resolver)) === true;
    return { ...schema, type: canAcceptNull ? [...kinds, "null"] : kinds };
}

export const isUntypedStructural = (schema: Schema): boolean =>
    !isReferenceObject(schema) &&
    !schema.type &&
    !schema.oneOf &&
    !schema.anyOf &&
    !schema.allOf &&
    !schema.not &&
    ["properties", "required", "additionalProperties", "items"].some((key) => Object.hasOwn(schema, key));

// Each structural keyword constrains only its applicable JSON type.
export function structuralTypeUnion(schema: Schema, resolver?: DocumentResolver): SchemaObject | undefined {
    if (lowerStructuralConditional(schema, resolver)) return;
    if (resolver?.supportsSchemaRefSiblings && ("enum" in schema || "const" in schema)) return;
    return isUntypedStructural(schema)
        ? { ...schema, type: ["object", "array", "string", "number", "boolean", "null"] }
        : undefined;
}

export function intersectionOperands<T extends Schema>(
    operands: T[],
    resolver: DocumentResolver | undefined,
    canDropInapplicable: boolean
): Array<T | SchemaObject> {
    // In explicit allOf, only parsers whose keywords apply can contribute fields to the result.
    // Merging an identity parser can otherwise restore fields another parser stripped.
    if (canDropInapplicable && resolver?.supportsSchemaRefSiblings && operands.length > 1) {
        const layers = operands.map((operand) => getConjunctiveSchemaLayers(operand, resolver));
        const domains = layers.map((chain) => {
            if (!chain?.some(hasStructuralKeywords)) return;
            const keys = chain
                .flatMap(Object.keys)
                .filter((key) => !nonAssertionKeys.has(key) && !key.startsWith("x-"));
            return keys.every((key) => keywordDomains.has(key))
                ? new Set(keys.map((key) => keywordDomains.get(key)!))
                : undefined;
        });
        const bound = (["array", "object"] as const).find((kind) =>
            layers.some((chain) =>
                chain?.some(
                    ({ type }) =>
                        type === kind ||
                        (Array.isArray(type) && type.includes(kind) && type.every((t) => t === kind || t === "null"))
                )
            )
        );
        if (bound) {
            operands = operands.filter((_operand, i) => !domains[i] || domains[i]!.has(bound));
        } else if (domains.every((domain) => domain?.size === 1 && (domain.has("array") || domain.has("object")))) {
            const objects = operands.filter((_operand, i) => domains[i]!.has("object"));
            const arrays = operands.filter((_operand, i) => domains[i]!.has("array"));
            if (objects.length > 0 && arrays.length > 0)
                return [
                    {
                        anyOf: [
                            { type: "object", allOf: objects },
                            { type: "array", allOf: arrays },
                            { type: ["string", "number", "boolean", "null"] },
                        ],
                    },
                ];
        }
    }

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
