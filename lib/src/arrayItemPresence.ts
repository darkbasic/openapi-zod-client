import type { ReferenceObject, SchemaObject } from "openapi3-ts";
import { t, ts } from "tanu";

import { literalType } from "./literalType";
import type { DocumentResolver } from "./makeSchemaResolver";
import { positiveDoubleNegation, requiredAdditionalKeys } from "./schemaAssertions";

type Schema = ReferenceObject | SchemaObject;

// Locate item contracts that can narrow a parsed result. The generated input and
// output types decide whether each constraint applies, including across unions.
type Presence = {
    keys: string[];
    hasScalarConstraint: boolean;
    tuples: unknown[][];
    items?: Presence | undefined;
};

function hasTuples(proof?: Presence): boolean {
    return !!proof && (proof.tuples.length > 0 || hasTuples(proof.items));
}

function merge(nodes: Presence[]): Presence | undefined {
    if (nodes.length <= 1) return nodes[0];
    return {
        keys: [...new Set(nodes.flatMap((node) => node.keys))],
        hasScalarConstraint: nodes.some((node) => node.hasScalarConstraint),
        tuples: [...new Set(nodes.flatMap((node) => node.tuples))],
        items: merge(nodes.flatMap((node) => node.items ?? [])),
    };
}

function localPresence(
    schema: SchemaObject & { const?: unknown },
    isAssertion: boolean,
    items: Presence | undefined
): Presence | undefined {
    const keys = (isAssertion ? schema.required ?? [] : requiredAdditionalKeys(schema)).filter(
        (key) => key !== "__proto__"
    );
    const literals = Object.hasOwn(schema, "const") ? [schema.const] : schema.enum;
    const hasScalarConstraint = isAssertion && (!!schema.type || !!literals);
    if (keys.length === 0 && !hasScalarConstraint && !items) return;
    return {
        keys,
        hasScalarConstraint,
        items,
        tuples: isAssertion ? literals?.filter(Array.isArray) ?? [] : [],
    };
}

export function arrayPresenceCandidates(operands: Schema[], contributes: boolean[], resolver: DocumentResolver) {
    const guards = new Map<Schema, Presence | undefined>();
    const producers = new Map<Schema, Presence | undefined>();
    const visiting = new Set<Schema>();
    let hasRecursiveItems = false;
    const visit = (schema: Schema, isGuard: boolean): Presence | undefined => {
        const cache = isGuard ? guards : producers;
        if (cache.has(schema)) return cache.get(schema);
        if (visiting.has(schema)) {
            hasRecursiveItems = true;
            return;
        }

        visiting.add(schema);
        const { $ref, allOf, anyOf, oneOf, items, ...local }: SchemaObject & { $ref?: string; const?: unknown } = {
            ...(positiveDoubleNegation(schema) ?? schema),
        };
        // A producer already types its declared properties. A reference sibling
        // checks the raw input and can supply an independent presence guarantee.
        const isAssertion = isGuard || !!$ref;
        const proof = localPresence(local, isAssertion, items && visit(items, isAssertion));
        const ref = $ref && resolver.getSchemaByRef($ref);
        const branches = [...(allOf ?? []), ...(anyOf ?? []), ...(oneOf ?? []), ...(ref ? [ref] : [])];
        const result = merge([
            ...(proof ? [proof] : []),
            ...branches.flatMap((branch) => visit(branch, isGuard) ?? []),
        ]);
        visiting.delete(schema);
        cache.set(schema, result);
        return result;
    };

    const candidates = operands.map((operand, i) => {
        const proof = visit(operand, !contributes[i]);
        return proof?.tuples.length || proof?.items ? proof : undefined;
    });
    // TypeScript rejects conditional types over their own array element alias.
    // Recursion through an object property never enters this array-only traversal.
    return hasRecursiveItems ? undefined : candidates;
}

const f = ts.factory;
const keyof = (type: ts.TypeNode) => f.createTypeOperatorNode(ts.SyntaxKind.KeyOfKeyword, type);
const conditional = f.createConditionalTypeNode;
const param = (name: string, constraint?: ts.TypeNode) => f.createTypeParameterDeclaration(undefined, name, constraint);
const array = t.reference("globalThis.ReadonlyArray", [t.unknown()]);
// A broad union arm such as unknown or {} accepts an array with arbitrary
// elements, even though Extract would omit that arm.
const mutableArray = t.reference("globalThis.Array", [t.unknown()]);
const arrayPart = (value: ts.TypeNode, broad = array) =>
    conditional(mutableArray, value, broad, t.reference("globalThis.Extract", [value, array]));
const elements = (value: ts.TypeNode) => f.createIndexedAccessTypeNode(arrayPart(value), t.number());
const lengthOf = (value: ts.TypeNode) =>
    f.createIndexedAccessTypeNode(value, f.createLiteralTypeNode(f.createStringLiteral("length")));
const fixedTuple = (value: ts.TypeNode) => conditional(t.number(), lengthOf(value), t.unknown(), value);
const present = t.union([f.createTypeLiteralNode([]), t.reference("null")]);

// A guard can narrow a retained field's presence, never replace its parsed type.
// Work from the actual input type: a default, an unchecked schema, or a union
// accepting a missing key does not prove that the caller supplied it.
type ItemGuard = { input: ts.TypeNode; proof: Presence };

function presentFields(item: ts.TypeNode, input: ts.TypeNode, names: string[], readonly: boolean) {
    const key = t.reference("Key");
    const objects = t.reference("globalThis.Extract", [
        t.reference("globalThis.Exclude", [input, array]),
        t.reference("object"),
    ]);
    // Unknown and defaulted inputs admit undefined. A scalar-only guard has
    // no object branch from which to infer presence.
    const proven = conditional(
        t.undefined(),
        input,
        t.never(),
        conditional(
            objects,
            t.never(),
            t.never(),
            conditional(objects, t.reference("globalThis.Record", [key, present]), key, t.never())
        )
    );
    return f.createMappedTypeNode(
        readonly ? f.createToken(ts.SyntaxKind.ReadonlyKeyword) : undefined,
        param("Key", t.union(names.map((name) => f.createLiteralTypeNode(f.createStringLiteral(name))))),
        conditional(key, keyof(item), proven, t.never()),
        undefined,
        t.intersection([f.createIndexedAccessTypeNode(item, t.intersection([key, keyof(item)])), present]),
        f.createNodeArray()
    );
}

const jsonScalars = t.union([t.string(), t.number(), t.boolean()]);

function scalarConstraint(input: ts.TypeNode): ts.TypeNode {
    // A default can produce a different value from undefined. Otherwise a
    // scalar keeps its value, whereas an object can lose keys or gain defaults.
    // A broad non-null input ({}) also admits scalar values.
    return conditional(
        t.undefined(),
        input,
        t.unknown(),
        conditional(
            input,
            t.reference("object"),
            conditional(jsonScalars, input, f.createTypeLiteralNode([]), t.reference("object")),
            input
        )
    );
}

function applyPresence(value: ts.TypeNode, guards: ItemGuard[], readonly: boolean): ts.TypeNode {
    const item = t.reference("Item");
    const names = guards.map((_, i) => "Input" + i);
    const scalars = guards.flatMap(({ proof }, i) =>
        proof.hasScalarConstraint ? [scalarConstraint(t.reference(names[i]!))] : []
    );
    const fields = guards.flatMap(({ proof }, i) =>
        proof.keys.length > 0 ? [presentFields(item, t.reference(names[i]!), proof.keys, readonly)] : []
    );
    const object =
        fields.length > 0 ? conditional(item, t.reference("object"), t.intersection([item, ...fields]), item) : item;
    const children = guards.flatMap(({ proof }, i) => {
        const input = t.reference(names[i]!);
        return proof.items
            ? [{ proof: proof.items, input: conditional(t.undefined(), input, t.unknown(), elements(input)) }]
            : [];
    });
    // Rebuild array methods from the same element type used for indexing.
    // A fixed-length tuple also retains its original positional constraints.
    const nested =
        children.length > 0
            ? t.intersection([
                  t.reference(readonly ? "globalThis.ReadonlyArray" : "globalThis.Array", [
                      applyPresence(f.createIndexedAccessTypeNode(item, t.number()), children, readonly),
                  ]),
                  fixedTuple(item),
              ])
            : item;
    // Bind the inputs outside the conditional. Each operand appears once per
    // level and component names cannot be captured by the local type parameters.
    return conditional(
        f.createTupleTypeNode([value, ...guards.map(({ input }) => input)]),
        f.createTupleTypeNode(["Item", ...names].map((name) => f.createInferTypeNode(param(name)))),
        t.intersection([conditional(item, array, nested, object), ...scalars]),
        t.never()
    );
}

// Build the known JSON tuple directly. Each slot is paired with the producer at
// that index. An impossible scalar slot is never, and object slots retain the
// producer's stripped keys and materialized defaults.
function projectLiteral(value: unknown, parsed: ts.TypeNode, readonly: boolean): ts.TypeNode {
    if (!Array.isArray(value)) {
        return value !== null && typeof value === "object"
            ? t.intersection([t.reference("globalThis.Exclude", [parsed, array]), t.reference("object")])
            : t.reference("globalThis.Extract", [literalType(value), parsed]);
    }

    const list = t.reference("List");
    const tuple = f.createTupleTypeNode(
        value.map((entry, index) =>
            projectLiteral(
                entry,
                f.createIndexedAccessTypeNode(list, f.createLiteralTypeNode(f.createNumericLiteral(index))),
                readonly
            )
        )
    );
    // A producer can return a mutable literal tuple inside a readonly array.
    const slots = t.reference("Slots");
    const output = readonly
        ? conditional(
              tuple,
              f.createInferTypeNode(param("Slots")),
              conditional(list, mutableArray, slots, t.reference("globalThis.Readonly", [slots])),
              t.never()
          )
        : tuple;
    const compatible = conditional(
        f.createLiteralTypeNode(f.createNumericLiteral(value.length)),
        lengthOf(list),
        output,
        t.never()
    );
    return conditional(
        arrayPart(parsed, readonly ? array : mutableArray),
        f.createInferTypeNode(param("List")),
        conditional(list, array, compatible, t.never()),
        t.never()
    );
}

function tupleProjection(parsed: ts.TypeNode, raw: ts.TypeNode, proof: Presence, readonly: boolean): ts.TypeNode {
    const value = t.reference("Parsed");
    const input = t.reference("Raw");
    const list = arrayPart(value, readonly ? array : mutableArray);
    let broad: ts.TypeNode = list;
    if (proof.items) {
        const itemType = f.createIndexedAccessTypeNode(list, t.number());
        const inputType = f.createIndexedAccessTypeNode(input, t.number());
        const item = hasTuples(proof.items)
            ? tupleProjection(itemType, inputType, proof.items, readonly)
            : applyPresence(itemType, [{ proof: proof.items, input: inputType }], readonly);
        broad = conditional(
            list,
            t.never(),
            t.never(),
            t.intersection([
                t.reference(readonly ? "globalThis.ReadonlyArray" : "globalThis.Array", [item]),
                fixedTuple(list),
            ])
        );
    }

    // A fixed input can only select matching JSON literals; a broad array arm
    // can also accept other lengths. Test the complete raw tuple, including
    // object keys, before projecting its parsed result.
    const alternatives = proof.tuples.map((tuple) =>
        conditional(literalType(tuple), input, projectLiteral(tuple, value, readonly), t.never())
    );
    const onArray =
        alternatives.length > 0 ? conditional(t.number(), lengthOf(input), broad, t.union(alternatives)) : broad;
    const nonArray = conditional(array, input, value, t.reference("globalThis.Exclude", [value, array]));
    const other = t.intersection([nonArray, scalarConstraint(input)]);
    return conditional(
        f.createTupleTypeNode([parsed, raw]),
        f.createTupleTypeNode(["Parsed", "Raw"].map((name) => f.createInferTypeNode(param(name)))),
        conditional(t.undefined(), input, value, conditional(input, array, onArray, other)),
        t.never()
    );
}

function preserveArrayUnions(parsed: ts.TypeNode, unions: ts.TypeNode[], readonly: boolean) {
    if (unions.length === 0) return parsed;
    // A whole-array union selects one branch for every position. Keep each
    // producer's correlation independently, reusing the merged item type.
    const value = t.reference("Merged");
    const item = (type: ts.TypeNode) => f.createIndexedAccessTypeNode(type, t.number());
    const names = unions.map((_, i) => "Part" + i);
    const constraints = names.map((name) => {
        const part = t.reference(name);
        const list = t.reference(readonly ? "globalThis.ReadonlyArray" : "globalThis.Array", [
            t.intersection([item(value), item(part)]),
        ]);
        return conditional(part, array, list, t.never());
    });
    return conditional(
        f.createTupleTypeNode([parsed, ...unions]),
        f.createTupleTypeNode(["Merged", ...names].map((name) => f.createInferTypeNode(param(name, array)))),
        t.intersection([value, ...constraints]),
        t.never()
    );
}

export function arrayOutputType(
    producers: ts.TypeNode[],
    candidates: Array<Presence | undefined>,
    rawArray: (index: number) => ts.TypeNode,
    readonly: boolean,
    unionProducers: boolean[]
): ts.TypeNode {
    if (producers.length === 1 && !candidates.some(Boolean)) return producers[0]!;
    const items = producers.map((producer) => f.createIndexedAccessTypeNode(producer, t.number()));
    const item: ts.TypeNode = items.length > 0 ? t.intersection(items) : t.unknown();
    const guards = candidates.flatMap((proof, i) =>
        proof?.items ? [{ proof: proof.items, input: elements(rawArray(i)) }] : []
    );
    const parsedItem = guards.length > 0 ? applyPresence(item, guards, readonly) : item;
    const list = t.reference(readonly ? "globalThis.ReadonlyArray" : "globalThis.Array", [parsedItem]);
    // Intersecting a fixed tuple with the narrowed element list preserves its
    // length and positional types while array methods use the narrowed elements.
    const parsed = t.intersection([list, ...producers.map(fixedTuple)]);
    const value = t.reference("ParsedArray");
    const tuples = candidates.flatMap((proof, i) =>
        proof && hasTuples(proof) ? [tupleProjection(value, arrayPart(rawArray(i)), proof, readonly)] : []
    );
    const output =
        tuples.length > 0
            ? conditional(
                  parsed,
                  f.createInferTypeNode(param("ParsedArray", array)),
                  t.intersection([...tuples, fixedTuple(value)]),
                  t.never()
              )
            : parsed;
    return preserveArrayUnions(
        output,
        producers.filter((_, i) => unionProducers[i]),
        readonly
    );
}
