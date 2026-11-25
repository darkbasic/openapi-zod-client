import { getZodSchema } from "../src";
import { expect, test } from "vitest";
import { applyUseSite } from "../src/openApiToZod";
import { SchemaObject } from "openapi3-ts";

test("unicode-pattern-regex", () => {
    const schema: SchemaObject = {
        type: "string",
        pattern: "\\p{L}+",
    };
    const schemaWithSlashes: SchemaObject = {
        type: "string",
        pattern: "/\\p{L}+/",
    };
    const schemaWithComplexUnicodePattern: SchemaObject = {
        type: "string",
        pattern: "$|^[\\p{L}\\d]+[\\p{L}\\d\\s.&()\\*'',-;#]*|$",
    };
    const schemaWithSlashU: SchemaObject = {
        type: "string",
        pattern: "\\u{1F600}+",
    };
    expect(applyUseSite(getZodSchema({ schema }).toString(), { schema })).toMatchInlineSnapshot(
        '"z.string().regex(/\\p{L}+/u).optional()"'
    );
    expect(
        applyUseSite(getZodSchema({ schema: schemaWithSlashes }).toString(), { schema: schemaWithSlashes })
    ).toMatchInlineSnapshot(`"z.string().regex(/\\/\\p{L}+\\//u).optional()"`);
    expect(
        applyUseSite(getZodSchema({ schema: schemaWithComplexUnicodePattern }).toString(), {
            schema: schemaWithComplexUnicodePattern,
        })
    ).toMatchInlineSnapshot("\"z.string().regex(/$|^[\\p{L}\\d]+[\\p{L}\\d\\s.&()\\*'',-;#]*|$/u).optional()\"");
    expect(
        applyUseSite(getZodSchema({ schema: schemaWithSlashU }).toString(), { schema: schemaWithSlashU })
    ).toMatchInlineSnapshot('"z.string().regex(/\\u{1F600}+/u).optional()"');
});
