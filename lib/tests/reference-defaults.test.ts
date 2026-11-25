import type { OpenAPIObject, SchemaObject } from "openapi3-ts";
import { transpileModule } from "typescript";
import { expect, test } from "vitest";
import { z } from "zod";
import { generateZodClientFromOpenAPI } from "../src/generateZodClientFromOpenAPI";
import { getZodClientTemplateContext } from "../src/template-context";
import { typeErrors } from "./typeErrors";

const currency = { $ref: "#/components/schemas/Currency" };
const european = { ...currency, enum: ["EUR", "GBP"] };
const eur = { ...european, default: "EUR" };

function document(version = "3.1.0"): OpenAPIObject {
    const json = (schema: SchemaObject) => ({ "application/json": { schema } });
    return {
        openapi: version,
        info: { title: "Quotes", version: "1" },
        paths: {
            "/quotes": {
                post: {
                    parameters: [
                        {
                            name: "currency",
                            in: "query",
                            description: "Parameter description",
                            schema: { ...currency, default: "GBP" },
                        },
                    ],
                    requestBody: { required: true, content: json(eur) },
                    responses: {
                        200: { description: "ok", content: json(eur) },
                        default: { description: "error", content: json(eur) },
                    },
                },
            },
        },
        components: {
            schemas: {
                Currency: { type: "string", default: "USD", description: "Component description" },
                Fixed: { type: "string", enum: ["A", "B"] },
                RegionalCurrency: eur,
                Quote: {
                    type: "object",
                    required: ["id", "regional"],
                    properties: {
                        id: { type: "integer" },
                        next: { $ref: "#/components/schemas/Quote" },
                        currency: eur,
                        regional: { $ref: "#/components/schemas/RegionalCurrency" },
                        untouched: currency,
                        noDefault: european,
                        excludedLocal: { $ref: "#/components/schemas/Fixed", default: "C" },
                        excludeNumber: { ...currency, default: 12 },
                        rates: { type: "object", additionalProperties: eur },
                        values: { type: "array", items: eur },
                    },
                },
                AllOptional: { type: "object", properties: { currency: eur } },
            },
        },
    };
}

test.each(["3.1.0", "3.0.3"])(
    "resolves reference defaults for properties, items, entries and endpoints in %s",
    async (version) => {
        const doc = document(version);
        const options = {
            defaultStatusBehavior: "auto-correct" as const,
            shouldExportAllSchemas: true,
            shouldExportAllTypes: true,
        };
        const { schemas, endpoints } = getZodClientTemplateContext(doc, options);
        const declarations = Object.entries(schemas)
            .map(([name, expression]) => `const ${name} = ${expression};`)
            .join("\n");
        const evaluate = (expression: string): z.ZodTypeAny =>
            new Function(
                "z",
                transpileModule(declarations + `\nconst parser = ${expression};`, {}).outputText + "\nreturn parser;"
            )(z);
        const is31 = version === "3.1.0";
        const quote = evaluate("Quote");
        const required = is31 ? {} : { regional: "USD" };
        const result = quote.parse({ id: 1, ...required });
        expect(result).toEqual(
            is31
                ? { id: 1, regional: "EUR", currency: "EUR", untouched: "USD" }
                : { id: 1, regional: "USD", currency: "USD", noDefault: "USD", excludeNumber: "USD", untouched: "USD" }
        );
        expect(quote.safeParse({ id: 1, regional: "USD" }).success).toBe(!is31);
        expect(evaluate("AllOptional").parse({})).toEqual({});
        expect(quote.parse({ id: 1, ...required, rates: { one: undefined } }).rates.one).toBe(is31 ? "EUR" : "USD");
        const items = quote.safeParse({ id: 1, ...required, values: [undefined] });
        expect(items.success).toBe(is31);
        if (items.success) expect(items.data.values).toEqual(["EUR"]);
        const endpoint = endpoints[0]!;
        for (const parser of [
            endpoint.parameters.find((p) => p.type === "Body")!.schema,
            endpoint.response,
            endpoint.errors[0]!.schema,
        ]) {
            expect(evaluate(parser).parse(undefined)).toBe(is31 ? "EUR" : "USD");
        }
        expect(evaluate(endpoint.parameters.find((p) => p.name === "currency")!.schema).parse(undefined)).toBe(
            is31 ? "GBP" : "USD"
        );
        const generated = await generateZodClientFromOpenAPI({ openApiDoc: doc, disableWriteToFile: true, options });
        expect(
            typeErrors(`${generated}
const input: z.input<typeof Quote> = { id: 1, ${is31 ? "" : 'regional: "USD",'} next: { id: 2, ${
                is31 ? "" : 'regional: "USD"'
            } } };
const regional: ${is31 ? '"EUR" | "GBP"' : "string"} = Quote.parse(input).regional;
`)
        ).toEqual([]);
    }
);

test("disabling defaults affects the request body, query parameter, success and error response", async () => {
    const options = {
        defaultStatusBehavior: "auto-correct" as const,
        shouldExportAllSchemas: true,
        shouldExportAllTypes: true,
        withDefaultValues: false,
    };
    const output = await generateZodClientFromOpenAPI({ openApiDoc: document(), disableWriteToFile: true, options });
    expect(output).not.toContain(".default(");
    expect(
        typeErrors(`${output}
// @ts-expect-error required fields stay required
const input: z.input<typeof Quote> = { id: 1 };
`)
    ).toEqual([]);
});

test.each([undefined, -1])(
    "keeps a valid query parameter expression at complexity threshold %s",
    async (complexityThreshold) => {
        const base = document("3.1.0");
        const options = {
            withDescription: true,
            shouldExportAllSchemas: true,
            ...(complexityThreshold === undefined ? {} : { complexityThreshold }),
        };
        const { endpoints } = getZodClientTemplateContext(base, options);
        const param = endpoints[0]!.parameters.find((p) => p.name === "currency")!.schema;
        expect(param).toContain("Parameter description");
        expect(param).not.toContain("Component description");
        const client = await generateZodClientFromOpenAPI({ openApiDoc: base, disableWriteToFile: true, options });
        expect(typeErrors(client)).toEqual([]);
    }
);

test("uses the same parser for inherited default candidates and supplied values", async () => {
    const narrow = { ...currency, pattern: "^E" };
    const doc: OpenAPIObject = {
        ...document(),
        paths: {},
        components: {
            schemas: {
                Currency: { type: "string", default: "USD" },
                Quote: {
                    type: "object",
                    required: ["id", "required"],
                    properties: {
                        id: { type: "integer" },
                        required: narrow,
                        optional: narrow,
                        valid: { ...currency, pattern: "^U" },
                        excluded: { type: "object", additionalProperties: european },
                        finite: { type: "object", required: ["currency"], properties: { currency: european } },
                    },
                },
            },
        },
    };
    const options = { shouldExportAllSchemas: true, shouldExportAllTypes: true };
    const { schemas } = getZodClientTemplateContext(doc, options);
    const code = Object.entries(schemas)
        .map(([name, expr]) => `const ${name} = ${expr};`)
        .join("\n");
    const quote: z.ZodTypeAny = new Function("z", transpileModule(code, {}).outputText + "\nreturn Quote;")(z);
    expect(quote.safeParse({ id: 1 }).success).toBe(false);
    expect(quote.parse({ id: 1, required: "EUR" })).toEqual({ id: 1, required: "EUR", valid: "USD" });
    for (const invalid of [null, "USD", 1])
        expect(quote.safeParse({ id: 1, required: "EUR", optional: invalid }).success).toBe(false);
    expect(quote.safeParse({ id: 1, required: "EUR", excluded: { a: undefined } }).success).toBe(false);
    const output = await generateZodClientFromOpenAPI({ openApiDoc: doc, disableWriteToFile: true, options });
    expect(
        typeErrors(`${output}
const valid: z.input<typeof Quote> = { id: 1, required: "EUR", finite: { currency: "GBP" } };
// @ts-expect-error a default excluded by the enum cannot fill the required nested key
const absent: z.input<typeof Quote> = { id: 1, required: "EUR", finite: {} };
// @ts-expect-error an entry default excluded by its enum cannot consume undefined
const excluded: z.input<typeof Quote> = { id: 1, required: "EUR", excluded: { a: undefined } };
`)
    ).toEqual([]);
});

test("a recursive optional property does not inherit a default through its component alias", () => {
    const doc: OpenAPIObject = {
        ...document(),
        paths: {},
        components: {
            schemas: {
                Node: {
                    type: "object",
                    required: ["name"],
                    properties: {
                        name: { type: "string" },
                        next: { $ref: "#/components/schemas/NodeAlias" },
                    },
                    default: { name: "leaf" },
                },
                NodeAlias: { $ref: "#/components/schemas/Node" },
            },
        },
    };
    const { schemas } = getZodClientTemplateContext(doc, { shouldExportAllSchemas: true });
    const code = Object.entries(schemas)
        .map(([name, expr]) => `const ${name} = ${expr};`)
        .join("\n");
    const node: z.ZodTypeAny = new Function("z", transpileModule(code, {}).outputText + "\nreturn Node;")(z);
    expect(node.parse({ name: "only" })).toEqual({ name: "only" });
});

test("a compatible default keeps the inferred parsed property required", async () => {
    const doc: OpenAPIObject = {
        ...document(),
        paths: {},
        components: {
            schemas: {
                Currency: { type: "string", default: "USD" },
                Nullable: { type: "string", nullable: true, default: null },
                Quote: {
                    type: "object",
                    required: ["id"],
                    properties: {
                        id: { type: "integer" },
                        currency: { ...currency, enum: ["USD", "EUR"] },
                        nullable: { $ref: "#/components/schemas/Nullable", enum: ["EUR", null] },
                    },
                },
            },
        },
    };
    const output = await generateZodClientFromOpenAPI({
        openApiDoc: doc,
        disableWriteToFile: true,
        options: { shouldExportAllSchemas: true },
    });
    expect(
        typeErrors(`${output}
const input: z.input<typeof Quote> = { id: 1 };
const parsed: { currency: "USD" | "EUR"; nullable: "EUR" | null } = Quote.parse(input);
`)
    ).toEqual([]);
});

test.each([false, true])(
    "ends self-expanding defaults without disturbing supplied children (required: %s)",
    async (required) => {
        const doc: OpenAPIObject = {
            ...document(),
            paths: {},
            components: {
                schemas: {
                    Node: {
                        type: "object",
                        required: required ? ["name", "next"] : ["name"],
                        properties: {
                            name: { type: "string" },
                            next: { $ref: "#/components/schemas/Partner", default: { name: "partner" } },
                        },
                    },
                    Partner: {
                        type: "object",
                        required: required ? ["name", "next"] : ["name"],
                        properties: {
                            name: { type: "string" },
                            next: { $ref: "#/components/schemas/Node", default: { name: "node" } },
                        },
                    },
                },
            },
        };
        const { schemas } = getZodClientTemplateContext(doc, { shouldExportAllSchemas: true });
        const code = Object.entries(schemas)
            .map(([name, expr]) => `const ${name} = ${expr};`)
            .join("\n");
        const node: z.ZodTypeAny = new Function("z", transpileModule(code, {}).outputText + "\nreturn Node;")(z);
        const output = await generateZodClientFromOpenAPI({
            openApiDoc: doc,
            disableWriteToFile: true,
            options: { shouldExportAllSchemas: true },
        });
        expect(typeErrors(output)).toEqual([]);
        if (required) {
            expect(node.safeParse({ name: "root" }).success).toBe(false);
        } else {
            expect(node.parse({ name: "root" })).toEqual({
                name: "root",
                next: { name: "partner", next: { name: "node" } },
            });
            const result = node.parse({
                name: "explicit",
                next: { name: "supplied", next: { name: "also supplied" } },
            });
            expect(result.next.next).toEqual({
                name: "also supplied",
                next: { name: "partner", next: { name: "node" } },
            });
            expect(node.parse({ name: "again" }).next.name).toBe("partner");
        }
    }
);

test("uses a format guard when a parameter default refers to a wrapped string alias", async () => {
    const doc: OpenAPIObject = {
        ...document(),
        paths: {
            "/quote": {
                get: {
                    parameters: [
                        {
                            name: "email",
                            in: "query",
                            schema: { $ref: "#/components/schemas/Email", default: "me@example.com" },
                        },
                    ],
                    responses: { 200: { description: "ok" } },
                },
            },
        },
        components: {
            schemas: {
                Text: { type: "string" },
                Email: { $ref: "#/components/schemas/Text", type: "string", format: "email" },
            },
        },
    };
    const options = { shouldExportAllSchemas: true };
    const { schemas, endpoints } = getZodClientTemplateContext(doc, options);
    const declarations = Object.entries(schemas)
        .map(([name, expr]) => `const ${name} = ${expr};`)
        .join("\n");
    const code = declarations + `\nconst param = ${endpoints[0]!.parameters[0]!.schema};`;
    const email: z.ZodTypeAny = new Function("z", transpileModule(code, {}).outputText + "\nreturn param;")(z);
    expect(email.parse(undefined)).toBe("me@example.com");
    expect(email.safeParse("invalid").success).toBe(false);
    const output = await generateZodClientFromOpenAPI({ openApiDoc: doc, disableWriteToFile: true, options });
    expect(typeErrors(output)).toEqual([]);
});

test("proves scalar defaults with the same patterns, Unicode lengths and numeric bounds as the generated parser", async () => {
    const amount = { $ref: "#/components/schemas/Amount" };
    const doc: OpenAPIObject = {
        ...document(),
        paths: {},
        components: {
            schemas: {
                Currency: { type: "string", default: "USD" },
                Glyph: { type: "string", default: "🎉" },
                Amount: { type: "number", default: 5 },
                Quote: {
                    type: "object",
                    required: ["id"],
                    properties: {
                        id: { type: "integer" },
                        code: { ...currency, pattern: "/^[A-Z]+$/", minLength: 3, maxLength: 3 },
                        glyph: { $ref: "#/components/schemas/Glyph", maxLength: 1 },
                        tooShort: { $ref: "#/components/schemas/Glyph", minLength: 2 },
                        bounded: { ...amount, exclusiveMinimum: 4, maximum: 5 },
                        tooLarge: { ...amount, exclusiveMaximum: 5 },
                        required: {
                            type: "object",
                            required: ["code", "amount"],
                            properties: {
                                code: { ...currency, pattern: "^EUR$" },
                                amount: { ...amount, minimum: 6 },
                            },
                        },
                    },
                },
            },
        },
    };
    const options = { shouldExportAllSchemas: true };
    const { schemas } = getZodClientTemplateContext(doc, options);
    const declarations = Object.entries(schemas)
        .map(([k, v]) => `const ${k} = ${v};`)
        .join("\n");
    const quote: z.ZodTypeAny = new Function("z", transpileModule(declarations, {}).outputText + "\nreturn Quote;")(z);
    expect(quote.parse({ id: 1 })).toEqual({ id: 1, code: "USD", glyph: "🎉", bounded: 5 });
    expect(quote.safeParse({ id: 1, required: {} }).success).toBe(false);
    expect(quote.safeParse({ id: 1, code: "usd" }).success).toBe(false);
    expect(quote.safeParse({ id: 1, required: { code: "EUR", amount: 6 } }).success).toBe(true);
    const output = await generateZodClientFromOpenAPI({ openApiDoc: doc, disableWriteToFile: true, options });
    expect(
        typeErrors(`${output}
const requiredParsed: {code:string; glyph:string; bounded:number} = Quote.parse({id:1});
// @ts-expect-error an excluded default cannot fill these required inputs
const missing: z.input<typeof Quote> = {id:1, required:{}};
`)
    ).toEqual([]);
});

test("an application schema refiner can replace the assertion on a defaulted property", () => {
    const doc: OpenAPIObject = {
        ...document(),
        paths: {},
        components: {
            schemas: {
                Currency: { type: "string", default: "USD" },
                Quote: {
                    type: "object",
                    required: ["id"],
                    properties: {
                        id: { type: "integer" },
                        currency: { ...currency, pattern: "^EUR$" },
                    },
                },
            },
        },
    };
    const { schemas } = getZodClientTemplateContext(doc, {
        shouldExportAllSchemas: true,
        schemaRefiner(schema) {
            if ("pattern" in schema && schema.pattern === "^EUR$") {
                const { pattern, ...rest } = schema;
                return rest;
            }
            return schema;
        },
    });
    const declarations = Object.entries(schemas)
        .map(([k, v]) => `const ${k} = ${v};`)
        .join("\n");
    const quote: z.ZodTypeAny = new Function("z", transpileModule(declarations, {}).outputText + "\nreturn Quote;")(z);
    expect(quote.parse({ id: 1 })).toEqual({ id: 1, currency: "USD" });
});

test("delegates bounds to the emitted parser when a referenced format changes their meaning", () => {
    const doc: OpenAPIObject = {
        ...document(),
        paths: {},
        components: {
            schemas: {
                Base: { type: "string" },
                Alias: { $ref: "#/components/schemas/Base", format: "binary" },
                Quote: {
                    type: "object",
                    required: ["id"],
                    properties: {
                        id: { type: "integer" },
                        value: { $ref: "#/components/schemas/Alias", pattern: "^A", default: "no" },
                    },
                },
            },
        },
    };
    const { schemas } = getZodClientTemplateContext(doc, { shouldExportAllSchemas: true });
    const declarations = Object.entries(schemas)
        .map(([k, v]) => `const ${k} = ${v};`)
        .join("\n");
    const quote: z.ZodTypeAny = new Function("z", transpileModule(declarations, {}).outputText + "\nreturn Quote;")(z);
    expect(quote.parse({ id: 1 })).toEqual({ id: 1, value: "no" });
    expect(quote.parse({ id: 1, value: "no" })).toEqual({ id: 1, value: "no" });
});
