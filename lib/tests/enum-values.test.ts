import type { SchemaObject } from "openapi3-ts";
import { transpileModule } from "typescript";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { getZodSchema } from "../src/openApiToZod";
import { getZodClientTemplateContext } from "../src/template-context";
import { typeErrors } from "./typeErrors";

function generatedSchema(schema: SchemaObject): z.ZodTypeAny {
    const source = transpileModule(`const schema = ${getZodSchema({ schema })};`, {}).outputText;
    return new Function("z", source + "\nreturn schema;")(z);
}

describe("enum values", () => {
    test("a null discriminator excluded by its enum leaves the other branch usable", () => {
        const option = (kind: SchemaObject): SchemaObject => ({
            type: "object",
            required: ["kind"],
            properties: { kind },
        });
        const schema = generatedSchema({
            oneOf: [option({ type: "null", enum: ["retired"] }), option({ type: "string", enum: ["active"] })],
            discriminator: { propertyName: "kind" },
        });
        expect(schema.parse({ kind: "active" })).toEqual({ kind: "active" });
        expect(schema.safeParse({ kind: null }).success).toBe(false);
    });
    test("filters fractional integer enum members in both generated validators and types", () => {
        const integers: SchemaObject = { type: "integer", enum: [1, 1.5, 2] };
        const context = getZodClientTemplateContext(
            {
                openapi: "3.1.0",
                info: { title: "Integers", version: "1" },
                paths: {},
                components: {
                    schemas: {
                        Count: integers,
                        Counts: { type: "array", items: { $ref: "#/components/schemas/Count" } },
                    },
                },
            },
            { shouldExportAllSchemas: true, shouldExportAllTypes: true }
        );
        expect(
            typeErrors(`${context.types.Count}
const allowed: Count = 2;
// @ts-expect-error integer enums exclude fractional literals
const fractional: Count = 1.5;
`)
        ).toEqual([]);
        const validator = generatedSchema({ ...integers, maximum: 1 });
        expect(validator.parse(1)).toBe(1);
        expect(validator.safeParse(1.5).success).toBe(false);
        expect(validator.safeParse(2).success).toBe(false);
        expect(generatedSchema({ type: "number", enum: [1.5] }).parse(1.5)).toBe(1.5);
    });
    test.each<SchemaObject>([
        { type: "string", enum: ["ready", "waiting", null] },
        { type: "string", enum: ["ready", "waiting", null], nullable: true },
        { type: ["string", "null"], enum: ["ready", "waiting", null] },
    ])("accepts nullable string enum members: %j", (input) => {
        const schema = generatedSchema(input);
        for (const value of ["ready", "waiting", null]) {
            expect(schema.safeParse(value).success).toBe(true);
        }
        for (const value of ["other", "null", 1, undefined]) {
            expect(schema.safeParse(value).success).toBe(false);
        }
    });

    test("preserves null-only and single-label nullable enums", () => {
        const nullOnly = { type: "string", enum: [null] };
        expect(getZodSchema({ schema: nullOnly }).toString()).toBe("z.null()");
        const nullSchema = generatedSchema(nullOnly);
        expect(nullSchema.safeParse(null).success).toBe(true);
        expect(nullSchema.safeParse("null").success).toBe(false);

        const singleLabel = generatedSchema({ type: "string", enum: ["ready", null] });
        expect(singleLabel.safeParse("ready").success).toBe(true);
        expect(singleLabel.safeParse(null).success).toBe(true);
        expect(singleLabel.safeParse("other").success).toBe(false);
    });

    const labels = ["can't", 'quoted "label"', "path\\name", "new\nline", "tab\there", "null"];

    test.each(labels)("escapes a single enum label: %j", (label) => {
        const schema = generatedSchema({ type: "string", enum: [label] });
        expect(schema.parse(label)).toBe(label);
        expect(schema.safeParse("other").success).toBe(false);
        expect(schema.safeParse(null).success).toBe(false);
    });

    test("escapes multiple labels without changing their values", () => {
        const schema = generatedSchema({ type: "string", enum: [...labels, null] });
        for (const value of [...labels, null]) {
            expect(schema.parse(value)).toBe(value);
        }
        expect(schema.safeParse("other").success).toBe(false);
    });

    const mixedValues = ["ready", -1, 0, true, false, null];

    test("preserves every primitive branch of an OpenAPI 3.1 enum", () => {
        const schema = generatedSchema({
            type: ["string", "integer", "boolean", "null"],
            enum: mixedValues,
        });
        for (const value of mixedValues) {
            expect(schema.safeParse(value).success).toBe(true);
        }
        for (const value of ["-1", "0", "true", "false", 1, undefined]) {
            expect(schema.safeParse(value).success).toBe(false);
        }
    });

    test.each([
        { type: "string", accepted: ["ready", null], rejected: [-1, 0, true, false, "-1"] },
        { type: "integer", accepted: [-1, 0, null], rejected: ["ready", true, false, 1] },
        { type: "number", accepted: [-1, 0, null], rejected: ["ready", true, false, 1] },
        { type: "boolean", accepted: [true, false, null], rejected: ["ready", -1, 0, "true"] },
    ])("filters enum values to the $type branch", ({ type, accepted, rejected }) => {
        const schema = generatedSchema({ type, enum: mixedValues });
        for (const value of accepted) {
            expect(schema.safeParse(value).success).toBe(true);
        }
        for (const value of rejected) {
            expect(schema.safeParse(value).success).toBe(false);
        }
    });
});
