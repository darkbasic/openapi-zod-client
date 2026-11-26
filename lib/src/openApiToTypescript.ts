import type { ReferenceObject, SchemaObject } from "openapi3-ts";
import { t, ts } from "tanu";
import type { TypeDefinition, TypeDefinitionObject } from "tanu/dist/type";

import { arrayOutputType } from "./arrayItemPresence";
import { arrayProjection } from "./arrayProjection";
import generateJSDocArray from "./generateJSDocArray";
import { isReferenceObject } from "./isReferenceObject";
import { literalType } from "./literalType";
import type { DocumentResolver } from "./makeSchemaResolver";
import { type SchemaInput, normalizeBooleanSchema } from "./normalizeBooleanSchema";
import {
    acceptsNull,
    finiteStructuralAlternatives,
    hasImpossibleRequiredKey,
    hasStructuralKeywords,
    hasStructuralLiteral,
    intersectionOperands,
    needsCompositionBranchNull,
    needsNullableChain,
    normalizeValueSchema,
    oneOfNullGuard,
    requiredAdditionalKeys,
    schemaAssertionParts,
    schemaNegation,
    structuralConditionalParser,
    structuralOneOfDomain,
    structuralOneOfOverlaps,
    structuralTypeUnion,
    useSiteDefault,
} from "./schemaAssertions";
import type { TemplateContext } from "./template-context";
import { primitiveEnumValues, wrapWithQuotesIfNeeded } from "./utils";

type TsConversionArgs = {
    schema: SchemaObject | ReferenceObject;
    ctx?: TsConversionContext | undefined;
    meta?: { name?: string; $ref?: string; isInline?: boolean } | undefined;
    options?: TemplateContext["options"];
};

export type TsConversionContext = {
    nodeByRef: Record<string, ts.Node>;
    resolver: DocumentResolver;
    rootRef?: string;
    visitedsRefs?: Record<string, boolean>;
    input?: boolean;
    hasDistinctInput?: boolean;
    nonArrayOutputs?: WeakSet<object>;
};

type MaybeWrapReadOnlyType =
    | ts.TypeNode
    | {
          [k: string]:
              | number
              | bigint
              | boolean
              | TypeDefinitionObject
              | ts.TypeNode
              | ts.TypeAliasDeclaration
              | ts.InterfaceDeclaration
              | ts.EnumDeclaration;
      };

type ArrayBranch = { type: ts.TypeNode; item?: ts.TypeNode; fixed: boolean };

// An empty array list proves that the schema only produces non-arrays. Undefined
// leaves an opaque type to TypeScript's normal Extract behavior.
type ArrayParts = { arrays: ArrayBranch[] | undefined; other: ts.TypeNode | undefined };
const recursiveArray = t.reference("globalThis.ReadonlyArray", [t.unknown()]);
const extractArray = (type: ts.TypeNode) => ({
    type: t.reference("globalThis.Extract", [type, recursiveArray]),
    fixed: false,
});

function combineArrayParts(node: ts.UnionTypeNode | ts.IntersectionTypeNode, parts: ArrayParts[]): ArrayParts {
    const others = parts.flatMap(({ other }) => other ?? []);
    const isUnchanged = others.every((other, i) => other === node.types[i]) && others.length === node.types.length;
    if (ts.isUnionTypeNode(node))
        return {
            arrays: [...new Set(parts.flatMap(({ arrays }, i) => arrays ?? [extractArray(node.types[i]!)]))],
            other: isUnchanged ? node : others.length > 0 ? t.union(others) : undefined,
        };

    const other = isUnchanged ? node : others.length === parts.length ? t.intersection(others) : undefined;
    if (parts.some(({ arrays }) => arrays?.length === 0)) return { arrays: [], other };
    if (!parts.some(({ arrays }) => arrays)) return { arrays: undefined, other };
    // An opaque conjunct may further constrain a known array or tuple.
    const type = t.intersection(
        parts.map(({ arrays }, i) => (arrays ? t.union(arrays.map((part) => part.type)) : node.types[i]!))
    );
    return { arrays: [{ type, fixed: parts.some(({ arrays }) => arrays?.some((part) => part.fixed)) }], other };
}

// TypeScript can defer Array<Tree>, but evaluating Extract<Array<Tree> | Leaf[], ...>
// or a tuple-length conditional while declaring Tree makes the alias circular. Select
// array alternatives from the emitted type, stopping before their element types.
function recursiveArrayParts(
    types: ts.TypeNode[],
    nonArrayOutputs: WeakSet<object>,
    expand: (name: string) => ts.TypeNode | undefined
) {
    const seen = new Map<string, ArrayParts>();
    const visit = (node: ts.TypeNode): ArrayParts => {
        if (nonArrayOutputs.has(node) || ts.isLiteralTypeNode(node)) return { arrays: [], other: node };
        if (ts.isParenthesizedTypeNode(node)) return visit(node.type);
        if (ts.isTupleTypeNode(node)) return { arrays: [{ type: node, fixed: true }], other: undefined };
        const opaque = { arrays: undefined, other: node };
        if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
            const name = node.typeName.text;
            if (name === "null") return { arrays: [], other: node };
            if (node.typeArguments?.length === 1 && /^(globalThis\.)?(Readonly)?Array$/.test(name))
                return { arrays: [{ type: node, item: node.typeArguments[0]!, fixed: false }], other: undefined };
            if (node.typeArguments) return opaque;
            if (!seen.has(name)) {
                seen.set(name, opaque);
                const target = expand(name);
                if (target) {
                    const parts = visit(target);
                    seen.set(name, {
                        arrays: parts.arrays,
                        other: parts.other && !parts.arrays?.length ? node : parts.other,
                    });
                }
            }

            return seen.get(name)!;
        }

        if (!ts.isUnionTypeNode(node) && !ts.isIntersectionTypeNode(node)) return opaque;
        if (node.types.length === 1) return visit(node.types[0]!);
        return combineArrayParts(node, node.types.map(visit));
    };

    return types.map((type) => {
        const { arrays, other } = visit(type);
        return { arrays: arrays ?? [extractArray(type)], other };
    });
}

function recursiveArrayOutput(groups: ArrayBranch[][], readonly: boolean): ts.TypeNode {
    if (groups.some((group) => group.length === 0)) return t.never();
    if (groups.length === 1) return t.union(groups[0]!.map(({ type }) => type));
    const items = (parts: ArrayBranch[]) =>
        t.union(parts.map(({ type, item }) => item ?? ts.factory.createIndexedAccessTypeNode(type, t.number())));
    const allItems = groups.map(items);
    const list = (types: ts.TypeNode[]) =>
        t.reference(readonly ? "globalThis.ReadonlyArray" : "globalThis.Array", [
            types.length > 0 ? t.intersection(types) : t.unknown(),
        ]);
    // The shared list supplies the array methods. Numeric index signatures preserve
    // each producer's choice across positions without expanding every combination.
    const constraints = groups.flatMap((parts) => {
        if (parts.length === 1) return parts[0]!.fixed ? [parts[0]!.type] : [];
        return [
            t.union(
                parts.map((part) =>
                    part.fixed
                        ? part.type
                        : t.type("", {
                              "readonly [index: number]": items([part]),
                          }).type
                )
            ),
        ];
    });
    return t.intersection([list(allItems), ...constraints]);
}

export const getTypescriptFromOpenApi = (args: Omit<TsConversionArgs, "schema"> & { schema: SchemaInput }) => {
    if (args.schema == null) throw new Error("Schema is required");
    return emitTypescript({ ...args, schema: normalizeBooleanSchema(args.schema) });
};

const emitTypescript = ({
    schema,
    meta: inheritedMeta,
    ctx,
    options,
}: // eslint-disable-next-line sonarjs/cognitive-complexity
TsConversionArgs): ts.Node | TypeDefinitionObject | string => {
    const meta = {} as TsConversionArgs["meta"];
    const isInline = !inheritedMeta?.name;

    const builtinType = (
        name: "Array" | "File" | "Readonly" | "ReadonlyArray" | "Record" | "Exclude" | "Extract",
        args?: TypeDefinition[]
    ) => t.reference(ctx?.resolver.resolveSchemaName(name) ? `globalThis.${name}` : name, args);
    const doWrapReadOnly = (theType: MaybeWrapReadOnlyType) =>
        options?.allReadonly ? builtinType("Readonly", [theType]) : theType;

    if (ctx?.visitedsRefs && inheritedMeta?.$ref) {
        ctx.rootRef = inheritedMeta.$ref;
        ctx.visitedsRefs[inheritedMeta.$ref] = true;
    }

    if (!schema) {
        throw new Error("Schema is required");
    }

    let canBeWrapped = !isInline;
    const getTs = (): ts.Node | TypeDefinitionObject | string => {
        const branchType = (branch: SchemaObject | ReferenceObject) => {
            const operand = structuralTypeUnion(branch, ctx?.resolver) ?? branch;
            const value = emitTypescript({ schema: operand, ctx, meta, options }) as TypeDefinition;
            // The public output alias already includes each scalar's nullable flag. The input of
            // a referenced base validator can be narrower, so keep the branch wrapper on input.
            return needsCompositionBranchNull(operand, ctx?.resolver) && (!("type" in branch) || ctx?.input)
                ? t.union([value, t.reference("null")])
                : value;
        };

        const conditional = structuralConditionalParser(schema, ctx?.resolver, options);
        if (conditional) {
            const value = branchType(conditional.base);
            if (ctx) ctx.hasDistinctInput = true;
            return ctx?.input && !conditional.raw
                ? t.intersection([value, branchType(conditional.allowed)])
                : (value as ts.TypeNode);
        }

        const finite = finiteStructuralAlternatives(schema, ctx?.resolver, options);
        if (finite) {
            const types = finite.map(({ base, literal, canPreserveLiteral }) => {
                const parsed = branchType(base);
                if (!canPreserveLiteral && ctx) {
                    ctx.hasDistinctInput = true;
                    if (!ctx.input) return parsed;
                }

                return t.intersection([parsed, branchType(literal)]);
            });
            return types.length > 0 ? t.union(types) : t.never();
        }

        const withoutNull = (value: TypeDefinition) =>
            t.intersection([value, t.union([ts.factory.createTypeLiteralNode([]), t.undefined()])]);
        const negated = schemaNegation(schema, ctx?.resolver, options);
        if (negated) {
            const value = branchType(negated.positive);
            if (negated.excludesNull === undefined) return value as ts.TypeNode;
            const present = ts.factory.createTypeLiteralNode([]);
            return t.intersection([value, negated.excludesNull ? present : t.union([present, t.reference("null")])]);
        }

        const projected = (operands: Array<SchemaObject | ReferenceObject>, types: TypeDefinition[]) => {
            const all = t.intersection(types);
            const plan =
                !options?.schemaRefiner && arrayProjection(operands, ctx?.resolver, isReferenceObject(schema), options);
            if (!plan || !ctx) return all;
            ctx.hasDistinctInput = true;
            if (ctx.input) return all;
            const array = builtinType("ReadonlyArray", [t.unknown()]);
            const parts = plan.hasRecursiveItems
                ? recursiveArrayParts(
                      types.map((type) => t.intersection([type])),
                      (ctx.nonArrayOutputs ??= new WeakSet()),
                      (name) => {
                          const ref = ctx.resolver.resolveSchemaName(name)?.ref;
                          return ref ? t.intersection([branchType(ctx.resolver.getSchemaByRef(ref))]) : undefined;
                      }
                  )
                : undefined;
            const output = parts
                ? recursiveArrayOutput(
                      parts.flatMap(({ arrays }, i) => (plan.outputContributors[i] ? [arrays] : [])),
                      !!options?.allReadonly
                  )
                : arrayOutputType(
                      plan,
                      (i) => t.intersection([types[i]!]),
                      (i) =>
                          emitTypescript({
                              schema: operands[i]!,
                              ctx: { ...ctx, input: true },
                              meta,
                              options,
                          }) as ts.TypeNode,
                      !!options?.allReadonly
                  );
            if (plan.isArrayOnly || parts?.some(({ other }) => !other)) return output;
            const nonArray = plan.isArrayOrNull
                ? t.reference("null")
                : t.union([
                      t.string(),
                      t.number(),
                      t.boolean(),
                      t.reference("null"),
                      t.undefined(),
                      t.intersection([
                          t.reference("object"),
                          t.type("", { "[globalThis.Symbol.iterator]": t.optional(t.never()) }).type,
                      ]),
                  ]);
            const other = parts
                ? t.intersection(parts.map((part) => part.other!))
                : plan.presence.some(Boolean)
                ? builtinType("Exclude", [all, array])
                : all;
            return t.union([output, t.intersection([other, nonArray])]);
        };

        const parts = schemaAssertionParts(schema, ctx?.resolver);
        if (parts) {
            const operands = intersectionOperands(parts, ctx?.resolver, false);
            const types = operands.map((part, index) => {
                if (
                    index > 0 &&
                    (hasStructuralLiteral(part) || (isReferenceObject(schema) && hasStructuralKeywords(part))) &&
                    ctx
                ) {
                    ctx.hasDistinctInput = true;
                    if (!ctx.input) return t.unknown();
                }

                if (
                    index > 0 &&
                    (part.type === "object" || (Array.isArray(part.type) && part.type.includes("object"))) &&
                    !part.properties &&
                    !part.required &&
                    !part.enum &&
                    !Object.hasOwn(part, "const") &&
                    !part.additionalProperties
                ) {
                    const types = (Array.isArray(part.type) ? part.type : [part.type]).map((kind) =>
                        kind === "object"
                            ? builtinType("Record", [t.string(), t.unknown()])
                            : branchType({ ...part, type: kind })
                    );
                    if (part.nullable && acceptsNull(part, ctx?.resolver)) types.push(t.reference("null"));
                    return t.union(types);
                }

                return branchType(part);
            });
            return "allOf" in schema && schema.allOf ? projected(operands, types) : t.intersection(types);
        }

        if (isReferenceObject(schema)) {
            if (!ctx?.visitedsRefs || !ctx?.resolver) throw new Error("Context is required for OpenAPI $ref");

            let result = ctx.nodeByRef[schema.$ref];
            let schemaName = ctx.resolver.resolveRef(schema.$ref)?.normalized;
            if (ctx.input) {
                return t.reference("z.input", [
                    ts.factory.createTypeQueryNode(ts.factory.createIdentifier(schemaName)),
                ]);
            }

            if (ctx.visitedsRefs[schema.$ref]) {
                return t.reference(schemaName);
            }

            if (!result) {
                const actualSchema = ctx.resolver.getSchemaByRef(schema.$ref);
                if (!actualSchema) {
                    throw new Error(`Schema ${schema.$ref} not found`);
                }

                ctx.visitedsRefs[schema.$ref] = true;
                result = emitTypescript({ schema: actualSchema, meta, ctx, options }) as ts.Node;
            }

            if (!schemaName) {
                schemaName = ctx.resolver.resolveRef(schema.$ref)?.normalized;
            }

            return t.reference(schemaName);
        }

        const normalized = normalizeValueSchema(schema, ctx?.resolver);
        if (normalized) return emitTypescript({ schema: normalized, ctx, meta, options });

        if (!schema.type && schema.enum) {
            return schema.enum.length > 0 ? t.union(schema.enum.map(literalType)) : t.never();
        }

        if (Array.isArray(schema.type)) {
            if (schema.type.length === 1) {
                return emitTypescript({ schema: { ...schema, type: schema.type[0]! }, ctx, meta, options });
            }

            const hasArrayAlternative = schema.type.includes("array") && ctx?.resolver.supportsSchemaRefSiblings;
            const types = schema.type.map((prop) => {
                const value = emitTypescript({
                    schema: { ...schema, type: prop },
                    ctx,
                    meta,
                    options,
                }) as TypeDefinition;
                // Arrays can structurally match {} or a shape such as { length?: number } in TypeScript.
                if (prop !== "object" || !hasArrayAlternative || !hasStructuralKeywords(schema)) return value;
                const object =
                    schema.additionalProperties ?? options?.additionalPropertiesDefaultValue ?? true
                        ? builtinType("Record", [t.string(), t.unknown()])
                        : t.type("", { "[globalThis.Symbol.iterator]": t.optional(t.never()) }).type;
                return t.intersection([value, object]);
            });

            return schema.nullable ? t.union([...types, t.reference("null")]) : t.union(types);
        }

        if (schema.type === "null") {
            return schema.enum && !schema.enum.includes(null) ? t.never() : t.reference("null");
        }

        const composition = schema.oneOf ?? schema.anyOf ?? schema.allOf;
        const compositionType = (type: TypeDefinition, unionMembers: TypeDefinition[] = [type]): ts.TypeNode => {
            if (oneOfNullGuard(schema, ctx?.resolver) === "exclude") {
                return withoutNull(type);
            }

            return needsNullableChain(schema) ? t.union([...unionMembers, t.reference("null")]) : (type as ts.TypeNode);
        };

        if (composition?.length === 1) {
            const type = branchType(composition[0]!);
            return compositionType(type);
        }

        if (schema.oneOf) {
            const types = schema.oneOf.map(branchType);
            const union = compositionType(t.union(types), types);
            const domain = structuralOneOfDomain(structuralOneOfOverlaps(schema.oneOf, ctx?.resolver, options));
            if (!domain) return union;
            const object = t.reference("object");
            const allowedObject = domain.allowsArrays
                ? object
                : t.intersection([object, t.type("", { "[globalThis.Symbol.iterator]": t.optional(t.never()) }).type]);
            return t.intersection([
                union,
                t.union([
                    allowedObject,
                    ...domain.scalars.map((kind) => t[kind]()),
                    t.reference("null"),
                    t.undefined(),
                ]),
            ]);
        }

        // anyOf accepts a value matching at least one branch; it does not imply an array.
        if (schema.anyOf) {
            const oneOf = t.union(schema.anyOf.map(branchType));

            return compositionType(oneOf);
        }

        if (schema.allOf) {
            const operands = intersectionOperands(schema.allOf, ctx?.resolver, !options?.schemaRefiner);
            return compositionType(operands.length > 0 ? projected(operands, operands.map(branchType)) : t.unknown());
        }

        const schemaType = schema.type ? (schema.type.toLowerCase() as NonNullable<typeof schema.type>) : undefined;
        if (schemaType && isPrimitiveType(schemaType)) {
            if (schema.enum) {
                const hasNull = schema.enum.includes(null);
                const withoutNull = primitiveEnumValues(schema.enum, schemaType);
                return hasNull
                    ? t.union([...withoutNull, t.reference("null")])
                    : withoutNull.length > 0
                    ? t.union(withoutNull)
                    : t.never();
            }

            if (schemaType === "string") {
                const type = schema.format === "binary" ? builtinType("File") : t.string();
                return schema.nullable ? t.union([type, t.reference("null")]) : type;
            }

            if (schemaType === "boolean")
                return schema.nullable ? t.union([t.boolean(), t.reference("null")]) : t.boolean();
            if (schemaType === "number" || schemaType === "integer")
                return schema.nullable ? t.union([t.number(), t.reference("null")]) : t.number();
        }

        if (schemaType === "array") {
            let arrayOfType: TypeDefinition = t.any();
            if (schema.items) {
                arrayOfType = emitTypescript({
                    schema: schema.items,
                    ctx,
                    meta,
                    options,
                }) as TypeDefinition;
                if (typeof arrayOfType === "string") {
                    if (!ctx) throw new Error("Context is required for circular $ref (recursive schemas)");
                    arrayOfType = t.reference(arrayOfType);
                }

                // The array applies presence and default modifiers from the item, including siblings of an item $ref.
                if (
                    ctx?.resolver.supportsSchemaRefSiblings &&
                    isReferenceObject(schema.items) &&
                    "nullable" in schema.items &&
                    schema.items.nullable
                ) {
                    arrayOfType = t.union([arrayOfType, t.reference("null")]);
                }

                if (
                    ctx &&
                    options?.withDefaultValues !== false &&
                    useSiteDefault(schema.items, ctx.resolver, "arrayItem", !!options?.schemaRefiner)
                ) {
                    ctx.hasDistinctInput = true;
                    if (ctx.input) arrayOfType = t.union([arrayOfType, t.undefined()]);
                }
            }

            const array = builtinType(options?.allReadonly ? "ReadonlyArray" : "Array", [arrayOfType]);
            return schema.nullable ? t.union([array, t.reference("null")]) : array;
        }

        if (schemaType === "object" || schema.properties || schema.additionalProperties) {
            const isNullable = schema.nullable && schema.enum?.includes(null) !== false;
            const requiredKeys = requiredAdditionalKeys(schema);
            if (hasImpossibleRequiredKey(schema, requiredKeys)) {
                return isNullable ? t.reference("null") : t.never();
            }

            if (!schema.properties && !schema.additionalProperties && requiredKeys.length === 0) {
                const empty = ts.factory.createTypeLiteralNode([]);
                return isNullable ? t.union([empty, t.reference("null")]) : empty;
            }

            canBeWrapped = false;

            const props = Object.fromEntries(
                Object.entries(schema.properties ?? {}).map(([prop, propSchema]) => {
                    let propType = emitTypescript({
                        schema: propSchema,
                        ctx,
                        meta,
                        options,
                    }) as TypeDefinition;
                    if (typeof propType === "string") {
                        if (!ctx) throw new Error("Context is required for circular $ref (recursive schemas)");
                        propType = t.reference(propType);
                    }

                    // Reference declarations hold the base validator. Properties apply the target's nullable chain.
                    if (
                        ctx?.input &&
                        isReferenceObject(propSchema) &&
                        needsCompositionBranchNull(propSchema, ctx.resolver)
                    ) {
                        propType = t.union([propType, t.reference("null")]);
                    }

                    const isRequired = schema.required?.includes(prop);
                    const hasDefault =
                        options?.withDefaultValues !== false &&
                        useSiteDefault(propSchema, ctx?.resolver, undefined, !!options?.schemaRefiner);
                    // A partial object wraps every property in optional(), outside its default.
                    // A checked optional reference may also leave a missing property undefined.
                    const requiredOutput =
                        isRequired ||
                        (hasDefault &&
                            !hasDefault.needsCheck &&
                            (schema.required?.length || options?.withImplicitRequiredProps));
                    if (ctx && hasDefault && requiredOutput) ctx.hasDistinctInput = true;

                    if (!requiredOutput || (ctx?.input && hasDefault)) {
                        const optional = t.optional(propType);
                        if (options?.withDocs) {
                            // Tanu transfers outer comments to the property. The union factory
                            // may parenthesize a documented union or intersection inside it.
                            const value = optional.types[0]!;
                            ts.moveSyntheticComments(optional, ts.isParenthesizedTypeNode(value) ? value.type : value);
                        }

                        propType = optional;
                    }

                    return [wrapWithQuotesIfNeeded(prop), propType];
                })
            );

            let additionalProperties;
            let additionalPropertiesType: ts.TypeNode | undefined;
            if (schema.additionalProperties) {
                const value = schema.additionalProperties;
                let valueType =
                    typeof value === "object" && Object.keys(value).length > 0
                        ? (emitTypescript({ schema: value, ctx, options }) as ts.TypeNode)
                        : t.unknown();
                if (ctx?.input && isReferenceObject(value) && needsCompositionBranchNull(value, ctx.resolver)) {
                    valueType = t.union([valueType, t.reference("null")]);
                }

                additionalPropertiesType = valueType;
                let indexValue = valueType;
                if (
                    ctx &&
                    options?.withDefaultValues !== false &&
                    typeof value === "object" &&
                    useSiteDefault(value, ctx.resolver, "dictionaryEntry", !!options?.schemaRefiner)
                ) {
                    // Extra entries may be supplied as undefined and then defaulted. A required key still needs a value.
                    ctx.hasDistinctInput = true;
                    if (ctx.input) indexValue = t.union([indexValue, t.undefined()]);
                }

                // A string index also covers the explicitly declared keys, whose schemas take precedence at runtime.
                const namedValues = Object.values(props);
                if (namedValues.length > 0 && indexValue.kind !== ts.SyntaxKind.UnknownKeyword) {
                    indexValue = t.union([indexValue, ...namedValues]);
                }

                additionalProperties = ts.factory.createTypeLiteralNode([
                    ts.factory.createIndexSignature(
                        undefined,
                        [
                            ts.factory.createParameterDeclaration(
                                undefined,
                                undefined,
                                ts.factory.createIdentifier("key"),
                                undefined,
                                ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword)
                            ),
                        ],
                        indexValue
                    ),
                ]);
            }

            for (const key of requiredKeys) {
                // Intersect with the sibling's value type while excluding undefined from optional properties.
                const present = t.union([ts.factory.createTypeLiteralNode([]), t.reference("null")]);
                props[JSON.stringify(key)] =
                    additionalPropertiesType && additionalPropertiesType.kind !== ts.SyntaxKind.UnknownKeyword
                        ? t.intersection([additionalPropertiesType, present])
                        : present;
            }

            // Readonly around an intersection causes a circular alias for recursive dictionaries.
            const objectType = additionalProperties
                ? Object.keys(props).length > 0
                    ? t.intersection([doWrapReadOnly(props), doWrapReadOnly(additionalProperties)])
                    : doWrapReadOnly(additionalProperties)
                : doWrapReadOnly(props);

            // Materialize inline objects as TypeNodes too, including index-signature values.
            const declaration = t.type(
                inheritedMeta?.name ?? "",
                isNullable ? t.union([objectType, t.reference("null")]) : objectType
            );
            return isInline ? declaration.type : declaration;
        }

        if (!schemaType) return t.unknown();
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw new Error(`Unsupported schema type: ${schemaType}`);
    };

    let tsResult = getTs();

    // A declared JSON object (including an empty or readonly object) cannot parse an
    // array. The same TypeScript shape can also represent a broader guard, so retain
    // this fact from the schema instead of guessing from its emitted object shape.
    if (
        ctx &&
        !ctx.input &&
        typeof tsResult === "object" &&
        !isReferenceObject(schema) &&
        ((schema.type && schema.type !== "array" && !(Array.isArray(schema.type) && schema.type.includes("array"))) ||
            (schema.enum && !schema.enum.some(Array.isArray)))
    ) {
        (ctx.nonArrayOutputs ??= new WeakSet()).add(tsResult);
    }

    // Add JSDoc comments
    if (options?.withDocs && !isReferenceObject(schema)) {
        const jsDocComments = generateJSDocArray(schema);

        if (
            jsDocComments.length > 0 &&
            typeof tsResult === "object" &&
            tsResult.kind !== ts.SyntaxKind.TypeAliasDeclaration
        ) {
            tsResult = t.comment(tsResult, jsDocComments);
        }
    }

    return canBeWrapped
        ? wrapTypeIfInline({ isInline, name: inheritedMeta?.name, typeDef: tsResult as TypeDefinition })
        : tsResult;
};

type SingleType = Exclude<SchemaObject["type"], any[] | undefined>;
const isPrimitiveType = (type: SingleType): type is PrimitiveType => primitiveTypeList.includes(type as any);

const primitiveTypeList = ["string", "number", "integer", "boolean", "null"] as const;
type PrimitiveType = typeof primitiveTypeList[number];

const wrapTypeIfInline = ({
    isInline,
    name,
    typeDef,
}: {
    isInline: boolean;
    name: string | undefined;
    typeDef: t.TypeDefinition;
}) => {
    if (!isInline) {
        if (!name) {
            throw new Error("Name is required to convert a schema to a type reference");
        }

        return t.type(name, typeDef);
    }

    return typeDef as ts.Node;
};
