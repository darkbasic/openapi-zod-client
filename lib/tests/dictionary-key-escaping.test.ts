import type { SchemaObject } from "openapi3-ts";
import { transpileModule } from "typescript";
import { expect, test } from "vitest";
import { z } from "zod";
import { generateZodClientFromOpenAPI } from "../src/generateZodClientFromOpenAPI";
import { getZodClientTemplateContext } from "../src/template-context";
import { typeErrors } from "./typeErrors";

test("fixed keys in mixed dictionaries keep their JSON spelling in validators and declarations", async () => {
    const keys = ['device"serial', "two\nlines", "a\\b"];
    const properties: Record<string, SchemaObject> = Object.fromEntries(
        keys.map((key) => [key, { type: "integer", description: 'Use "fast" mode.\nThen `read` the value.' }])
    );
    const openApiDoc = {
        openapi: "3.1.0",
        info: { title: "Keys", version: "1" },
        paths: {},
        components: {
            schemas: {
                Row: {
                    type: "object" as const,
                    properties,
                    required: keys,
                    additionalProperties: { type: "string" as const },
                },
            },
        },
    };
    const options = { withDescription: true, shouldExportAllTypes: true, shouldExportAllSchemas: true };
    const output = await generateZodClientFromOpenAPI({ openApiDoc, disableWriteToFile: true, options });
    const row = Object.fromEntries(keys.map((key) => [key, 42]));
    expect(
        typeErrors(
            `${output}\nconst row: z.output<typeof Row> = ${JSON.stringify(row)};\n` +
                keys.map((key, index) => `const n${index}: number = row[${JSON.stringify(key)}];`).join("\n")
        )
    ).toEqual([]);
    const { schemas } = getZodClientTemplateContext(openApiDoc, options);
    const source = transpileModule(`const row = ${schemas.Row};`, {}).outputText;
    const validator: z.ZodTypeAny = new Function("z", source + "\nreturn row")(z);
    expect(validator.parse({ ...row, extra: "value" })).toEqual({ ...row, extra: "value" });
    for (const key of keys) expect(validator.safeParse({ ...row, [key]: "wrong" }).success).toBe(false);
});
