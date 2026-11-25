import type { SchemaObject } from "openapi3-ts";
import { transpileModule } from "typescript";
import { expect, it } from "vitest";
import { z } from "zod";
import { getZodClientTemplateContext } from "../src/template-context";

function generate(
    values: Record<string, SchemaObject>,
    allReadonly = false,
    shouldExportAllTypes = false
): z.ZodTypeAny {
    const { schemas } = getZodClientTemplateContext(
        { openapi: "3.1.0", info: { title: "Response", version: "1" }, paths: {}, components: { schemas: values } },
        { shouldExportAllSchemas: true, allReadonly, shouldExportAllTypes }
    );
    const declarations = Object.entries(schemas)
        .map(([name, expr]) => `const ${name} = ${expr};`)
        .join("\n");
    return new Function("z", transpileModule(declarations, {}).outputText + "\nreturn Response;")(z);
}

it("requires dictionary keys and checks reference siblings for every value", () => {
    const schema = generate({
        check: { type: "string", enum: ["a", "ab"] },
        Response: {
            type: "object",
            required: ["role"],
            additionalProperties: { $ref: "#/components/schemas/check", minLength: 2 },
        },
    });
    expect(schema.safeParse({ role: "ab", other: "ab" }).success).toBe(true);
    for (const invalid of [{}, { role: "a" }, { role: "ab", other: "a" }, { role: "abc" }]) {
        expect(schema.safeParse(invalid).success).toBe(false);
    }
});

it("applies value defaults to additional entries while requiring explicitly named entries", () => {
    const schema = generate({
        Response: { type: "object", required: ["primary"], additionalProperties: { type: "string", default: "new" } },
    });
    expect(schema.parse({ primary: "active", extra: undefined })).toEqual({ primary: "active", extra: "new" });
    expect(schema.parse({ primary: "active" })).toEqual({ primary: "active" });
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ primary: undefined }).success).toBe(false);
    expect(schema.safeParse({ primary: "active", extra: 42 }).success).toBe(false);
});

it.each([["label"], ["label", "total"]])(
    "uses the additional value schema only for undeclared keys (%s)",
    (...required) => {
        const schema = generate({
            Response: {
                type: "object",
                required,
                properties: { label: { type: "string" } },
                additionalProperties: { type: "integer" },
            },
        });
        expect(schema.parse({ label: "score", total: 3 })).toEqual({ label: "score", total: 3 });
        expect(schema.safeParse({ label: 2, total: 3 }).success).toBe(false);
        expect(schema.safeParse({ label: "score", total: 0.5 }).success).toBe(false);
        expect(schema.safeParse({ label: "score" }).success).toBe(!required.includes("total"));
        expect(schema.safeParse({ total: 3 }).success).toBe(false);
    }
);

it("validates array length on nullable references when a component is named Array", () => {
    const schema = generate({
        globalThis: { type: "string" },
        Array: { type: ["array", "null"], items: { type: "number" } },
        Response: { type: "object", additionalProperties: { $ref: "#/components/schemas/Array", maxItems: 0 } },
    });
    expect(schema.parse({ a: [], b: null })).toEqual({ a: [], b: null });
    expect(schema.safeParse({ a: [1] }).success).toBe(false);
});

it.each([false, true])("preserves parsed dictionary entries when a key is required (readonly: %s)", (allReadonly) => {
    const schema = generate(
        {
            Detail: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
                additionalProperties: false,
            },
            Response: {
                type: "object",
                required: ["primary"],
                additionalProperties: { $ref: "#/components/schemas/Detail" },
            },
        },
        allReadonly
    );
    const parsed = schema.parse({ primary: { id: "first", extra: true }, secondary: { id: "second", extra: true } });
    expect(parsed).toEqual({ primary: { id: "first" }, secondary: { id: "second" } });
    expect(Object.isFrozen(parsed.primary)).toBe(allReadonly);
    expect(Object.isFrozen(parsed.secondary)).toBe(allReadonly);
    expect(schema.safeParse({ secondary: { id: "second" } }).success).toBe(false);
});

it("applies a dictionary value's length constraint to its referenced nullable string", () => {
    const schema = generate({
        Code: { type: ["string", "null"] },
        Response: { type: "object", additionalProperties: { $ref: "#/components/schemas/Code", minLength: 2 } },
    });
    expect(schema.safeParse({ editable: null, role: "ab" }).success).toBe(true);
    expect(schema.safeParse({ role: "a" }).success).toBe(false);
});

const dictionaryConstraints: [SchemaObject, unknown[], unknown[]][] = [
    [{ type: "string" }, ["valid", "other"], [42]],
    [{ enum: ["valid", 42] }, ["valid", 42], ["other", 41]],
];
it.each(dictionaryConstraints)(
    "enforces dictionary reference siblings without length or pattern keywords (%j)",
    (constraint, valid, invalid) => {
        const schema = generate({
            Value: { type: ["string", "integer"] },
            Response: { type: "object", additionalProperties: { $ref: "#/components/schemas/Value", ...constraint } },
        });
        for (const value of valid) expect(schema.safeParse({ value }).success).toBe(true);
        for (const value of invalid) expect(schema.safeParse({ value }).success).toBe(false);
    }
);

it("keeps the referenced array's parsed elements when validating the dictionary value's length", () => {
    const schema = generate({
        Rows: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["id"],
                properties: { id: { type: "string" } },
            },
        },
        Response: {
            type: "object",
            additionalProperties: { $ref: "#/components/schemas/Rows", type: "array", minItems: 1 },
        },
    });
    expect(schema.parse({ rows: [{ id: "i", extra: 5 }] })).toEqual({ rows: [{ id: "i" }] });
    expect(schema.safeParse({ rows: [] }).success).toBe(false);
});

it.each(["File", "globalThis"])("uses the platform File with a component named %s", (name) => {
    const schema = generate({
        [name]: { type: "object" },
        Response: {
            type: "object",
            properties: {
                data: { type: "string", format: "binary" },
                metadata: { $ref: "#/components/schemas/" + name },
            },
            required: ["data", "metadata"],
        },
    });
    const file = new File(["upload"], "photo");
    expect(schema.parse({ data: file, metadata: {} }).data).toBe(file);
    expect(schema.safeParse({ data: {}, metadata: {} }).success).toBe(false);
});

it("keeps binary values as Files when targets, aliases or dictionary entries specify text constraints", () => {
    const schema = generate({
        Binary: { type: "string", format: "binary", minLength: 1, maxLength: 3 },
        Upload: { $ref: "#/components/schemas/Binary", minLength: 2 },
        Response: {
            type: "object",
            required: ["first"],
            additionalProperties: {
                $ref: "#/components/schemas/Upload",
                type: "string",
                minLength: 1,
                pattern: "^a",
                description: "User file",
            },
        },
    });
    const file = new File(["contents"], "photo");
    expect(schema.parse({ first: file, extra: file })).toEqual({ first: file, extra: file });
    expect(schema.safeParse({ first: "abc" }).success).toBe(false);
    expect(schema.safeParse({ extra: file }).success).toBe(false);
});

it("checks a local enum and pattern without calling string methods on a Zod enum", () => {
    const schema = generate({
        Code: { type: "string", minLength: 2, default: "aa" },
        Alias: { $ref: "#/components/schemas/Code" },
        Response: {
            type: "object",
            additionalProperties: {
                $ref: "#/components/schemas/Alias",
                type: "string",
                enum: ["a", "aa", "bb"],
                pattern: "^a",
            },
        },
    });
    expect(schema.safeParse({ code: "aa" }).success).toBe(true);
    expect(schema.parse({ code: undefined })).toEqual({ code: "aa" });
    for (const code of ["a", "bb", "ac"]) expect(schema.safeParse({ code }).success).toBe(false);
});

it.each(["inline", "reference"])("loads a tagged union with an impossible %s branch", (variant) => {
    const closed: SchemaObject = {
        type: "object",
        properties: { kind: { type: "string", enum: ["retired"] } },
        additionalProperties: false,
        required: ["kind", "missing"],
    };
    const schema = generate({
        Closed: closed,
        Response: {
            oneOf: [
                variant === "inline" ? closed : { $ref: "#/components/schemas/Closed" },
                { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["active"] } } },
            ],
            discriminator: { propertyName: "kind" },
        },
    });
    expect(schema.safeParse({ kind: "active" }).success).toBe(true);
    expect(schema.safeParse({ kind: "retired" }).success).toBe(false);
    expect(schema.safeParse({ kind: "retired", missing: true }).success).toBe(false);
    expect(schema.safeParse({ kind: "unknown" }).success).toBe(false);
});

it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
])("dispatches aliased tagged objects before defaults (readonly: %s, explicit types: %s)", (allReadonly, allTypes) => {
    const schema = generate(
        {
            Active: {
                type: "object",
                required: ["kind"],
                properties: { kind: { type: "string", enum: ["active"], default: "active" } },
            },
            Alias: { allOf: [{ $ref: "#/components/schemas/Active" }] },
            AnotherAlias: { $ref: "#/components/schemas/Alias" },
            Archived: {
                type: "object",
                required: ["kind"],
                properties: {
                    kind: { type: "string", enum: ["archived"] },
                    previous: { $ref: "#/components/schemas/Archived" },
                },
            },
            Response: {
                oneOf: [{ $ref: "#/components/schemas/AnotherAlias" }, { $ref: "#/components/schemas/Archived" }],
                discriminator: { propertyName: "kind" },
            },
        },
        allReadonly,
        allTypes
    );
    expect(schema.safeParse({}).success).toBe(false);
    expect(Object.isFrozen(schema.parse({ kind: "active" }))).toBe(allReadonly);
    const archived = { kind: "archived", previous: { kind: "archived" } };
    expect(schema.parse(archived)).toEqual(archived);
    expect(schema.safeParse({ ...archived, previous: { kind: "other" } }).success).toBe(false);
});

it.each([{}, { enum: ["shared"] }])("loads aliased options without distinct literal tags (%j)", (constraint) => {
    const kind = { type: "string", ...constraint } as const;
    const schema = generate({
        Left: { type: "object", required: ["kind", "left"], properties: { kind, left: { type: "number" } } },
        Alias: { $ref: "#/components/schemas/Left" },
        Right: { type: "object", required: ["kind", "right"], properties: { kind, right: { type: "boolean" } } },
        Response: {
            oneOf: [{ $ref: "#/components/schemas/Alias" }, { $ref: "#/components/schemas/Right" }],
            discriminator: { propertyName: "kind" },
        },
    });
    expect(schema.safeParse({ kind: "shared", left: 0 }).success).toBe(true);
    expect(schema.safeParse({ kind: "shared", right: false }).success).toBe(true);
    expect(schema.safeParse({ kind: "shared" }).success).toBe(false);
});

it("keeps native discriminator dispatch through component aliases", () => {
    const schema = generate({
        Active: {
            type: "object",
            required: ["kind"],
            properties: { kind: { type: "string", enum: ["active"], default: "active" } },
        },
        Alias: { allOf: [{ $ref: "#/components/schemas/Active" }] },
        Response: {
            oneOf: [
                { $ref: "#/components/schemas/Alias" },
                { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["other"] } } },
            ],
            discriminator: { propertyName: "kind" },
        },
    });
    expect(schema).toBeInstanceOf(z.ZodDiscriminatedUnion);
    expect(schema.safeParse({}).success).toBe(false);
});

it("resolves recursive arrays with inline tagged items before applying a wrapped tag's default", () => {
    const items: SchemaObject = {
        oneOf: [{ $ref: "#/components/schemas/Node" }, { $ref: "#/components/schemas/Leaf" }],
        discriminator: { propertyName: "kind" },
    };
    const schema = generate({
        Node: {
            type: "object",
            required: ["kind", "children"],
            properties: {
                kind: { type: "string", enum: ["node"] },
                children: { type: "array", items },
            },
        },
        Leaf: {
            type: "object",
            required: ["kind"],
            properties: {
                kind: { oneOf: [{ type: "string", enum: ["leaf"] }], default: "leaf" },
            },
        },
        Response: items,
    });
    const tree = { kind: "node", children: [{ kind: "node", children: [{ kind: "leaf" }] }] };
    expect(schema.parse(tree)).toEqual(tree);
    expect(schema.safeParse({ kind: "node", children: [{}] }).success).toBe(false);
});

it("a scalar sibling checks dictionary entries without restoring stripped properties", () => {
    const schema = generate({
        Closed: {
            type: "object",
            properties: { id: { type: "integer" } },
            required: ["id"],
            additionalProperties: false,
        },
        Response: {
            type: "object",
            additionalProperties: { $ref: "#/components/schemas/Closed", maxLength: 2 },
        },
    });
    expect(schema.parse({ row: { id: 1, extra: true } })).toEqual({ row: { id: 1 } });
});

it("checks negative constraints before the referenced parser applies its defaults", () => {
    const schema = generate({
        Base: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "integer" }, name: { type: "string", default: "new" } },
        },
        Response: {
            $ref: "#/components/schemas/Base",
            not: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        },
    });
    expect(schema.parse({ id: 1 })).toEqual({ id: 1, name: "new" });
});

it("preserves valid arrays when a negated keyword has no Zod equivalent", () => {
    const schema = generate({ Response: { type: "array", not: { contains: { const: "forbidden" } } } });
    expect(schema.parse(["allowed"])).toEqual(["allowed"]);
});

it("checks an object literal against input even when parsing adds a field", () => {
    const schema = generate({
        Base: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "integer" }, name: { type: "string", default: "new" } },
        },
        Response: { $ref: "#/components/schemas/Base", enum: [{ id: 1 }] },
    });
    expect(schema.parse({ id: 1 })).toEqual({ id: 1, name: "new" });
    expect(schema.safeParse({ id: 2 }).success).toBe(false);
});

it.each([false, true])(
    "reference sibling assertions preserve the referenced parser's output (readonly %s)",
    (readonly) => {
        const schema = generate(
            {
                Closed: {
                    type: "object",
                    properties: { id: { type: "integer" } },
                    required: ["id"],
                    additionalProperties: false,
                },
                Response: { $ref: "#/components/schemas/Closed", required: ["id"], properties: { id: { minimum: 1 } } },
            },
            readonly
        );
        const parsed = schema.parse({ id: 1, extra: "discard" });
        expect(parsed).toEqual({ id: 1 });
        expect(Object.isFrozen(parsed)).toBe(readonly);
        expect(schema.safeParse({ id: 0 }).success).toBe(false);
    }
);
