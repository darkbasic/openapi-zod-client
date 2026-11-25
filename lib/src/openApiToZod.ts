import type { ReferenceObject, SchemaObject } from "openapi3-ts";
import { match } from "ts-pattern";

import type { CodeMetaData, ConversionTypeContext } from "./CodeMeta";
import { CodeMeta } from "./CodeMeta";
import { isReferenceObject } from "./isReferenceObject";
import { type SchemaInput, normalizeBooleanSchema } from "./normalizeBooleanSchema";
import { getZodChainableStringValidations, numberBounds } from "./scalarBounds";
import {
    applicableStructuralOperand,
    getSchemaReferenceChain,
    hasImpossibleRequiredKey,
    hasNullableObjectType,
    hasStructuralKeywords,
    hasStructuralLiteral,
    hasUntypedValueChecks,
    intersectionOperands,
    isObjectOrNull,
    isUntypedStructural,
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
import { isPrimitiveType, primitiveEnumValues, wrapWithQuotesIfNeeded } from "./utils";

type ConversionArgs = {
    schema: SchemaObject | ReferenceObject;
    ctx?: ConversionTypeContext | undefined;
    meta?: CodeMetaData | undefined;
    options?: TemplateContext["options"] | undefined;
};

const unwrapSingleType = (type: SchemaObject["type"]) => (Array.isArray(type) && type.length === 1 ? type[0] : type);

// Object references can occur in array items and composition branches without a use-site chain.
const hasNullableObjectBase = (schema: SchemaObject | ReferenceObject) =>
    !isReferenceObject(schema) &&
    hasNullableObjectType(schema) &&
    schema.enum?.includes(null) !== false &&
    !schema.oneOf &&
    !schema.anyOf &&
    !schema.allOf;

const discriminatorType = (type: SchemaObject["type"]) => (isObjectOrNull(type) ? "object" : unwrapSingleType(type));

const hasCompositionWrapper = (schema: SchemaObject | ReferenceObject, ctx: ConversionArgs["ctx"]) =>
    !!(schemaAssertionParts(schema, ctx?.resolver) ?? schemaNegation(schema, ctx?.resolver));

// Zod 3 reads each option's object shape when constructing a discriminated union.
function discriminatorOption(
    option: SchemaObject | ReferenceObject,
    key: string,
    usedTags: Set<unknown>,
    ctx: ConversionArgs["ctx"],
    options: ConversionArgs["options"]
) {
    let schema = option;
    let hasOpaqueShape = false;
    const seen = new Set<string>();
    while (isReferenceObject(schema) || schema.oneOf || schema.anyOf || schema.allOf) {
        hasOpaqueShape ||= hasCompositionWrapper(schema, ctx);
        if (isReferenceObject(schema)) {
            const ref = schema.$ref;
            if (!ctx || seen.has(ref)) return;
            seen.add(ref);
            // A lazy or explicitly typed reference does not expose a ZodObject shape.
            hasOpaqueShape ||= !!options?.shouldExportAllTypes || !!ctx.deepDependencyGraph?.[ref]?.has(ref);
            schema = ctx.resolver.getSchemaByRef(ref);
            if (!schema) return;
        } else {
            const composite = schema.oneOf ?? schema.anyOf ?? schema.allOf;
            if (composite?.length !== 1 || Array.isArray(discriminatorType(schema.type))) return;
            hasOpaqueShape ||= isObjectOrNull(schema.type);
            schema = composite[0]!;
        }
    }

    const objectType = discriminatorType(schema.type);
    if (
        (objectType && objectType !== "object") ||
        !Object.hasOwn(schema.properties ?? {}, key) ||
        hasImpossibleRequiredKey(schema)
    )
        return;
    const tagLayers = getSchemaReferenceChain(schema.properties![key]!, ctx?.resolver);
    const tag = tagLayers.at(-1);
    const isRequired = schema.required?.length ? schema.required.includes(key) : options?.withImplicitRequiredProps;
    const values = discriminatorValues(tag, !isRequired, ctx?.resolver);
    hasOpaqueShape ||=
        isObjectOrNull(schema.type) ||
        !!hasNullableObjectBase(schema) ||
        needsCompositionBranchNull(schema, ctx?.resolver) ||
        hasCompositionWrapper(schema, ctx);
    const hasWrappedTag = tagLayers.some((layer) => hasCompositionWrapper(layer, ctx));
    let canDispatch = !hasOpaqueShape && !hasWrappedTag && values.length > 0;
    for (const value of values) {
        if (usedTags.has(value)) canDispatch = false;
        usedTags.add(value);
    }

    const needsTagCheck =
        isRequired &&
        options?.withDefaultValues !== false &&
        tagLayers.some((layer) => "default" in layer && layer.default !== undefined);
    return { canDispatch, needsTagCheck };
}

function discriminatorValues(
    tag: SchemaObject | ReferenceObject | undefined,
    isOptional: boolean,
    resolver: ConversionTypeContext["resolver"] | undefined
): unknown[] {
    if (!tag || isReferenceObject(tag)) return [];
    tag = normalizeLiteralAssertion(tag, resolver) ?? tag;
    const tagType = unwrapSingleType(tag.type);
    if (!tagType || Array.isArray(tagType) || !isPrimitiveType(tagType) || tag.oneOf || tag.anyOf || tag.allOf)
        return [];
    const values: unknown[] = primitiveEnumValues(tag.enum ?? (tagType === "null" ? [null] : []), tagType);
    // A multi-value numeric/boolean enum emits a ZodUnion, from which Zod 3 cannot extract discriminator values.
    if (tagType !== "string" && values.length > 1) return [];
    if (tagType !== "null" && (tag.enum?.includes(null) || (values.length > 0 && tag.nullable))) values.push(null);
    if (isOptional && values.length > 0) values.push(undefined);
    return values;
}

// Zod literals represent primitives. JSON object and array literals also require exact keys/positions.
const literalSchema = (value: unknown): string => {
    if (Array.isArray(value)) return `z.tuple([${value.map(literalSchema).join(", ")}])`;
    if (value && typeof value === "object") {
        const properties = Object.entries(value).map(
            ([key, item]) => `[${JSON.stringify(key)}]: ${literalSchema(item)}`
        );
        return `z.object({ ${properties.join(", ")} }).strict()`;
    }

    return `z.literal(${JSON.stringify(value)})`;
};

/**
 * @see https://github.com/OAI/OpenAPI-Specification/blob/main/versions/3.0.3.md#schemaObject
 * @see https://github.com/colinhacks/zod
 */

export function getZodSchema(args: Omit<ConversionArgs, "schema"> & { schema: SchemaInput }): CodeMeta {
    if (args.schema == null) throw new Error("Schema is required");
    return emitZodSchema({ ...args, schema: normalizeBooleanSchema(args.schema) });
}

// eslint-disable-next-line sonarjs/cognitive-complexity
function emitZodSchema({ schema: $schema, ctx, meta: inheritedMeta, options }: ConversionArgs): CodeMeta {
    if (!$schema) {
        throw new Error("Schema is required");
    }

    const schema = options?.schemaRefiner
        ? normalizeBooleanSchema(options.schemaRefiner($schema, inheritedMeta) ?? $schema)
        : $schema;
    const negated = schemaNegation(schema, ctx?.resolver);
    const parts = negated ? undefined : schemaAssertionParts(schema, ctx?.resolver);
    // A reference with siblings is a composition. Only its actual reference operand enters the recursion stack.
    const expressionSchema = negated ? { allOf: [negated.positive] } : parts ? { allOf: parts } : schema;
    const code = new CodeMeta(expressionSchema, ctx, inheritedMeta);
    const meta = {
        parent: code.inherit(inheritedMeta?.parent),
        referencedBy: [...code.meta.referencedBy],
    };

    const branchCode = (branch: SchemaObject | ReferenceObject) => {
        const operand = applicableStructuralOperand(branch);
        const value = emitZodSchema({ schema: operand, ctx, meta, options }).toString();
        return needsCompositionBranchNull(operand, ctx?.resolver) ? value + ".nullable()" : value;
    };

    if (negated) {
        const shouldRejectNull = negated.excludesNull === true;
        const narrow = shouldRejectNull ? " & (globalThis.NonNullable<unknown> | undefined)" : "";
        const base = branchCode(negated.positive);
        if (!negated.excluded && !shouldRejectNull) return code.assign(base);
        const rule = negated.excluded ? branchCode(negated.excluded) : "z.null()";
        return code.assign(guardInput(base, rule, true, narrow));
    }

    const conjunction = parts ?? (!isReferenceObject(schema) && schema.allOf);
    if (conjunction) {
        if (conjunction.length === 0) return code.assign("z.unknown()");
        const operands = intersectionOperands(conjunction, ctx?.resolver);
        let expression = branchCode(operands[0]!);
        for (const operand of operands.slice(1)) {
            const sibling: SchemaObject = { ...operand };
            const rule = branchCode(sibling);
            if (hasStructuralLiteral(sibling) || (isReferenceObject(schema) && hasStructuralKeywords(sibling))) {
                expression = guardInput(expression, rule);
                continue;
            }

            if (
                !sibling.type &&
                hasUntypedValueChecks(sibling) &&
                !sibling.properties &&
                !sibling.required &&
                !sibling.items &&
                !sibling.enum &&
                !Object.hasOwn(sibling, "const") &&
                sibling.additionalProperties === undefined
            ) {
                expression = guardInput(expression, rule);
                continue;
            }

            if (isUntypedStructural(sibling)) {
                // Object parsers may contribute defaults/fields. For other JSON values preserve the base's parsed
                // result: an intersection would merge raw array elements back over the parsed array.
                expression = `((base, rule) => z.custom<z.input<typeof base> & z.input<typeof rule>>(
                    (value) => z.getParsedType(value) !== z.ZodParsedType.object && rule.safeParse(value).success)
                    .pipe(base).refine((value): value is typeof value & z.output<typeof rule> => rule.safeParse(value).success)
                    .or(base.and(rule)))(${expression}, ${rule})`;
                continue;
            }

            // A type guard must preserve the original parser's output (stripped keys, defaults and readonly).
            expression =
                parts &&
                ((sibling.type &&
                    !sibling.properties &&
                    !sibling.required &&
                    !sibling.items &&
                    sibling.additionalProperties === undefined) ||
                    sibling.enum ||
                    Object.hasOwn(sibling, "const"))
                    ? intersectTypeGuard(expression, rule)
                    : `${expression}.and(${rule})`;
        }

        return code.assign(expression);
    }

    const refsPath = code.meta.referencedBy
        .slice(0, -1)
        .map((prev) => (ctx ? ctx.resolver.resolveRef(prev.ref!).normalized : prev.ref!));

    if (isReferenceObject(schema)) {
        if (!ctx) throw new Error("Context is required");

        const schemaName = ctx.resolver.resolveRef(schema.$ref)?.normalized;

        // circular(=recursive) reference
        if (refsPath.length > 1 && refsPath.includes(schemaName)) {
            return code.assign(ctx.zodSchemaByName[code.ref!]!);
        }

        let result = ctx.zodSchemaByName[schema.$ref];
        if (!result) {
            const actualSchema = ctx.resolver.getSchemaByRef(schema.$ref);
            if (!actualSchema) {
                throw new Error(`Schema ${schema.$ref} not found`);
            }

            result = emitZodSchema({ schema: actualSchema, ctx, meta, options }).toString();
        }

        if (ctx.zodSchemaByName[schemaName]) {
            return code;
        }

        ctx.zodSchemaByName[schemaName] = result;

        return code;
    }

    const literal = normalizeLiteralAssertion(schema, ctx?.resolver);
    if (literal) return emitZodSchema({ schema: literal, ctx, meta, options });

    if (!schema.type && schema.enum) {
        const members = schema.enum.map(literalSchema);
        const base = members.length > 1 ? `z.union([${members.join(", ")}])` : members[0] ?? "z.never()";
        return code.assign(base + untypedValueChecks(schema));
    }

    if (Array.isArray(schema.type)) {
        if (schema.type.length === 1) {
            return emitZodSchema({ schema: { ...schema, type: schema.type[0]! }, ctx, meta, options });
        }

        return code.assign(
            `z.union([${schema.type
                .map((prop) => emitZodSchema({ schema: { ...schema, type: prop }, ctx, meta, options }))
                .join(", ")}])`
        );
    }

    if (schema.type === "null") {
        return code.assign(schema.enum && !schema.enum.includes(null) ? "z.never()" : "z.null()");
    }

    const assignComposition = (expression: string) => {
        const guard = oneOfNullGuard(schema, ctx?.resolver);
        if (guard === "exclude") {
            return code.assign(`((schema) => z.custom<z.input<typeof schema> & (globalThis.NonNullable<unknown> | undefined)>((value) => value !== null)
                .pipe(schema).refine((value): value is typeof value & (globalThis.NonNullable<unknown> | undefined) => value !== null))(${expression})`);
        }

        return code.assign(expression);
    };

    if (schema.oneOf) {
        if (schema.oneOf.length === 1) {
            const type = branchCode(schema.oneOf[0]!);
            return assignComposition(type.toString());
        }

        let types = schema.oneOf.map(branchCode);
        if (schema.discriminator) {
            const propertyName = schema.discriminator.propertyName;
            const usedTags = new Set<unknown>();
            const branches = schema.oneOf.map((option) =>
                discriminatorOption(option, propertyName, usedTags, ctx, options)
            );
            const key = JSON.stringify(propertyName);
            const readonly = options?.allReadonly ? ".readonly()" : "";
            if (branches.every((branch) => branch?.canDispatch)) {
                const objects = options?.allReadonly ? types.map((type) => `${type}.unwrap()`) : types;
                return assignComposition(`
                z.discriminatedUnion(${key}, [${objects.join(", ")}])${readonly}
            `);
            }

            if (branches.some((branch) => branch?.needsTagCheck)) {
                // A plain union sees defaults during parsing. Discriminator dispatch checks the raw tag first.
                types = types.map((type, index) =>
                    branches[index]?.needsTagCheck
                        ? `((schema) => z.custom<z.input<typeof schema>>((value) => value === null || (value !== undefined && value[${key}] !== undefined)).pipe(schema))(${type})`
                        : type
                );
            }
        }

        return assignComposition(`z.union([${types.join(", ")}])`);
    }

    // anyOf accepts a value matching at least one branch; it does not imply an array.
    if (schema.anyOf) {
        if (schema.anyOf.length === 1) {
            const type = branchCode(schema.anyOf[0]!);
            return assignComposition(type.toString());
        }

        const types = schema.anyOf.map(branchCode).join(", ");

        return assignComposition(`z.union([${types}])`);
    }

    const schemaType = schema.type ? (schema.type.toLowerCase() as NonNullable<typeof schema.type>) : undefined;
    if (schemaType && isPrimitiveType(schemaType)) {
        if (schema.enum) {
            const primitiveType = schemaType === "integer" ? "number" : schemaType;
            const values = primitiveEnumValues(schema.enum, schemaType);
            const hasNull = schema.enum.includes(null);
            if (values.length === 0) {
                return code.assign(hasNull ? "z.null()" : "z.never()");
            }

            const literals = values.map((value) => JSON.stringify(value));
            const literalSchemas = literals.map((value) => `z.literal(${value})`);
            const enumSchema =
                values.length === 1
                    ? `z.literal(${literals[0]})`
                    : schemaType === "string"
                    ? `z.enum([${literals.join(", ")}])`
                    : `z.union([${literalSchemas.join(", ")}])`;
            const rule =
                primitiveType === "string"
                    ? getZodChainableStringValidations(schema)
                    : primitiveType === "number"
                    ? getZodChainableNumberValidations({ ...schema, type: "number" })
                    : "";
            // Keep literal output types and discriminator values when an enum also declares constraints.
            const checked = rule
                ? `${enumSchema}.refine(((check) => (value: unknown) => check.safeParse(value).success)(z.${primitiveType}().${rule}))`
                : enumSchema;
            return code.assign(`${checked}${hasNull ? ".nullable()" : ""}`);
        }

        return code.assign(
            match(schemaType)
                .with(
                    "integer",
                    "number",
                    () => "z.number()" + validationSuffix(getZodChainableNumberValidations(schema))
                )
                .with("string", () =>
                    match(schema.format)
                        .with("binary", () => {
                            const shouldQualifyFile =
                                ctx?.resolver.resolveSchemaName("File") &&
                                !ctx.resolver.resolveSchemaName("globalThis");
                            return shouldQualifyFile ? "z.instanceof(globalThis.File)" : "z.instanceof(File)";
                        })
                        .otherwise(() => "z.string()" + validationSuffix(getZodChainableStringValidations(schema)))
                )
                .otherwise((type) => `z.${type}()`)
        );
    }

    const readonly = options?.allReadonly ? ".readonly()" : "";

    if (schemaType === "array") {
        const item = schema.items
            ? applyUseSite(
                  emitZodSchema({ schema: schema.items, ctx, meta, options }).toString(),
                  {
                      schema: schema.items,
                      ctx,
                      meta: { ...meta, isRequired: true },
                      options,
                  },
                  "arrayItem"
              )
            : "z.any()";
        return code.assign(`z.array(${item})${validationSuffix(getZodChainableArrayValidations(schema))}${readonly}`);
    }

    if (schemaType === "object" || schema.properties || schema.additionalProperties) {
        const objectSchema = (expression: string) =>
            code.assign(hasNullableObjectBase(schema) ? expression + ".nullable()" : expression);
        const requiredKeys = requiredAdditionalKeys(schema);
        if (hasImpossibleRequiredKey(schema, requiredKeys)) {
            return objectSchema("z.never()");
        }

        const additional = schema.additionalProperties;
        const valueSchema =
            additional && typeof additional === "object" && Object.keys(additional).length > 0
                ? getDictionaryValueSchema({ schema: additional, ctx, meta, options })
                : undefined;
        if (valueSchema && requiredKeys.length === 0 && Object.keys(schema.properties ?? {}).length === 0) {
            return objectSchema(`z.record(${valueSchema})${readonly}`);
        }

        const hasRequiredArray = schema.required && schema.required.length > 0;
        const isPartial = options?.withImplicitRequiredProps ? false : !schema.required?.length;
        const entries = Object.entries(schema.properties ?? {}).map(([prop, propSchema]) => {
            const propMetadata = {
                ...meta,
                isRequired: isPartial
                    ? true
                    : hasRequiredArray
                    ? schema.required?.includes(prop)
                    : options?.withImplicitRequiredProps,
                name: prop,
            } as CodeMetaData;

            const propCode = applyUseSite(
                emitZodSchema({ schema: propSchema, ctx, meta: propMetadata, options }).toString(),
                { schema: propSchema, ctx, meta: propMetadata, options }
            );

            return `${wrapWithQuotesIfNeeded(prop)}: ${propCode}`;
        });
        const presentType = "globalThis.NonNullable<unknown> | null";
        if (!valueSchema) {
            const present = `z.custom<${presentType}>((value) => value !== undefined)`;
            entries.push(...requiredKeys.map((key) => `${JSON.stringify(key)}: ${present}`));
        }

        const properties = entries.length > 0 ? `{ ${entries.join(", ")} }` : "{}";

        const partial = isPartial ? ".partial()" : "";
        const strict = options?.strictObjects ? ".strict()" : "";
        const object = `z.object(${properties})${partial}${strict}`;
        if (valueSchema) {
            const declarations: string[] = [];
            let shape = "object";
            if (requiredKeys.length > 0) {
                const requiredShape = requiredKeys.map((key) => `${JSON.stringify(key)}: required`).join(", ");
                declarations.push(`const present = <T>(value: T): value is T & (${presentType}) => value !== undefined;
                    const required = z.custom<z.input<typeof schema> & (${presentType})>(present).pipe(schema).refine(present);`);
                shape += `.extend({ ${requiredShape} })`;
            }

            let catchall = "schema";
            if (entries.length > 0) {
                // An index signature also covers the named properties. Widen its type while retaining the same validator.
                declarations.push(`type Named = (typeof object.shape)[keyof typeof object.shape];
                    const extra: z.ZodType<z.output<typeof schema> | z.output<Named>, z.ZodTypeDef, z.input<typeof schema> | z.input<Named>> = schema;`);
                // Zod 3 drops the index signature for a bare ZodType catchall. ZodLazy keeps the concrete type.
                catchall = "z.lazy(() => extra)";
            }

            return objectSchema(`((object, schema) => {
                ${declarations.join("\n")}
                return ${shape}.catchall(${catchall});
            })(${object}, ${valueSchema})${readonly}`);
        }

        const allowAdditional = additional ?? options?.additionalPropertiesDefaultValue ?? true;
        const extras = allowAdditional ? ".passthrough()" : "";
        return objectSchema(`${object}${extras}${readonly}`);
    }

    if (!schemaType) return code.assign("z.unknown()" + untypedValueChecks(schema));

    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    throw new Error(`Unsupported schema type: ${schemaType}`);
}

function getDictionaryValueSchema({ schema, ctx, meta, options }: ConversionArgs): string {
    const value = emitZodSchema({ schema, ctx, meta, options }).toString();
    return applyUseSite(value, { schema, ctx, meta: { ...meta, isRequired: true }, options }, "dictionaryEntry");
}

// Check the supplied value before the base schema strips keys or fills defaults.
function guardInput(base: string, rule: string, negated = false, nonNullable = ""): string {
    const outputGuard = nonNullable ? `.refine((value): value is typeof value${nonNullable} => value !== null)` : "";
    return `((base, rule) => z.custom<z.input<typeof base>${
        negated ? nonNullable : " & z.input<typeof rule>"
    }>((value) => ${negated ? "!" : ""}rule.safeParse(value).success)
        .pipe(base)${outputGuard})(${base}, ${rule})`;
}

const intersectTypeGuard = (base: string, rule: string) =>
    `((base, rule) => z.custom<z.input<typeof base> & z.input<typeof rule>>((value) => rule.safeParse(value).success)
        .pipe(base).refine((value): value is typeof value & z.output<typeof rule> => rule.safeParse(value).success))(${base}, ${rule})`;

// Without a type, a validation keyword constrains only instances of its own kind.
function untypedValueChecks(schema: SchemaObject): string {
    const rules = [
        [getZodChainableStringValidations(schema), "z.string()", 'typeof value !== "string"'],
        [getZodChainableNumberValidations(schema), "z.number()", 'typeof value !== "number"'],
        [
            getZodChainableArrayValidations(schema),
            "z.array(z.unknown())",
            "z.getParsedType(value) !== z.ZodParsedType.array",
        ],
    ];
    return rules
        .filter(([chain]) => chain)
        .map(
            ([chain, base, other]) =>
                `.refine(((rule) => (value: unknown) => ${other} || rule.safeParse(value).success)(${base}.${chain}))`
        )
        .join("");
}

// Apply presence and defaults after composing all of a reference's value assertions.
export function applyUseSite(
    base: string,
    { schema: input, ctx, meta, options }: ConversionArgs,
    site?: "arrayItem" | "dictionaryEntry"
): string {
    const schema = typeof input === "boolean" ? normalizeBooleanSchema(input) : input;
    if (!isReferenceObject(schema)) return base + getZodChain({ schema, meta, options });
    const target = ctx?.resolver.getSchemaByRef(schema.$ref);
    if (!target || !ctx) throw new Error(`Schema ${schema.$ref} not found`);
    const hasRefAssertions = hasCompositionWrapper(schema, ctx);
    // Properties and endpoints inherit format and presence. Array items use local modifiers;
    // dictionary entries acquire nullability from the complete reference chain.
    const modifiers: SchemaObject =
        site === "arrayItem"
            ? ctx.resolver.supportsSchemaRefSiblings
                ? { ...schema }
                : {}
            : site === "dictionaryEntry"
            ? { nullable: needsCompositionBranchNull(schema, ctx.resolver) }
            : ctx.resolver.supportsSchemaRefSiblings &&
              "description" in schema &&
              typeof schema.description === "string"
            ? { ...target, description: schema.description }
            : target;
    const defaults =
        options?.withDefaultValues === false
            ? undefined
            : useSiteDefault(schema, ctx.resolver, site, !!options?.schemaRefiner);
    if (!defaults?.needsCheck) {
        return (
            base +
            getZodChain({
                schema: { ...modifiers, default: defaults?.owner.default },
                hasRefAssertions: !site && hasRefAssertions,
                meta,
                options,
            })
        );
    }

    // An annotation can fail a value refinement. For an omitted optional field Zod
    // may then take the ordinary optional branch. Supplied values always go through the parser.
    const present =
        base +
        getZodChain({
            schema: { ...modifiers, default: undefined },
            hasRefAssertions: !site && hasRefAssertions,
            meta: { ...meta, isRequired: true },
            options,
        });
    const candidate = defaults.owner.default;
    const onInvalid = meta?.isRequired
        ? "for (const issue of result.error.issues) ctx.addIssue(issue); return z.NEVER;"
        : "return undefined;";
    const parseDefault = `const result = schema.safeParse(${JSON.stringify(candidate)});
        if (result.success) return result.data; ${onInvalid}`;
    if (
        candidate !== null &&
        typeof candidate === "object" &&
        ctx.deepDependencyGraph?.[schema.$ref]?.has(schema.$ref)
    ) {
        // An object default can contain this very same missing property. Complete any supplied
        // children and stop materializing a default at its first recursive re-entry.
        ctx.needsStableRecursiveDefaults = true;
        const onCycle = meta?.isRequired
            ? 'ctx.addIssue({ code: "custom", message: "A required default cannot recursively supply itself" }); return z.NEVER;'
            : "return undefined;";
        return `((schema) => { let applying = false;
            return schema.optional().transform((value, ctx) => {
                if (value !== undefined) return value;
                if (applying) { ${onCycle} }
                applying = true;
                try { ${parseDefault} } finally { applying = false; }
            }); })(${present})`;
    }

    return `((schema) => schema.optional().transform((value, ctx) => {
        if (value !== undefined) return value; ${parseDefault}
    }))(${present})`;
}

type ZodChainArgs = {
    schema: SchemaObject;
    hasRefAssertions?: boolean;
    meta?: CodeMetaData | undefined;
    options?: TemplateContext["options"];
};

const getZodChain = ({ schema, meta, options, hasRefAssertions }: ZodChainArgs) => {
    const chains: string[] = [];

    // Keep the historical Zod format checks at typed string use sites. OpenAPI formats
    // are annotations; these library-specific assertions need not hold for every reference.
    if (schema.type === "string") {
        const format = match(schema.format)
            .with("email", () => "email()")
            .with("uri", () => "url()")
            .with("uuid", () => "uuid()")
            .with("date-time", () => "datetime({ offset: true })")
            .otherwise(() => "");
        if (format) {
            const isWrapped =
                isReferenceObject(schema) ||
                !!(schema.enum ?? schema.oneOf ?? schema.anyOf ?? schema.allOf ?? schema.not) ||
                "const" in schema ||
                !!hasRefAssertions;
            chains.push(
                isWrapped
                    ? `refine(((rule) => (value: unknown) => typeof value !== "string" || rule.safeParse(value).success)(z.string().${format}))`
                    : format
            );
        }
    }

    if (typeof schema.description === "string" && schema.description !== "" && options?.withDescription) {
        chains.push(`describe(${JSON.stringify(schema.description)})`);
    }

    const output = chains
        .concat(
            getZodChainablePresence(hasRefAssertions ? { ...schema, nullable: false } : schema, meta),
            options?.withDefaultValues !== false ? getZodChainableDefault(schema) : []
        )
        .filter(Boolean)
        .join(".");
    return validationSuffix(output);
};

const validationSuffix = (chain: string) => (chain ? `.${chain}` : "");

const getZodChainablePresence = (schema: SchemaObject, meta?: CodeMetaData) => {
    if (needsNullableChain(schema)) {
        return meta?.isRequired ? "nullable()" : "nullish()";
    }

    if (!meta?.isRequired) {
        return "optional()";
    }

    return "";
};

// TODO OA prefixItems -> z.tuple
const unwrapQuotesIfNeeded = (value: string | number) => {
    if (typeof value === "string" && value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1);
    }

    return value;
};

const getZodChainableDefault = (schema: SchemaObject) => {
    if (schema.default !== undefined) {
        const value = match(schema.type)
            .with("number", "integer", () => unwrapQuotesIfNeeded(schema.default))
            .otherwise(() => JSON.stringify(schema.default));
        return `default(${value})`;
    }

    return "";
};

// Zod 3's multipleOf rounds exponent-form operands with toFixed. Compare decimal
// coefficients at the same scale instead. The shortest decimal representation is
// the information available once the JSON numbers have been parsed by JavaScript.
function multipleOfValidation(step: number): string {
    if (!Number.isFinite(step) || step <= 0) throw new Error("multipleOf requires a positive finite number");
    const [mantissa, exponent] = step.toExponential().split("e");
    const digits = mantissa!.replace(".", "");
    const stepPower = Number(exponent) - (digits.length - 1);

    // The generated module may declare both BigInt and globalThis as schema names.
    return `superRefine(((integer) => {
        const divisor = integer.parse("${digits}");
        return (value: number, ctx: z.RefinementCtx) => {
            if (value === 0) return;
            const [mantissa = "", exponent] = value.toExponential().split("e");
            if (exponent !== undefined) {
                const [whole = "", fraction = ""] = mantissa.split(".");
                const padding = +exponent - fraction.length - (${stepPower});
                if (padding >= 0 && !(integer.parse(whole + fraction + "0".repeat(padding)) % divisor)) return;
            }
            ctx.addIssue({ code: "not_multiple_of", multipleOf: ${step} });
        };
    })(z.coerce.bigint()))`;
}

const getZodChainableNumberValidations = (schema: SchemaObject) => {
    const validations: string[] = [];

    if (schema.type === "integer" || schema.multipleOf === 1) {
        validations.push("int()");
    }

    for (const [method, limit] of numberBounds(schema)) validations.push(`${method}(${limit})`);

    if (schema.multipleOf !== undefined && schema.multipleOf !== 1) {
        validations.push(multipleOfValidation(schema.multipleOf));
    }

    return validations.join(".");
};

const getZodChainableArrayValidations = (schema: SchemaObject) => {
    const validations: string[] = [];

    if (schema.minItems) {
        validations.push(`min(${schema.minItems})`);
    }

    if (schema.maxItems !== undefined) {
        validations.push(`max(${schema.maxItems})`);
    }

    return validations.join(".");
};
