import type { ReferenceObject, SchemaObject } from "openapi3-ts";
import { t, ts } from "tanu";
import type { TypeDefinition, TypeDefinitionObject } from "tanu/dist/type";

import generateJSDocArray from "./generateJSDocArray";
import { isReferenceObject } from "./isReferenceObject";
import type { DocumentResolver } from "./makeSchemaResolver";
import { type SchemaInput, normalizeBooleanSchema } from "./normalizeBooleanSchema";
import {
    acceptsNull,
    applicableStructuralOperand,
    hasImpossibleRequiredKey,
    hasStructuralKeywords,
    hasStructuralLiteral,
    intersectionOperands,
    needsCompositionBranchNull,
    needsNullableChain,
    normalizeLiteralAssertion,
    oneOfNullGuard,
    requiredAdditionalKeys,
    schemaAssertionParts,
    schemaNegation,
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

const literalType = (value: unknown): TypeDefinition => {
    if (Array.isArray(value)) return t.tuple(value.map(literalType));
    if (value && typeof value === "object") {
        return t.type(
            "",
            Object.fromEntries(Object.entries(value).map(([key, item]) => [JSON.stringify(key), literalType(item)]))
        ).type;
    }

    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
    return t.reference("null");
};

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

    const builtinType = (name: "Array" | "File" | "Readonly" | "Record" | "Exclude", args?: TypeDefinition[]) =>
        t.reference(ctx?.resolver.resolveSchemaName(name) ? `globalThis.${name}` : name, args);
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
            const operand = applicableStructuralOperand(branch);
            const value = emitTypescript({ schema: operand, ctx, meta, options }) as TypeDefinition;
            // The public output alias already includes each scalar's nullable flag. The input of
            // a referenced base validator can be narrower, so keep the branch wrapper on input.
            return needsCompositionBranchNull(operand, ctx?.resolver) && (!("type" in branch) || ctx?.input)
                ? t.union([value, t.reference("null")])
                : value;
        };

        const withoutNull = (value: TypeDefinition) =>
            t.intersection([value, t.union([ts.factory.createTypeLiteralNode([]), t.undefined()])]);
        const negated = schemaNegation(schema, ctx?.resolver);
        if (negated) {
            const value = branchType(negated.positive);
            if (negated.excludesNull === undefined) return value as ts.TypeNode;
            const present = ts.factory.createTypeLiteralNode([]);
            return t.intersection([value, negated.excludesNull ? present : t.union([present, t.reference("null")])]);
        }

        const parts = schemaAssertionParts(schema, ctx?.resolver);
        if (parts) {
            return t.intersection(
                intersectionOperands(parts, ctx?.resolver).map((part, index) => {
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
                })
            );
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

        const literal = normalizeLiteralAssertion(schema, ctx?.resolver);
        if (literal) return emitTypescript({ schema: literal, ctx, meta, options });

        if (!schema.type && schema.enum) {
            return schema.enum.length > 0 ? t.union(schema.enum.map(literalType)) : t.never();
        }

        if (Array.isArray(schema.type)) {
            if (schema.type.length === 1) {
                return emitTypescript({
                    schema: { ...schema, type: schema.type[0]! },
                    ctx,
                    meta,
                    options,
                });
            }

            const types = schema.type.map(
                (prop) =>
                    emitTypescript({
                        schema: { ...schema, type: prop },
                        ctx,
                        meta,
                        options,
                    }) as TypeDefinition
            );

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

            return compositionType(t.union(types), types);
        }

        // anyOf accepts a value matching at least one branch; it does not imply an array.
        if (schema.anyOf) {
            const oneOf = t.union(schema.anyOf.map(branchType));

            return compositionType(oneOf);
        }

        if (schema.allOf) {
            return compositionType(
                schema.allOf.length > 0
                    ? t.intersection(intersectionOperands(schema.allOf, ctx?.resolver).map(branchType))
                    : t.unknown()
            );
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

            const array = doWrapReadOnly(builtinType("Array", [arrayOfType]));
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
                    if (ctx && isRequired && hasDefault) ctx.hasDistinctInput = true;

                    if (!isRequired || (ctx?.input && hasDefault)) {
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
