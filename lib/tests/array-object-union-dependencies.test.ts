import type { OpenAPIObject, SchemaObject } from "openapi3-ts";
import { expect, test } from "vitest";
import { z } from "zod";
import { getZodClientTemplateContext } from "../src/template-context";

test.each([
    { objectBranch: "properties", withItems: true },
    { objectBranch: "properties", withItems: false },
    { objectBranch: "additionalProperties", withItems: true },
    { objectBranch: "additionalProperties", withItems: false },
])("recursive array/object union initializes ($objectBranch, items: $withItems)", ({ objectBranch, withItems }) => {
    const objectSchema: SchemaObject =
        objectBranch === "properties"
            ? { properties: { child: { $ref: "#/components/schemas/Child" } }, required: ["child"] }
            : { additionalProperties: { $ref: "#/components/schemas/Child" } };
    const document: OpenAPIObject = {
        openapi: "3.1.0",
        info: { title: "Recursive array/object union", version: "1" },
        paths: {},
        components: {
            schemas: {
                Union: {
                    type: ["array", "object"],
                    ...(withItems ? { items: { $ref: "#/components/schemas/Item" } } : {}),
                    ...objectSchema,
                },
                Child: {
                    type: "object",
                    properties: { parent: { $ref: "#/components/schemas/Union" } },
                    required: ["parent"],
                },
                Item: {
                    type: "object",
                    properties: { value: { type: "string" } },
                    required: ["value"],
                },
            },
        },
    };
    const context = getZodClientTemplateContext(document, { shouldExportAllSchemas: true });
    const declarations = Object.entries(context.schemas)
        .map(([name, expression]) => `const ${name} = ${expression};`)
        .join("\n");
    const schema: z.ZodTypeAny = new Function("z", `${declarations}\nreturn Union;`)(z);

    expect(schema.safeParse([]).success).toBe(true);
    expect(schema.safeParse([{ value: "ready" }]).success).toBe(true);
    expect(schema.safeParse({ child: { parent: [] } }).success).toBe(true);
    expect(schema.safeParse({ child: { parent: { child: { parent: [] } } } }).success).toBe(true);
    expect(schema.safeParse({ child: { parent: 42 } }).success).toBe(false);
    expect(schema.safeParse({ child: {} }).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
    expect(schema.safeParse(42).success).toBe(false);
    expect(schema.safeParse([{ value: 42 }]).success).toBe(!withItems);
});
