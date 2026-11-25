import type { OpenAPIObject, SchemaObject } from "openapi3-ts";
import { expect, test } from "vitest";
import { generateZodClientFromOpenAPI } from "../src/generateZodClientFromOpenAPI";
import { typeErrors } from "./typeErrors";

test.each(["tag-file", "method-file"] as const)(
    "%s imports references used inside inline and extracted schema expressions",
    async (groupStrategy) => {
        const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
        const content = (schema: SchemaObject) => ({ content: { "application/json": { schema } } });
        const operation = (name: string) => ({
            tags: [name],
            operationId: name,
            requestBody: content({ type: "object", properties: { leaf: ref("BodyLeaf") } }),
            responses: {
                "200": content({ oneOf: [ref("Cat"), ref("Dog")] }),
                "400": content({
                    type: "object",
                    properties: { value: ref("Label") },
                    required: ["value", "extra"],
                    additionalProperties: { type: "string" },
                }),
            },
        });
        const document: OpenAPIObject = {
            openapi: "3.0.3",
            info: { title: "Grouped expressions", version: "1" },
            paths: { "/one": { post: operation("one") }, "/two": { put: operation("two") } },
            components: {
                schemas: {
                    Cat: { type: "object", nullable: true, required: ["cat"], properties: { cat: { type: "string" } } },
                    Dog: { type: "object", nullable: true, required: ["dog"], properties: { dog: { type: "string" } } },
                    Label: { type: "string" },
                    BodyLeaf: { type: "integer" },
                    // These names also occur as properties or local bindings in the emitted expressions.
                    value: { type: "boolean" },
                    schema: { type: "string" },
                    union: { type: "integer" },
                },
            },
        };
        const output = await generateZodClientFromOpenAPI({
            openApiDoc: document,
            disableWriteToFile: true,
            options: { groupStrategy, shouldExportAllSchemas: true },
        });

        const groups = groupStrategy === "tag-file" ? ["one", "two"] : ["post", "put"];
        for (const group of groups) {
            for (const name of ["Cat", "Dog", "Label", "one_Body"]) {
                expect(output[group]).toContain(`import { ${name} } from "./common"`);
            }
        }
        expect(output.__common).toContain("export const BodyLeaf");
        for (const name of ["value", "schema", "union"]) {
            expect(output.__common).not.toContain(`export const ${name} =`);
        }
        const files = Object.fromEntries(
            Object.entries(output).map(([name, code]) => [`${name.replace(/^__/, "")}.ts`, code])
        );
        expect(typeErrors(files)).toEqual([]);
    }
);
