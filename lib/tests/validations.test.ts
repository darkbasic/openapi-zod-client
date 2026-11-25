import { getZodSchema } from "../src/openApiToZod";
import { test, expect } from "vitest";

test("validations", () => {
    expect(
        getZodSchema({
            schema: {
                type: "object",
                properties: {
                    str: { type: "string" },
                    strWithLength: { type: "string", minLength: 3, maxLength: 3 },
                    strWithMin: { type: "string", minLength: 3 },
                    strWithMax: { type: "string", maxLength: 3 },
                    strWithPattern: { type: "string", pattern: "/^[a-z]+$/" },
                    strWithPatternWithSlash: { type: "string", pattern: "/abc/def/ghi/" },
                    email: { type: "string", format: "email" },
                    hostname: { type: "string", format: "hostname" },
                    url: { type: "string", format: "uri" },
                    uuid: { type: "string", format: "uuid" },
                    //
                    number: { type: "number" },
                    int: { type: "integer" },
                    intWithMin: { type: "integer", minimum: 3 },
                    intWithMax: { type: "integer", maximum: 3 },
                    intWithMinAndMax: { type: "integer", minimum: 3, maximum: 3 },
                    intWithExclusiveMinTrue: { type: "integer", minimum: 3, exclusiveMinimum: true },
                    intWithExclusiveMinFalse: { type: "integer", minimum: 3, exclusiveMinimum: false },
                    intWithExclusiveMin: { type: "integer", exclusiveMinimum: 3 },
                    intWithExclusiveMaxTrue: { type: "integer", maximum: 3, exclusiveMaximum: true },
                    intWithExclusiveMaxFalse: { type: "integer", maximum: 3, exclusiveMaximum: false },
                    intWithExclusiveMax: { type: "integer", exclusiveMaximum: 3 },
                    wholeNumber: { type: "number", multipleOf: 1 },
                    //
                    bool: { type: "boolean" },
                    //
                    array: { type: "array", items: { type: "string" } },
                    arrayWithMin: { type: "array", items: { type: "string" }, minItems: 3 },
                    arrayWithMax: { type: "array", items: { type: "string" }, maxItems: 3 },
                    arrayWithFormat: { type: "array", items: { type: "string", format: "uuid" } },
                    // TODO ?
                    // arrayWithUnique: { type: "array", items: { type: "string" }, uniqueItems: true },
                    //
                    object: { type: "object", properties: { str: { type: "string" } } },
                    objectWithRequired: { type: "object", properties: { str: { type: "string" } }, required: ["str"] },
                    // TODO ?
                    // objectWithMin: { type: "object", properties: { str: { type: "string" } }, minProperties: 3 },
                    // objectWithMax: { type: "object", properties: { str: { type: "string" } }, maxProperties: 3 },
                    //
                    oneOf: { oneOf: [{ type: "string" }, { type: "number" }] },
                    anyOf: { anyOf: [{ type: "string" }, { type: "number" }] },
                    allOf: { allOf: [{ type: "string" }, { type: "number" }] },
                    nested: {
                        additionalProperties: { type: "number" },
                    },
                    nestedNullable: {
                        additionalProperties: { type: "number", nullable: true },
                    },
                },
            },
            options: {
                withImplicitRequiredProps: true,
            },
        })
    ).toMatchInlineSnapshot(
        `"z.object({ str: z.string(), strWithLength: z.string().regex(/^[\\s\\S]{3}/u).regex(/^[\\s\\S]{0,3}$/u), strWithMin: z.string().regex(/^[\\s\\S]{3}/u), strWithMax: z.string().regex(/^[\\s\\S]{0,3}$/u), strWithPattern: z.string().regex(/^[a-z]+$/u), strWithPatternWithSlash: z.string().regex(/\\/abc\\/def\\/ghi\\//u), email: z.string().email(), hostname: z.string().max(253).regex(/^(?:[\\da-z](?:[\\da-z-]{0,61}[\\da-z])?\\.)*[\\da-z](?:[\\da-z-]{0,61}[\\da-z])?$/i), url: z.string().url(), uuid: z.string().uuid(), number: z.number(), int: z.number().int(), intWithMin: z.number().int().gte(3), intWithMax: z.number().int().lte(3), intWithMinAndMax: z.number().int().gte(3).lte(3), intWithExclusiveMinTrue: z.number().int().gt(3), intWithExclusiveMinFalse: z.number().int().gte(3), intWithExclusiveMin: z.number().int().gt(3), intWithExclusiveMaxTrue: z.number().int().lt(3), intWithExclusiveMaxFalse: z.number().int().lte(3), intWithExclusiveMax: z.number().int().lt(3), wholeNumber: z.number().int(), bool: z.boolean(), array: z.array(z.string()), arrayWithMin: z.array(z.string()).min(3), arrayWithMax: z.array(z.string()).max(3), arrayWithFormat: z.array(z.string().uuid()), object: z.object({ str: z.string() }).passthrough(), objectWithRequired: z.object({ str: z.string() }).passthrough(), oneOf: z.union([z.string(), z.number()]), anyOf: z.union([z.string(), z.number()]), allOf: z.string().and(z.number()), nested: z.record(z.number()), nestedNullable: z.record(z.number().nullable()) }).passthrough()"`
    );
});
