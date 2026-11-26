import type { ReferenceObject, SchemaObject } from "openapi3-ts";
import { t, ts } from "tanu";

import type { DocumentResolver } from "./makeSchemaResolver";
import { positiveDoubleNegation, requiredAdditionalKeys } from "./schemaAssertions";

type Schema = ReferenceObject | SchemaObject;

// Locate item contracts that can narrow a parsed result. The generated input and
// output types decide whether each constraint applies, including across unions.
type Presence = {
    keys: string[];
    hasScalarConstraint: boolean;
    items?: Presence | undefined;
};

// A whole-array enum can constrain scalar entries several levels down. Object
// literals constrain the raw object only; the owning parser may strip its keys.
function literalItems(values: unknown[]): Presence | undefined {
    const children: unknown[] = values.filter(Array.isArray).flat();
    if (children.length === 0) return;
    const hasScalarConstraint = children.some((value) => value === null || typeof value !== "object");
    const items = literalItems(children);
    return hasScalarConstraint || items ? { keys: [], hasScalarConstraint, items } : undefined;
}

function merge(nodes: Presence[]): Presence | undefined {
    if (nodes.length <= 1) return nodes[0];
    return {
        keys: [...new Set(nodes.flatMap((node) => node.keys))],
        hasScalarConstraint: nodes.some((node) => node.hasScalarConstraint),
        items: merge(nodes.flatMap((node) => node.items ?? [])),
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
        const keys = (isAssertion ? local.required ?? [] : requiredAdditionalKeys(local)).filter(
            (key) => key !== "__proto__"
        );
        const literals = Object.hasOwn(local, "const") ? [local.const] : local.enum;
        const hasScalarConstraint = isAssertion && (!!local.type || !!literals);
        const child = items && visit(items, isAssertion);
        const literalChild = isAssertion && literals && literalItems(literals);
        const ref = $ref && resolver.getSchemaByRef($ref);
        const branches = [...(allOf ?? []), ...(anyOf ?? []), ...(oneOf ?? []), ...(ref ? [ref] : [])];
        const result = merge([
            ...(keys.length > 0 || hasScalarConstraint || child ? [{ keys, hasScalarConstraint, items: child }] : []),
            ...(literalChild ? [{ keys: [], hasScalarConstraint: false, items: literalChild }] : []),
            ...branches.flatMap((branch) => visit(branch, isGuard) ?? []),
        ]);
        visiting.delete(schema);
        cache.set(schema, result);
        return result;
    };

    const candidates = operands.map((operand, i) => visit(operand, !contributes[i])?.items);
    // TypeScript rejects conditional types over their own array element alias.
    // Recursion through an object property never enters this array-only traversal.
    return hasRecursiveItems ? [] : candidates;
}

const f = ts.factory;
const keyof = (type: ts.TypeNode) => f.createTypeOperatorNode(ts.SyntaxKind.KeyOfKeyword, type);
const conditional = f.createConditionalTypeNode;
const param = (name: string, constraint?: ts.TypeNode) => f.createTypeParameterDeclaration(undefined, name, constraint);
const array = t.reference("globalThis.ReadonlyArray", [t.unknown()]);
// A broad union arm such as unknown or {} accepts an array with arbitrary
// elements, even though Extract would omit that arm.
const elements = (value: ts.TypeNode) =>
    conditional(
        t.reference("globalThis.Array", [t.unknown()]),
        value,
        t.unknown(),
        f.createIndexedAccessTypeNode(t.reference("globalThis.Extract", [value, array]), t.number())
    );
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
                  conditional(
                      t.number(),
                      f.createIndexedAccessTypeNode(item, f.createLiteralTypeNode(f.createStringLiteral("length"))),
                      t.unknown(),
                      item
                  ),
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

export function arrayOutputType(
    producers: ts.TypeNode[],
    candidates: Array<Presence | undefined>,
    rawArray: (index: number) => ts.TypeNode,
    readonly: boolean
): ts.TypeNode {
    if (producers.length === 1 && !candidates.some(Boolean)) return producers[0]!;
    const items = producers.map((producer) => f.createIndexedAccessTypeNode(producer, t.number()));
    const item: ts.TypeNode = items.length > 0 ? t.intersection(items) : t.unknown();
    const guards = candidates.flatMap((proof, i) => (proof ? [{ proof, input: elements(rawArray(i)) }] : []));
    const output = guards.length > 0 ? applyPresence(item, guards, readonly) : item;
    const list = t.reference(readonly ? "globalThis.ReadonlyArray" : "globalThis.Array", [output]);
    // Intersecting a fixed tuple with the narrowed element list preserves its
    // length and positional types while array methods use the narrowed elements.
    return t.intersection([
        list,
        ...producers.map((producer) =>
            conditional(
                t.number(),
                f.createIndexedAccessTypeNode(producer, f.createLiteralTypeNode(f.createStringLiteral("length"))),
                t.unknown(),
                producer
            )
        ),
    ]);
}
