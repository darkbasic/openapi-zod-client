import type { ReferenceObject, SchemaObject } from "openapi3-ts";
import { t, ts } from "tanu";

import { isReferenceObject } from "./isReferenceObject";
import { literalType } from "./literalType";
import type { DocumentResolver } from "./makeSchemaResolver";
import {
    hasStructuralKeywords,
    hasStructuralLiteral,
    positiveDoubleNegation,
    useSiteDefault,
} from "./schemaAssertions";

type Schema = SchemaObject | ReferenceObject;
const arraySlot = Symbol("array element");
const extraKey = Symbol("additional property");
type IndexStep = string | typeof arraySlot | typeof extraKey;
type IndexPlan = { widen: boolean; unknownIndex: boolean; children: Map<IndexStep, IndexPlan> };

const unknownSubtree: IndexPlan = { widen: false, unknownIndex: false, children: new Map() };
const composite = (value: unknown): value is object => value !== null && typeof value === "object";

function suppliesContainer(node: SchemaObject, step: IndexStep) {
    const value: unknown = node.default;
    if (step === arraySlot) return Array.isArray(value) && value.some(composite);
    if (!composite(value) || Array.isArray(value)) return false;
    return Object.entries(value).some(([key, entry]) => {
        const isDeclared = Object.hasOwn(node.properties ?? {}, key);
        return (
            composite(entry) &&
            (isDeclared || node.additionalProperties !== false) &&
            (step === extraKey ? !isDeclared : key === step)
        );
    });
}

const typedDictionary = (schema: SchemaObject) =>
    typeof schema.additionalProperties === "object" && Object.keys(schema.additionalProperties).length > 0;

const hasType = (node: SchemaObject, kind: "string" | "object") =>
    Array.isArray(node.type) ? node.type.includes(kind) : node.type === kind;
const parsesBinary = (node: SchemaObject) => hasType(node, "string") && node.format === "binary" && !node.enum;
const parsesObject = (node: SchemaObject) =>
    hasType(node, "object") || (!node.type && (hasStructuralKeywords(node) || hasStructuralLiteral(node)));

function schemaSurfaces(resolver: DocumentResolver) {
    const layers = new Map<Schema, SchemaObject[]>();
    return (schema: Schema): SchemaObject[] => {
        const cached = layers.get(schema);
        if (cached) return cached;
        const seen = new Set<Schema>();
        const result: SchemaObject[] = [];
        const pending = [schema];
        while (pending.length > 0) {
            const next = pending.pop()!;
            if (seen.has(next)) continue;
            seen.add(next);
            const node = positiveDoubleNegation(next) ?? next;
            const local: SchemaObject & { $ref?: string } = isReferenceObject(node) ? { ...node } : node;
            if (local.$ref) {
                const target = resolver.getSchemaByRef(local.$ref);
                if (target) pending.push(target);
            }

            if (
                local.default !== undefined ||
                (!local.$ref &&
                    (local.items ||
                        parsesObject(local) ||
                        parsesBinary(local) ||
                        local.properties ||
                        local.additionalProperties))
            )
                result.push(local);
            pending.push(...(local.allOf ?? []), ...(local.anyOf ?? []), ...(local.oneOf ?? []));
        }

        layers.set(schema, result);
        return result;
    };
}

function reaches<T>(matches: (node: T) => boolean, children: (node: T) => Iterable<T>) {
    const cache = new Map<T, boolean>();
    return (root: T) => {
        const visited = new Set<T>();
        const pending = [root];
        while (pending.length > 0) {
            const next = pending.pop()!;
            if (cache.get(next) === true || matches(next)) {
                cache.set(root, true);
                return true;
            }

            if (cache.has(next) || visited.has(next)) continue;
            visited.add(next);
            pending.push(...children(next));
        }

        for (const node of visited) cache.set(node, false);
        return false;
    };
}

const additional = (node: SchemaObject) =>
    typeof node.additionalProperties === "object" ? node.additionalProperties : undefined;
const openDefault = (node: SchemaObject) =>
    node.default !== null &&
    typeof node.default === "object" &&
    !Array.isArray(node.default) &&
    node.additionalProperties !== false &&
    Object.keys(node.default).some((key) => !Object.hasOwn(node.properties ?? {}, key));

function ownerGroups(surface: ReturnType<typeof schemaSurfaces>) {
    const ids = new Map<SchemaObject, number>();
    const id = (node: SchemaObject) => {
        if (!ids.has(node)) ids.set(node, ids.size);
        return ids.get(node)!;
    };

    return (candidates: Schema[][]) => {
        const groups = new Map<string, SchemaObject[]>();
        for (const group of candidates) {
            const nodes = [...new Set(group.flatMap(surface))].sort((a, b) => id(a) - id(b));
            if (nodes.length > 0) groups.set(nodes.map(id).join(","), nodes);
        }

        return groups;
    };
}

function pruneUnchangedPaths(nodes: Iterable<IndexPlan>) {
    // A backedge alone does not justify losing an existing recursive property type.
    const useful = reaches(
        (node: IndexPlan) => node === unknownSubtree || node.widen,
        (node) => node.children.values()
    );
    for (const node of nodes) {
        for (const [step, child] of node.children) if (!useful(child)) node.children.delete(step);
    }
}

function overlap(
    owners: SchemaObject[][],
    left: (node: SchemaObject) => boolean,
    right: (node: SchemaObject) => boolean
) {
    return owners.some((a) => a.some(left) && owners.some((b) => a !== b && b.some(right)));
}

function addChildren(
    children: Map<IndexStep, IndexPlan>,
    owners: SchemaObject[][],
    visit: (groups: Schema[][]) => IndexPlan | undefined,
    hasIndex: (schema: Schema) => boolean
) {
    const descend = (step: IndexStep, field: (schema: SchemaObject) => Schema | undefined) => {
        // A whole-container default can supply nested keys absent from the declared
        // output. Preserve the parent and its other fields; this child's type is unknown.
        const hasExternalDefault = overlap(
            owners,
            (node) => suppliesContainer(node, step),
            (node) => {
                const schema = field(node);
                return !!schema && hasIndex(schema);
            }
        );
        const child = hasExternalDefault
            ? unknownSubtree
            : visit(owners.map((group) => group.flatMap((node) => field(node) ?? [])));
        if (child) children.set(step, child);
    };

    descend(arraySlot, (node) => node.items);
    descend(extraKey, additional);
    for (const key of new Set(owners.flat(1).flatMap((node) => Object.keys(node.properties ?? {})))) {
        descend(key, (node) =>
            node.properties && Object.hasOwn(node.properties, key) ? node.properties[key] : additional(node)
        );
    }
}

// Compare the independent parsers at each path. A single owner or repeated references to
// the same parser already have a consistent subtree. Memoize combinations before descent.
export function arrayItemMergePlan(operands: Schema[], resolver: DocumentResolver, withDefaults: boolean) {
    if (operands.length < 2) return;
    const surface = schemaSurfaces(resolver);
    const descendants = (node: SchemaObject) => {
        const schemas = Object.values(node.properties ?? {});
        if (node.items) schemas.push(node.items);
        const extra = additional(node);
        if (extra) schemas.push(extra);
        return schemas.flatMap(surface);
    };

    const hasBinary = reaches(parsesBinary, descendants);
    const hasObject = reaches(parsesObject, descendants);
    const hasIndex = reaches(typedDictionary, descendants);
    const hasDefault = reaches((node: SchemaObject) => node.default !== undefined, descendants);
    const addsField = (node: SchemaObject) =>
        node.default !== undefined ||
        Object.values(node.properties ?? {}).some((field) => useSiteDefault(field, resolver));
    const distinct = ownerGroups(surface);
    const complete = new Map<string, IndexPlan>();
    const visit = (candidates: Schema[][]): IndexPlan | undefined => {
        const groups = distinct(candidates);
        const owners = [...groups.values()];
        // Native object intersections merge enumerable properties, losing a File's prototype.
        if (overlap(owners, parsesBinary, parsesObject)) return unknownSubtree;
        if (!(withDefaults && overlap(owners, hasIndex, hasDefault)) && !overlap(owners, hasBinary, hasObject)) return;
        const signature = [...groups.keys()].sort().join("|");
        if (complete.has(signature)) return complete.get(signature);
        const othersWithIndex = owners.filter((group) =>
            owners.some((other) => other !== group && other.some(typedDictionary))
        );
        const children = new Map<IndexStep, IndexPlan>();
        const plan = {
            widen: withDefaults && othersWithIndex.some((group) => group.some(addsField)),
            unknownIndex: withDefaults && othersWithIndex.some((group) => group.some(openDefault)),
            children,
        };
        complete.set(signature, plan);
        addChildren(children, owners, visit, (schema) => withDefaults && surface(schema).some(hasIndex));
        return plan;
    };

    const root = visit(operands.map((operand) => surface(operand).flatMap((node) => node.items ?? [])));
    if (!root) return;
    pruneUnchangedPaths(complete.values());
    return root === unknownSubtree || root.widen || root.children.size > 0 ? root : undefined;
}

const f = ts.factory;
const conditional = f.createConditionalTypeNode;
const keyof = (type: ts.TypeNode) => f.createTypeOperatorNode(ts.SyntaxKind.KeyOfKeyword, type);
const param = (name: string, type?: ts.TypeNode) => f.createTypeParameterDeclaration(undefined, name, type);
// A string index also covers keys materialized independently by another parser.
// Recover the explicitly named properties of the merged row before rebuilding its index.
function widenMergedIndex(value: ts.TypeNode, readonly: boolean, unknownIndex: boolean): ts.TypeNode {
    const row = t.reference("Row");
    const key = t.reference("Property");
    const named = t.reference("Named");
    const properties = f.createMappedTypeNode(
        undefined,
        param("Property", keyof(row)),
        conditional(t.string(), key, t.never(), conditional(t.number(), key, t.never(), key)),
        undefined,
        f.createIndexedAccessTypeNode(row, key),
        f.createNodeArray()
    );
    const valueType = t.union([
        f.createIndexedAccessTypeNode(row, t.intersection([t.string(), keyof(row)])),
        f.createIndexedAccessTypeNode(named, t.intersection([keyof(named), t.union([t.string(), t.number()])])),
    ]);
    const index = t.reference("globalThis.Record", [t.string(), unknownIndex ? t.unknown() : valueType]);
    const merged = t.intersection([named, readonly ? t.reference("globalThis.Readonly", [index]) : index]);
    return conditional(
        value,
        f.createInferTypeNode(param("Row")),
        conditional(
            row,
            t.reference("object"),
            conditional(
                t.string(),
                keyof(row),
                conditional(properties, f.createInferTypeNode(param("Named")), merged, t.never()),
                row
            ),
            row
        ),
        t.never()
    );
}

export function projectMergedItem(
    value: ts.TypeNode,
    plan: IndexPlan,
    readonly: boolean,
    ancestors = new Set<IndexPlan>()
): ts.TypeNode {
    if (plan === unknownSubtree || ancestors.has(plan)) return t.unknown();
    if (plan.children.size === 0) return widenMergedIndex(value, readonly, plan.unknownIndex);
    const seen = new Set(ancestors).add(plan);
    const project = (input: ts.TypeNode, child: IndexPlan) => projectMergedItem(input, child, readonly, seen);
    const row = t.reference("Container");
    const key = t.reference("Field");
    const original = f.createIndexedAccessTypeNode(row, key);
    const keys = new Map<IndexPlan, string[]>();
    const extra = plan.children.get(extraKey);
    for (const [step, child] of plan.children) {
        if (typeof step !== "string" || child === extra) continue;
        const names = keys.get(child) ?? [];
        names.push(step);
        keys.set(child, names);
    }

    let field: ts.TypeNode = extra ? project(original, extra) : original;
    for (const [child, names] of keys)
        field = conditional(key, t.union(names.map(literalType)), project(original, child), field);
    const map = (type: ts.TypeNode) =>
        f.createMappedTypeNode(undefined, param("Field", keyof(row)), undefined, undefined, type, f.createNodeArray());
    const object = extra || keys.size > 0 ? map(field) : row;
    const parsedObject = plan.widen ? widenMergedIndex(object, readonly, plan.unknownIndex) : object;

    let array: ts.TypeNode = row;
    const item = plan.children.get(arraySlot);
    if (item) {
        // Array intersections retain methods from their first operand. Rebuild a normal list
        // from the merged index while preserving a fixed tuple's positional constraints.
        const element = project(f.createIndexedAccessTypeNode(row, t.number()), item);
        const list = t.reference(readonly ? "globalThis.ReadonlyArray" : "globalThis.Array", [element]);
        array = conditional(
            t.number(),
            f.createIndexedAccessTypeNode(row, literalType("length")),
            list,
            map(project(original, item))
        );
    }

    return conditional(
        value,
        f.createInferTypeNode(param("Container")),
        conditional(
            row,
            t.reference("globalThis.ReadonlyArray", [t.unknown()]),
            array,
            conditional(row, t.reference("object"), parsedObject, row)
        ),
        t.never()
    );
}
