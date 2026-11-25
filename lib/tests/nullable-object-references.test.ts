import { createRequire } from "node:module";
import type { OpenAPIObject, SchemaObject } from "openapi3-ts";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, test } from "vitest";
import type { z } from "zod";
import { generateZodClientFromOpenAPI } from "../src/generateZodClientFromOpenAPI";
import { getZodSchema } from "../src/openApiToZod";
import { typeErrors } from "./typeErrors";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (schema: SchemaObject) => ({
    get: { responses: { "200": { description: "OK", content: { "application/json": { schema } } } } },
});

function loadSchemas(source: string): {
    schemas: Record<string, z.ZodTypeAny>;
    endpoints: { path: string; response: z.ZodTypeAny }[];
} {
    const { outputText } = transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
    });
    return new Function("require", "exports", outputText + "\nreturn { schemas: exports.schemas, endpoints };")(
        createRequire(import.meta.url),
        {}
    );
}

test.each([
    { complexityThreshold: 0, allReadonly: false },
    { complexityThreshold: -1, allReadonly: true },
])("preserves nullable recursive object references in public validators and responses (%j)", async (options) => {
    const children: SchemaObject = { type: "array", items: ref("Node") };
    const inline: SchemaObject = {
        type: "object",
        properties: { children, lookup: { type: "object", additionalProperties: ref("Alias") } },
    };
    const document: OpenAPIObject = {
        openapi: "3.0.3",
        info: { title: "Nullable tree", version: "1" },
        paths: { "/tree": response(ref("Node")), "/inline": response(inline) },
        components: {
            schemas: {
                Node: {
                    type: "object",
                    nullable: true,
                    properties: { children, parent: ref("Node") },
                },
                Alias: ref("Node"),
                RequiredChildren: { allOf: [ref("Node"), { required: ["children"] }] },
                Wrapped: { type: "object", nullable: true, allOf: [ref("RequiredChildren")] },
                ByName: { type: "object", nullable: true, additionalProperties: ref("Node") },
                Closed: { type: "object", nullable: true, required: ["missing"], additionalProperties: false },
                EnumWithoutNull: { type: "object", nullable: true, enum: [{ id: "a" }] },
                EnumWithNull: { type: "object", nullable: true, enum: [{ id: "a" }, null] },
                Defaulted: {
                    type: "object",
                    nullable: true,
                    required: ["name"],
                    properties: { name: { type: "string", default: "leaf" }, child: ref("Defaulted") },
                },
            },
        },
    };
    const source = await generateZodClientFromOpenAPI({
        openApiDoc: document,
        disableWriteToFile: true,
        options: { ...options, shouldExportAllSchemas: true, shouldExportAllTypes: true },
    });
    const { schemas, endpoints } = loadSchemas(source);
    const byPath = Object.fromEntries(endpoints.map(({ path, response }) => [path, response]));
    for (const node of [schemas.Node!, schemas.Alias!, byPath["/tree"]!]) {
        for (const value of [null, {}, { parent: null, children: [null, { children: [null] }] }]) {
            expect(node.parse(value)).toEqual(value);
        }
        for (const value of [false, undefined, { children: [{}, 0] }, { parent: [] }]) {
            expect(node.safeParse(value).success).toBe(false);
        }
    }
    expect(byPath["/inline"]!.parse({ children: [null], lookup: { a: null } })).toEqual({
        children: [null],
        lookup: { a: null },
    });
    expect(byPath["/inline"]!.safeParse({ lookup: { a: false } }).success).toBe(false);
    expect(schemas.ByName!.parse(null)).toBe(null);
    expect(schemas.ByName!.parse({ a: null })).toEqual({ a: null });
    expect(schemas.Closed!.parse(null)).toBe(null);
    expect(schemas.EnumWithoutNull!.safeParse(null).success).toBe(false);
    expect(schemas.EnumWithNull!.parse(null)).toBe(null);
    expect(schemas.Closed!.safeParse({ missing: 1 }).success).toBe(false);
    expect(schemas.RequiredChildren!.parse({ children: [null] })).toEqual({ children: [null] });
    expect(schemas.RequiredChildren!.parse(null)).toBe(null);
    expect(schemas.Wrapped!.parse(null)).toBe(null);
    expect(schemas.Wrapped!.safeParse({}).success).toBe(false);
    expect(schemas.Defaulted!.parse({ child: null })).toEqual({ name: "leaf", child: null });
    expect(schemas.Defaulted!.parse(null)).toBe(null);
    expect(
        typeErrors(`${source}
const tree: z.input<typeof Node> = { children: [null, { parent: null }] };
const alias: z.output<typeof Alias> = null;
const input: z.input<typeof Defaulted> = { child: {} };
const output: Defaulted = { name: "leaf", child: null };
const required: RequiredChildren = { children: [null] };
const nullTree: RequiredChildren = null;
// @ts-expect-error object instances must contain children
const absent: RequiredChildren = {};
// @ts-expect-error defaults are populated on output
const incomplete: Defaulted = { child: null };
// @ts-expect-error nullable objects reject other primitives
const badChild: Node = { children: [false] };`)
    ).toEqual([]);
});

test.each([
    { openapi: "3.0.3", allReadonly: false },
    { openapi: "3.0.3", allReadonly: true },
    { openapi: "3.1.0", allReadonly: false },
    { openapi: "3.1.0", allReadonly: true },
])("handles nullable tagged options before validating object tags (%j)", async ({ openapi, allReadonly }) => {
    const nullable: SchemaObject =
        openapi === "3.1.0" ? { type: ["object", "null"] } : { type: "object", nullable: true };
    const branch: SchemaObject = {
        ...nullable,
        required: ["tag"],
        properties: { tag: { type: "string", enum: ["branch"], default: "branch" } },
    };
    const leaf: SchemaObject = {
        type: "object",
        required: ["tag"],
        properties: { tag: { type: "string", enum: ["leaf"] } },
    };
    const tagged = (option: SchemaObject, other = leaf): SchemaObject => ({
        oneOf: [option, other],
        discriminator: { propertyName: "tag" },
    });
    const source = await generateZodClientFromOpenAPI({
        openApiDoc: {
            openapi,
            info: { title: "Nullable options", version: "1" },
            paths: {},
            components: {
                schemas: {
                    Branch: branch,
                    Alias: { anyOf: [ref("Branch")] },
                    Inline: tagged(branch),
                    Named: tagged(ref("Alias")),
                    Both: tagged(ref("Alias"), { ...leaf, ...nullable }),
                    Exclusive: { oneOf: [ref("Alias"), { ...leaf, ...nullable }] },
                    Inclusive: { anyOf: [ref("Alias"), { ...leaf, ...nullable }] },
                    ...(openapi === "3.1.0" && { ExplicitNull: { oneOf: [ref("Alias"), { type: "null" }] } }),
                },
            },
        },
        disableWriteToFile: true,
        options: { shouldExportAllSchemas: true, allReadonly },
    });
    const { schemas } = loadSchemas(source);
    for (const option of [schemas.Inline!, schemas.Named!]) {
        for (const value of [null, { tag: "branch" }, { tag: "leaf" }]) expect(option.parse(value)).toEqual(value);
        for (const value of [false, undefined, {}, { tag: "invalid" }])
            expect(option.safeParse(value).success).toBe(false);
    }
    for (const option of [schemas.Both!, schemas.Exclusive!]) {
        expect(option.safeParse(null).success).toBe(false);
        expect(option.parse({ tag: "branch" })).toEqual({ tag: "branch" });
    }
    if (schemas.ExplicitNull) expect(schemas.ExplicitNull.safeParse(null).success).toBe(false);
    expect(schemas.Inclusive!.parse(null)).toBe(null);
    expect(typeErrors(source)).toEqual([]);
});

test.each([false, true])(
    "a nullable object composition still requires its branches to match (defaults: %s)",
    async (withDefaultValues) => {
        const base: SchemaObject = { type: "object", required: ["id"], properties: { id: { type: "string" } } };
        const wrapped: SchemaObject = { type: "object", nullable: true, allOf: [ref("Base")] };
        const holder: SchemaObject = {
            type: "object",
            required: ["child", "label"],
            properties: {
                child: ref("Wrapped"),
                optional: wrapped,
                rows: { type: "array", items: wrapped },
                lookup: { type: "object", additionalProperties: ref("Alias") },
                label: { type: "string", default: "root" },
            },
        };
        const source = await generateZodClientFromOpenAPI({
            openApiDoc: {
                openapi: "3.0.3",
                info: { title: "Composed objects", version: "1" },
                paths: {
                    "/wrapped": response(ref("Wrapped")),
                    "/inline": response(wrapped),
                    "/holder": response(ref("Holder")),
                },
                components: {
                    schemas: {
                        Base: base,
                        Wrapped: wrapped,
                        Alias: ref("Wrapped"),
                        Holder: holder,
                        Rows: { type: "array", items: ref("Wrapped") },
                        Nullable: { ...base, nullable: true },
                        Both: { type: "object", nullable: true, allOf: [ref("Nullable"), ref("Base")] },
                        Either: { type: "object", nullable: true, anyOf: [ref("Nullable"), ref("Base")] },
                        Choice: { type: "object", nullable: true, oneOf: [ref("Wrapped"), ref("Nullable")] },
                        Nonnullable: { type: "object", allOf: [ref("Nullable")] },
                        Scalar: { type: "string", nullable: true },
                        Mixed: { oneOf: [ref("Nullable"), ref("Scalar")] },
                        MixedArray: {
                            oneOf: [
                                { ...base, nullable: true },
                                { type: "array", nullable: true, items: { type: "string" } },
                            ],
                        },
                        Plain: { oneOf: [{ type: "string" }, { type: "integer" }] },
                        Disjoint: { oneOf: [ref("Nullable"), ref("Plain")] },
                    },
                },
            },
            disableWriteToFile: true,
            options: { shouldExportAllSchemas: true, shouldExportAllTypes: true, withDefaultValues },
        });
        const { schemas, endpoints } = loadSchemas(source);
        const byPath = Object.fromEntries(endpoints.map(({ path, response }) => [path, response]));
        const item = { id: "a" };
        for (const schema of [
            schemas.Wrapped!,
            schemas.Alias!,
            schemas.Both!,
            byPath["/wrapped"]!,
            byPath["/inline"]!,
        ]) {
            expect(schema.parse(item)).toEqual(item);
            expect(schema.safeParse(null).success).toBe(false);
        }
        expect(schemas.Rows!.safeParse([null]).success).toBe(false);
        for (const schema of [schemas.Holder!, byPath["/holder"]!]) {
            const valid = { child: item, label: "root" };
            expect(schema.parse(valid)).toEqual(valid);
            for (const field of [{ child: null }, { optional: null }, { rows: [null] }, { lookup: { a: null } }]) {
                expect(schema.safeParse({ ...valid, ...field }).success).toBe(false);
            }
        }
        expect(schemas.Either!.parse(null)).toBe(null);
        expect(schemas.Choice!.parse(null)).toBe(null);
        expect(schemas.Nonnullable!.parse(item)).toEqual(item);
        expect(schemas.Nonnullable!.safeParse(null).success).toBe(false);
        expect(schemas.Mixed!.safeParse(null).success).toBe(false);
        expect(schemas.Mixed!.parse("ok")).toBe("ok");
        expect(schemas.MixedArray!.safeParse(null).success).toBe(false);
        expect(schemas.MixedArray!.parse(["ok"])).toEqual(["ok"]);
        expect(schemas.Disjoint!._def.typeName).toBe("ZodUnion");
        expect(schemas.Disjoint!.parse(null)).toBe(null);
        expect(
            typeErrors(`${source}
const item: Wrapped = { id: "a" };
const either: Either = null;
const choice: Choice = null;
const mixed: Mixed = "ok";
const array: z.output<typeof MixedArray> = ["ok"];
// @ts-expect-error the outer object type excludes null
const nonnullable: Nonnullable = null;
// @ts-expect-error null matches both the object and string options
const ambiguousString: Mixed = null;
// @ts-expect-error null matches both the object and array options
const ambiguousArray: z.input<typeof MixedArray> = null;
// @ts-expect-error a nonnullable branch rejects null
const wrapper: Wrapped = null;
// @ts-expect-error every allOf branch must accept null
const both: Both = null;
// @ts-expect-error aliases keep the constraint inside an array
const rows: Rows = [null];
// @ts-expect-error required properties keep the branch input
const input: z.input<typeof Holder> = { child: null, label: "root" };
// @ts-expect-error optionality allows omission, not null
const optional: Holder = { child: item, label: "root", optional: null };
// @ts-expect-error dictionary values keep their branch contract
const lookup: z.input<typeof Holder> = { child: item, label: "root", lookup: { a: null } };
`)
        ).toEqual([]);
    }
);

test.each(["3.0.3", "3.1.0"])("combines type, null and the exact branch count (%s)", async (openapi) => {
    const nullable = (type: "object" | "string"): SchemaObject =>
        openapi === "3.0.3" ? { type, nullable: true } : { type: [type, "null"] };
    const plain: SchemaObject = {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
    };
    const oneOf = [plain, ref("Text")];
    const schemas: Record<string, SchemaObject> = {
        Text: nullable("string"),
        Maybe: { ...plain, ...nullable("object") },
        Choice: { ...nullable("object"), oneOf },
        Nested: { allOf: [ref("Choice"), { properties: { id: { type: "string" } } }] },
        Ambiguous: { ...nullable("object"), oneOf: [ref("Nested"), ref("Text")] },
        Both: { ...nullable("object"), allOf: [ref("Text"), plain] },
        Ordinary: { type: "object", oneOf },
        RefSibling: { ...ref("Maybe"), type: "object" },
        RefChoice: { oneOf: [ref("RefSibling"), ref("Maybe")] },
        ...(openapi === "3.1.0" && {
            NegatedRef: { ...ref("Maybe"), not: ref("Literal") },
            NegatedChoice: { oneOf: [ref("NegatedRef"), ref("Maybe")] },
            DoubleNegation: { not: { not: ref("Literal") } },
            StructuralConst: { const: { id: ["fixed", null] } },
            StructuralEnum: { type: "object", enum: [{ id: "fixed" }] },
            ConditionalChoice: { oneOf: [ref("Maybe"), { if: { type: "null" }, then: { type: "string" } }] },
            UnknownOverlap: { oneOf: [{}, ref("Maybe")] },
            Literal: { const: null },
            ConstSibling: { ...ref("Maybe"), const: null },
            EnumSibling: { ...ref("Maybe"), enum: [null] },
            NoMatch: { type: ["null", "object"], allOf: [plain] },
            Multi: { type: ["null", "object", "integer"], anyOf: [ref("Text"), { type: "integer" }, plain] },
            SiblingCompositions: { anyOf: [ref("Maybe")], oneOf: [ref("Literal"), ref("Maybe")] },
            EnumRejects: { type: ["null", "string"], enum: ["x"] },
            NestedChoice: { oneOf: [ref("EnumRejects"), ref("ConstSibling")] },
        }),
    };
    const source = await generateZodClientFromOpenAPI({
        openApiDoc: {
            openapi,
            info: { title: "Null composition", version: "1" },
            paths: {},
            components: { schemas },
        },
        disableWriteToFile: true,
        options: { shouldExportAllSchemas: true, shouldExportAllTypes: true },
    });
    const client = loadSchemas(source).schemas;
    const nullableNames = [
        "Choice",
        "Nested",
        ...(openapi === "3.1.0"
            ? [
                  "RefChoice",
                  "Literal",
                  "ConstSibling",
                  "EnumSibling",
                  "Multi",
                  "NestedChoice",
                  "NegatedChoice",
                  "DoubleNegation",
              ]
            : ["RefSibling"]),
    ];
    const nonnullableNames = [
        "Ambiguous",
        "Both",
        "Ordinary",
        ...(openapi === "3.1.0"
            ? [
                  "RefSibling",
                  "NoMatch",
                  "SiblingCompositions",
                  "EnumRejects",
                  "NegatedRef",
                  "StructuralConst",
                  "StructuralEnum",
                  "UnknownOverlap",
              ]
            : ["RefChoice"]),
    ];
    for (const name of nullableNames) expect(client[name]!.safeParse(null).success, name).toBe(true);
    for (const name of nonnullableNames) expect(client[name]!.safeParse(null).success, name).toBe(false);
    for (const name of ["Choice", "Nested", "Ordinary", "RefSibling", "RefChoice"]) {
        expect(client[name]!.parse({ id: "item" })).toEqual({ id: "item" });
        expect(client[name]!.safeParse("scalar").success, name).toBe(false);
        expect(client[name]!.safeParse({}).success, name).toBe(false);
    }
    if (client.Multi) {
        expect(client.ConditionalChoice!.safeParse(null).success).toBe(true);
        expect(client.NegatedRef!.parse({ id: "ok" })).toEqual({ id: "ok" });
        expect(client.DoubleNegation!.safeParse({}).success).toBe(false);
        expect(client.StructuralConst!.parse({ id: ["fixed", null] })).toEqual({ id: ["fixed", null] });
        expect(client.StructuralConst!.safeParse({ id: ["fixed", null], extra: true }).success).toBe(false);
        expect(client.StructuralEnum!.safeParse({ id: "invalid" }).success).toBe(false);
        expect(client.Multi.parse(2)).toBe(2);
        expect(client.Multi.safeParse("scalar").success).toBe(false);
        expect(client.ConstSibling!.safeParse({ id: "item" }).success).toBe(false);
    }
    expect(
        typeErrors(
            [
                source,
                ...nullableNames.map((name) => `const accepts${name}: z.input<typeof ${name}> = null;`),
                ...nonnullableNames.map(
                    (name) =>
                        `// @ts-expect-error null cannot satisfy this schema\nconst rejects${name}: z.output<typeof ${name}> = null;`
                ),
                '// @ts-expect-error the object type excludes the scalar branch\nconst text: Choice = "text";',
            ].join("\n")
        )
    ).toEqual([]);
});

test.each([false, true])(
    "registers the target of a reference with siblings before its use (export all: %s)",
    async (shouldExportAllSchemas) => {
        const source = await generateZodClientFromOpenAPI({
            openApiDoc: {
                openapi: "3.1.0",
                info: { title: "Reference operands", version: "1" },
                components: {
                    schemas: {
                        Rule: { type: "object", additionalProperties: { ...ref("Text"), maxLength: 1 } },
                        Text: { type: "string" },
                    },
                },
                paths: { "/rule": response(ref("Rule")) },
            },
            disableWriteToFile: true,
            options: { shouldExportAllSchemas },
        });
        const { endpoints } = loadSchemas(source);
        expect(endpoints[0]!.response.parse({ x: "a" })).toEqual({ x: "a" });
        expect(endpoints[0]!.response.safeParse({ x: "ab" }).success).toBe(false);
        expect(typeErrors(source)).toEqual([]);
    }
);

test("untyped object assertions in compositions apply only to object instances", async () => {
    const mixed: SchemaObject = { type: ["object", "array", "string", "number", "null"] };
    const properties: SchemaObject = { required: ["key"], properties: { key: { type: "string" } } };
    const source = await generateZodClientFromOpenAPI({
        openApiDoc: {
            openapi: "3.1.0",
            info: { title: "Applicable assertions", version: "1" },
            paths: {},
            components: {
                schemas: {
                    Mixed: mixed,
                    ByRef: { ...ref("Mixed"), ...properties },
                    Any: { anyOf: [ref("Mixed")], ...properties },
                    Extras: { anyOf: [ref("Mixed")], additionalProperties: { type: "number" } },
                    Required: { allOf: [ref("Mixed"), { required: ["key"] }] },
                    Rows: {
                        type: "array",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            required: ["id"],
                            properties: { id: { type: "integer" } },
                        },
                    },
                    CheckedRows: { ...ref("Rows"), ...properties },
                },
            },
        },
        disableWriteToFile: true,
        options: { shouldExportAllSchemas: true, shouldExportAllTypes: true },
    });
    const schemas = loadSchemas(source).schemas;
    for (const name of ["ByRef", "Any", "Extras", "Required"]) {
        for (const value of ["ok", 0, null, []]) expect(schemas[name]!.parse(value)).toEqual(value);
    }
    for (const name of ["ByRef", "Any"]) {
        expect(schemas[name]!.safeParse({ key: "ok" }).success).toBe(true);
        for (const value of [{}, { key: 2 }]) expect(schemas[name]!.safeParse(value).success).toBe(false);
    }
    expect(schemas.Required!.safeParse({}).success).toBe(false);
    expect(schemas.Extras!.safeParse({ key: "wrong" }).success).toBe(false);
    expect(schemas.CheckedRows!.parse([{ id: 1, raw: true }])).toEqual([{ id: 1 }]);
    expect(
        typeErrors(
            source +
                `
const types: ByRef[] = [0, "value", null, [], { key: "ok" }];
const required: Required[] = [0, [], { key: "yes" }];
// @ts-expect-error input must satisfy the sibling before the referenced validator produces its output
const absent: z.input<typeof ByRef> = {};
// @ts-expect-error key must be a string on objects
const wrong: z.input<typeof Any> = { key: 123 };
`
        )
    ).toEqual([]);
});

test.each([false, true])(
    "generates 3.1 boolean schemas and operands (explicit types: %s)",
    async (shouldExportAllTypes) => {
        const components = {
            Anything: true,
            Nothing: false,
            Reject: { type: "string", not: true },
            Allow: { type: "string", not: false },
            AnyItems: { type: "array", items: true },
            NoItems: { type: "array", items: false },
            ExceptObjects: { oneOf: [true, { type: "object" }] },
            Impossible: { oneOf: [true, true, { type: "number" }] },
            Text: { allOf: [true, { type: "string" }] },
            Open: { anyOf: [false, true] },
            Literal: { type: "boolean", const: false },
            Holder: {
                type: "object",
                properties: {
                    any: ref("Anything"),
                    none: ref("Nothing"),
                    reject: ref("Reject"),
                    allow: ref("Allow"),
                    anyItems: ref("AnyItems"),
                    noItems: ref("NoItems"),
                    except: ref("ExceptObjects"),
                    impossible: ref("Impossible"),
                    text: ref("Text"),
                    open: ref("Open"),
                    literal: ref("Literal"),
                    flag: { type: "boolean", default: false },
                    inline: false,
                },
            },
        };
        // The project's OpenAPI model predates 3.1's boolean schema syntax. Exercise the same JSON input as the CLI.
        const openApiDoc: OpenAPIObject = JSON.parse(
            JSON.stringify({
                openapi: "3.1.0",
                info: { title: "Boolean schemas", version: "1" },
                paths: {
                    "/no": {
                        post: {
                            requestBody: { content: { "application/json": { schema: false } } },
                            responses: {
                                "200": { description: "No value", content: { "application/json": { schema: false } } },
                            },
                        },
                    },
                    "/yes": {
                        get: {
                            responses: {
                                "200": { description: "Any value", content: { "application/json": { schema: true } } },
                            },
                        },
                    },
                },
                components: { schemas: components },
            })
        );
        const source = await generateZodClientFromOpenAPI({
            openApiDoc,
            disableWriteToFile: true,
            options: { shouldExportAllSchemas: true, shouldExportAllTypes, withDescription: true },
        });
        const { schemas, endpoints } = loadSchemas(source);
        for (const value of [null, false, 1, "x", {}, []]) {
            for (const name of ["Anything", "Open"]) expect(schemas[name]!.safeParse(value).success, name).toBe(true);
            for (const name of ["Nothing", "Reject", "Impossible"])
                expect(schemas[name]!.safeParse(value).success, name).toBe(false);
            expect(endpoints.find((e) => e.path === "/no")!.response.safeParse(value).success).toBe(false);
            expect(endpoints.find((e) => e.path === "/yes")!.response.safeParse(value).success).toBe(true);
        }
        expect(schemas.Allow!.parse("a")).toBe("a");
        expect(schemas.AnyItems!.parse([0, null])).toEqual([0, null]);
        expect(schemas.NoItems!.parse([])).toEqual([]);
        expect(schemas.NoItems!.safeParse([null]).success).toBe(false);
        expect(schemas.ExceptObjects!.safeParse({}).success).toBe(false);
        expect(schemas.ExceptObjects!.parse(null)).toBe(null);
        expect(schemas.Text!.safeParse(0).success).toBe(false);
        expect(schemas.Holder!.parse({ any: false, flag: false })).toEqual({ any: false, flag: false });
        expect(schemas.Holder!.safeParse({ none: 1 }).success).toBe(false);
        expect(schemas.Holder!.safeParse({ inline: null }).success).toBe(false);
        expect(schemas.Literal!.safeParse(true).success).toBe(false);
        expect(
            typeErrors(
                source +
                    `
const allowed: z.input<typeof Anything> = null;
const items: z.input<typeof NoItems> = [];
// @ts-expect-error false rejects every instance
const impossible: z.input<typeof Nothing> = 0;
// @ts-expect-error no array item may satisfy false
const rejectedItems: z.input<typeof NoItems> = [0];
// @ts-expect-error an object matches two oneOf alternatives
const both: z.input<typeof ExceptObjects> = {};
`
            )
        ).toEqual([]);
    }
);

test("converts boolean schemas supplied directly through the generator API", () => {
    expect(getZodSchema({ schema: false }).toString()).toBe("z.never()");
    expect(getZodSchema({ schema: true }).toString()).toBe("z.unknown()");
    expect(getZodSchema({ schema: { type: "array", items: false } }).toString()).toBe("z.array(z.never())");
});
