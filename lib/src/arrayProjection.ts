import type { ReferenceObject, SchemaObject } from "openapi3-ts";
import { t } from "tanu";

import { arrayOutputType, arrayPresenceCandidates } from "./arrayItemPresence";
import type { DocumentResolver } from "./makeSchemaResolver";
import { printTs } from "./printTs";
import { getConjunctiveSchemaLayers, hasStructuralKeywords, positiveDoubleNegation } from "./schemaAssertions";
import type { TemplateContext } from "./template-context";

type Schema = ReferenceObject | SchemaObject;

// Each decision describes whether an operand contributes the parsed array element. A union
// uses the first option which parses its input, just as its generated Zod union does.
type Scope = "array" | "item";
type Decision =
    | boolean
    | "object"
    | "default"
    | { items: Decision }
    | { recursive: Decision }
    | { some: Decision[] }
    | {
          scope: Scope;
          oneOf: SchemaObject | undefined;
          options: Array<{ schema: Schema; index: number; decision: Decision }>;
      };
type Emit = (schema: Schema, oneOf?: SchemaObject, index?: number) => string;

const combine = (decisions: Decision[]): Decision => {
    if (decisions.includes(true)) return true;
    const possible = [...new Set(decisions.filter((decision) => decision !== false))];
    return possible.length > 1 ? { some: possible } : possible[0] ?? false;
};

const excludesArrays = (layer: SchemaObject) =>
    (layer.type && layer.type !== "array" && !(Array.isArray(layer.type) && layer.type.includes("array"))) ||
    (layer.enum && !layer.enum.some(Array.isArray));

function unionDecision(
    alternatives: Schema[],
    scope: Scope,
    visit: (schema: Schema, scope: Scope) => Decision,
    resolver: DocumentResolver,
    oneOf?: SchemaObject
): Decision {
    const choices = alternatives.flatMap((schema, index) =>
        scope === "array" && getConjunctiveSchemaLayers(schema, resolver, true)?.some(excludesArrays)
            ? []
            : [{ schema, index, decision: visit(schema, scope) }]
    );
    const first = choices[0]?.decision ?? false;
    return choices.every((choice) => choice.decision === first) ? first : { scope, options: choices, oneOf };
}

function objectDecision(schema: SchemaObject, options?: TemplateContext["options"]): Decision {
    const hasObjectType = schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"));
    if (!hasObjectType && !hasStructuralKeywords(schema)) return false;
    const additional = schema.additionalProperties ?? options?.additionalPropertiesDefaultValue !== false;
    const hasOutput =
        Object.keys(schema.properties ?? {}).length > 0 ||
        additional === false ||
        (typeof additional === "object" && Object.keys(additional).length > 0);
    if (!hasOutput) return false;
    return schema.type === "object" ? true : "object";
}

function memberDecision(
    schema: Schema,
    scope: Scope,
    visit: (member: Schema, scope: Scope) => Decision,
    resolver: DocumentResolver,
    options?: TemplateContext["options"]
): Decision {
    const { $ref, allOf, anyOf, oneOf, ...local }: SchemaObject & { $ref?: string } = {
        ...(positiveDoubleNegation(schema) ?? schema),
    };
    const decisions: Decision[] = [];
    if (scope === "item" && options?.withDefaultValues !== false && local.default !== undefined)
        decisions.push("default");
    if ($ref) {
        const target = resolver.getSchemaByRef($ref);
        decisions.push(target ? visit(target, scope) : true);
    } else {
        if (scope === "item") decisions.push(objectDecision(local, options));

        if (local.items) {
            const item = visit(local.items, "item");
            if (item !== false)
                decisions.push(scope === "array" || (local.type === "array" && item === true) ? item : { items: item });
        }
    }

    if (allOf) decisions.push(...allOf.map((member) => visit(member, scope)));
    if (anyOf) decisions.push(unionDecision(anyOf, scope, visit, resolver));
    if (oneOf) decisions.push(unionDecision(oneOf, scope, visit, resolver, { ...local, oneOf }));

    return combine(decisions);
}

function ownershipVisitor(resolver: DocumentResolver, options?: TemplateContext["options"]) {
    const complete = { array: new Map<Schema, Decision>(), item: new Map<Schema, Decision>() };
    const visiting = {
        array: new Map<Schema, { recursive: Decision }>(),
        item: new Map<Schema, { recursive: Decision }>(),
    };
    const visit = (schema: Schema, scope: Scope): Decision => {
        const cached = complete[scope].get(schema) ?? visiting[scope].get(schema);
        if (cached !== undefined) return cached;
        const recursive: { recursive: Decision } = { recursive: false };
        visiting[scope].set(schema, recursive);
        const decision = memberDecision(schema, scope, visit, resolver, options);
        recursive.recursive = decision;
        visiting[scope].delete(schema);
        complete[scope].set(schema, decision);
        return decision;
    };

    return visit;
}

export function arrayProjection(
    operands: Schema[],
    resolver?: DocumentResolver,
    referenceSiblings = false,
    options?: TemplateContext["options"]
) {
    if (!resolver?.supportsSchemaRefSiblings || operands.length < 2) return;
    const members = operands.map((operand) => getConjunctiveSchemaLayers(operand, resolver, true));
    if (members.some((layers) => layers?.some(excludesArrays))) return;

    const visit = ownershipVisitor(resolver, options);
    const decisions = operands.map((operand, i) =>
        referenceSiblings && i > 0 && hasStructuralKeywords({ ...operand }) ? false : visit(operand, "array")
    );
    const producers = decisions.filter((decision) => decision !== false);
    if (producers.length === 0) return;
    const isDynamic = producers.length > 1 && producers.some((decision) => typeof decision !== "boolean");
    const contributes = decisions.map((decision) => (isDynamic ? decision === true : decision !== false));
    const isArrayOnly = members.some((layers) =>
        layers?.some(
            (layer) =>
                (!layer.nullable &&
                    (layer.type === "array" ||
                        (Array.isArray(layer.type) && layer.type.every((t) => t === "array")))) ||
                (layer.enum?.length && layer.enum.every(Array.isArray))
        )
    );
    const isArrayOrNull = members.some((layers) =>
        layers?.some(
            ({ type }) =>
                type === "array" || (Array.isArray(type) && type.every((kind) => kind === "array" || kind === "null"))
        )
    );
    // Only a union at the array level selects a branch for the entire list.
    // Alternatives inside items are already represented by the element type.
    const unionProducers = members
        .filter((_, i) => contributes[i])
        .map(
            (layers) =>
                !layers ||
                layers.some(
                    (layer) => layer.anyOf ?? layer.oneOf ?? (layer.enum?.filter(Array.isArray).length ?? 0) > 1
                )
        );
    const presence = arrayPresenceCandidates(operands, contributes, resolver);
    return {
        decisions,
        contributes,
        isDynamic,
        isArrayOnly,
        isArrayOrNull,
        unionProducers,
        hasRecursiveItems: !presence,
        presence: presence ?? [],
    };
}

type Projection = NonNullable<ReturnType<typeof arrayProjection>>;

// Zod allocates unfrozen composites when merging parsed arrays. Passthrough values still
// belong to the caller, so stop at any subtree shared with the original input.
const freezeMerged = `const freezeValue = z.unknown().readonly();
    const object = (value: unknown): value is { [key: string]: unknown } => !!value && typeof value === "object";
    const freeze = (value: unknown, raw: unknown) => {
        if (!object(value) || value === raw) return;
        freezeValue.parse(value);
        for (const key of z.util.objectKeys(value)) freeze(value[key], object(raw) ? raw[key] : undefined);
    };`;

function arraySelectors(plan: Projection, emit: Emit) {
    const rules: string[] = [];
    const arrayChecks: string[] = [];
    const selectors: string[] = [];
    const namesByDecision = new Map<Decision, string>();
    let hasCombination = false;
    const expression = (decision: Decision): string => {
        if (typeof decision === "boolean") return String(decision);
        if (decision === "object") return "z.getParsedType(item) === z.ZodParsedType.object";
        if (decision === "default") return "item === undefined";
        if ("items" in decision) return `asArray(item) ? ${ownership(decision.items)} : false`;
        if ("recursive" in decision) return ownership(decision.recursive) + "(item)";
        if ("some" in decision) {
            hasCombination = true;
            return `combine([${decision.some.map((part) => ownership(part) + "(item)").join(", ")}])`;
        }

        return decision.options.reduceRight((otherwise, option, i) => {
            const owned = ownership(option.decision) + "(item)";
            if (i === decision.options.length - 1) return owned;
            const name = `option${rules.length}`;
            rules.push(emit(option.schema, decision.oneOf, option.index));
            const check = `${name}.safeParse(${decision.scope === "array" ? "value" : "item"}).success`;
            if (decision.scope === "item") return `(${check} ? ${owned} : ${otherwise})`;
            const cached = `matches${arrayChecks.length}`;
            arrayChecks.push(`const ${cached} = ${check};`);
            return `(${cached} ? ${owned} : ${otherwise})`;
        }, "false");
    };

    const ownership = (decision: Decision): string => {
        const cached = namesByDecision.get(decision);
        if (cached) return cached;
        const name = `owns${namesByDecision.size}`;
        namesByDecision.set(decision, name);
        const code = expression(decision);
        const parameter = typeof decision === "boolean" ? "_item" : "item";
        selectors.push(`const ${name} = (${parameter}: unknown): Mask => ${code};`);
        return name;
    };

    const owners = plan.decisions.map(ownership);
    const combineMasks = hasCombination
        ? `const combine = (masks: Mask[]): Mask => {
                if (masks.includes(true)) return true;
                const children = masks.filter((mask): mask is (item: unknown) => Mask => typeof mask === "function");
                return children.length === 0 ? false : (item) => combine(children.map(child => child(item)));
            };`
        : "";
    return { owners, rules, selectors, arrayChecks, combineMasks };
}

// Dispatch without cloning the input array. Keep the native array error on a type mismatch.
function arrayInput(refs: string[]) {
    const input = refs.map((ref) => `z.input<typeof ${ref}>`).join(" & ");
    return `z.custom<${input}>().superRefine((value, ctx) => {
        const received = z.getParsedType(value);
        if (received !== z.ZodParsedType.array) ctx.addIssue({ code: "invalid_type", expected: "array", received, fatal: true });
    })`;
}

function selectedArray(plan: Projection, refs: string[], emit: Emit, readonly: boolean) {
    const { owners, rules, selectors, arrayChecks, combineMasks } = arraySelectors(plan, emit);
    // Parse each operand in Zod's current context. Distinct keys keep its result
    // available for selection without asking Zod to merge it with another operand.
    const members = refs.map((ref, i) => `.and(${ref}.transform(data => ({ part${i}: data })))`).join("");
    const parse = `${arrayInput(refs)}.pipe(z.unknown().transform(value => ({ value }))${members})
        .transform((parts, ctx): unknown => {
            const asArray = (value: unknown): value is readonly unknown[] => z.getParsedType(value) === z.ZodParsedType.array;
            const { value } = parts;
            const parsed = [${refs.map((_, i) => `parts.part${i}`).join(", ")}];
            type Mask = boolean | ((item: unknown) => Mask);
            ${combineMasks}
            ${arrayChecks.join("\n")}
            ${selectors.join("\n")}
            type Piece = { data: unknown; mask: Mask };
            const keep = (piece: Piece): z.ZodType<unknown> => z.unknown().transform(() => piece.data);
            const merge = (item: unknown, parts: Piece[], path: number[]): unknown => {
                const owned = parts.filter(part => part.mask !== false);
                if (!owned.length) return item;
                if (owned.length === 1) return owned[0]!.data;
                if (asArray(item) && owned.some(part => typeof part.mask === "function")) {
                    const values: unknown[] = [];
                    for (let i = 0; i < item.length; i++) {
                        values.push(merge(item[i], owned.map(({ data, mask }) => ({
                            data: asArray(data) ? data[i] : undefined,
                            mask: typeof mask === "function" ? mask(item[i]) : mask,
                        })), [...path, i]));
                    }
                    return values;
                }
                const merged = owned.map(keep).reduce((a, b) => a.and(b)).safeParse(undefined);
                if (merged.success) return merged.data;
                ctx.addIssue({ code: "invalid_intersection_types", path });
                return z.NEVER;
            };
            const owners = [${owners.join(", ")}];
            const result = merge(value, parsed.map((data, i) => ({ data, mask: owners[i]! })), []);
            ${readonly ? freezeMerged + "\nfreeze(result, value);" : ""}
            return result;
        })`;
    const names = rules.map((_, i) => "option" + i);
    return rules.length > 0 ? `((${names.join(", ")}) => ${parse})(${rules.join(", ")})` : parse;
}

export function arrayProjectionCode(plan: Projection, refs: string[], other: string, readonly: boolean, emit: Emit) {
    const producers = refs.filter((_, i) => plan.contributes[i]);
    const input = refs.map((ref) => `z.input<typeof ${ref}>`).join(" & ");
    const isArray = "z.getParsedType(value) === z.ZodParsedType.array";
    let array: string;
    if (plan.isDynamic) {
        array = selectedArray(plan, refs, emit, readonly);
    } else {
        const guards = refs.filter((_, i) => !plan.contributes[i]);
        const parser = producers.reduce((left, right) => `${left}.and(${right})`);
        const shouldFreeze = readonly && producers.length > 1;
        // Run guards as native intersections. Their empty outputs cannot restore
        // stripped fields; Zod retains nested issue paths and the caller's error map.
        let validated = shouldFreeze ? "z.unknown().transform(raw => ({ raw }))" : "";
        for (const guard of guards) {
            const empty = `${guard}.transform(() => ({}))`;
            validated = validated ? `${validated}.and(${empty})` : empty;
        }

        array =
            arrayInput(refs) +
            ".pipe(" +
            (validated
                ? `${validated}.and(${parser}.transform(data => ({ data }))).transform(parts => {
                ${shouldFreeze ? freezeMerged + "\nfreeze(parts.data, parts.raw);" : ""}
                return parts.data;
            })`
                : parser) +
            ")";
    }

    const outputs = producers.map((ref) =>
        t.reference(`globalThis.Extract<z.output<typeof ${ref}>, readonly unknown[]>`)
    );
    const output = printTs(
        arrayOutputType(
            outputs,
            plan.presence,
            (i) => t.reference(`z.input<typeof ${refs[i]}>`),
            readonly,
            plan.unionProducers
        )
    );
    // Only narrow successful parses: a failed transform may carry an internal
    // intermediate value, which must not produce another validation issue.
    array = `((parser) => parser.pipe(z.custom<z.output<typeof parser>>().refine((value): value is ${output} =>
        ${isArray})))(${array})`;
    const otherType = plan.presence.some(Boolean)
        ? "globalThis.Exclude<typeof value, readonly unknown[]>"
        : "typeof value";
    return plan.isArrayOnly
        ? array
        : `${array}.or(z.custom<${input}>((value) => !(${isArray})).pipe(${other})
        .refine((value): value is ${otherType} & (string | number | boolean | null | undefined | (object & { [globalThis.Symbol.iterator]?: never })) => !(${isArray})))`;
}
