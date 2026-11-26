import { createRequire } from "node:module";
import type { SchemaObject } from "openapi3-ts";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, test } from "vitest";
import { z } from "zod";
import { generateZodClientFromOpenAPI } from "../src/generateZodClientFromOpenAPI";
import { typeErrors } from "./typeErrors";

function parsers(source: string): Record<string, z.ZodTypeAny> {
    const { outputText } = transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
    });
    return new Function("require", "exports", outputText + "\nreturn exports.schemas;")(
        createRequire(import.meta.url),
        {}
    );
}

test("merged rows preserve the mutability of each parsed subtree", async () => {
    const rows = (properties: Record<string, SchemaObject>, nullable = false): SchemaObject => ({
        type: "array",
        items: {
            type: nullable ? ["object", "null"] : "object",
            properties,
            required: Object.keys(properties),
        },
    });
    const tags = { const: ["A", "B"] };
    const first = rows({ tags, numbers: { type: "array", items: { type: "integer" } } });
    const second = rows({ count: { type: "integer" } });
    const conditional = rows({ count: { type: "integer" }, tags }, true);
    const details: SchemaObject = {
        allOf: [
            {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string", minLength: 2 } },
                additionalProperties: false,
            },
            {
                type: "object",
                required: ["nested"],
                properties: {
                    nested: { type: "object", required: ["tags"], properties: { tags } },
                },
                additionalProperties: false,
            },
        ],
    };
    const detailsRows: SchemaObject = { type: "array", items: details };
    const source = await generateZodClientFromOpenAPI({
        openApiDoc: {
            openapi: "3.1.0",
            info: { title: "Readonly intersections", version: "1" },
            paths: {},
            components: {
                schemas: {
                    Text: {
                        allOf: [
                            { type: "string", minLength: 2 },
                            { type: "string", maxLength: 6 },
                        ],
                    },
                    Static: { allOf: [first, second] },
                    Dynamic: { allOf: [first, conditional] },
                    Mixed: { allOf: [first, rows({ tags: { type: "array", items: { type: "string" } } })] },
                    Reversed: { allOf: [conditional, first] },
                    Details: details,
                    Choice: { anyOf: [{ $ref: "#/components/schemas/Details" }, { type: "number" }] },
                    DetailsRows: { allOf: [detailsRows, second] },
                    Nested: { allOf: [rows({ info: details }), conditional] },
                    globalThis: { type: "string" },
                },
            },
        },
        options: { shouldExportAllSchemas: true, allReadonly: true },
        disableWriteToFile: true,
    });
    const client = parsers(source);
    expect(client.Text?._def.typeName).toBe(z.ZodFirstPartyTypeKind.ZodIntersection);
    expect(client.Details?._def.typeName).toBe(z.ZodFirstPartyTypeKind.ZodReadonly);
    for (const name of ["Static", "Dynamic", "Mixed", "Reversed"]) {
        const raw = [{ tags: ["A", "B"], numbers: [1], count: 2, extra: { other: [] } }];
        const result = client[name]!.parse(raw);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result[0])).toBe(true);
        expect(Object.isFrozen(result[0].numbers)).toBe(true);
        expect(result[0].extra).toBe(raw[0]!.extra);
        expect(Object.isFrozen(raw[0]!.extra)).toBe(false);
        result[0].tags.push("A");
        expect(raw[0]!.tags).toEqual(["A", "B"]);
    }
    const info = { name: "item", nested: { tags: ["A", "B"] } };
    const [valid, invalid] = await Promise.all([
        client.Choice!.parseAsync(info),
        client.Choice!.safeParseAsync({ ...info, name: "x" }),
    ]);
    expect(Object.isFrozen(valid)).toBe(true);
    expect(invalid).toMatchObject({ success: false, error: { issues: [{ path: ["name"] }] } });
    const item = client.DetailsRows!.parse([{ ...info, count: 1 }])[0];
    const nested = client.Nested!.parse([{ info, count: 1, tags: ["A", "B"] }])[0].info;
    for (const parsed of [item, nested, client.Details!.parse(info)]) {
        expect(Object.isFrozen(parsed)).toBe(true);
        expect(Object.isFrozen(parsed.nested)).toBe(true);
        parsed.nested.tags.push("A");
    }
    expect(info.nested.tags).toEqual(["A", "B"]);
    expect(
        typeErrors(
            source +
                `
const details = Nested.parse([])[0]!.info;
// @ts-expect-error regular merged object fields stay readonly
details.name = "other";
details.nested.tags.push("A");
for (const parser of [Static, Dynamic, Mixed, Reversed] as const) {
    const row = parser.parse([])[0]!;
    row.tags.push("A");
    // @ts-expect-error typed number arrays remain readonly
    row.numbers.push(1);
}`
        )
    ).toEqual([]);
}, 30_000);

test("a schema refiner can introduce shared readonly children", async () => {
    const field = (key: string, value: SchemaObject): SchemaObject => ({
        type: "object",
        required: [key],
        properties: { [key]: value },
        additionalProperties: false,
    });
    const id: SchemaObject = { type: "number" };
    const source = await generateZodClientFromOpenAPI({
        openApiDoc: {
            openapi: "3.1.0",
            info: { title: "Refined operands", version: "1" },
            paths: {},
            components: {
                schemas: {
                    Row: {
                        allOf: [
                            { ...field("x", id), description: "first" },
                            { ...field("y", id), description: "second" },
                        ],
                    },
                },
            },
        },
        options: {
            shouldExportAllSchemas: true,
            allReadonly: true,
            schemaRefiner(schema) {
                if ("description" in schema && (schema.description === "first" || schema.description === "second"))
                    return field("nested", field(schema.description, id));
                return schema;
            },
        },
        disableWriteToFile: true,
    });
    const parsed = parsers(source).Row!.parse({ nested: { first: 1, second: 2 } });
    expect(Object.isFrozen(parsed.nested)).toBe(true);
});
