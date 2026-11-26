import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020";
import type { SchemaObject } from "openapi3-ts";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, test } from "vitest";
import type { z } from "zod";

import { generateZodClientFromOpenAPI } from "../src/generateZodClientFromOpenAPI";
import type { TemplateContext } from "../src/template-context";
import { typeErrors } from "./typeErrors";

const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
const integer: SchemaObject = { type: "integer" };
const arrayOf = (items: SchemaObject): SchemaObject => ({ type: "array", items });
const rules: SchemaObject = { properties: { id: { type: "string" } } };

async function generate(
    schemas: Record<string, SchemaObject>,
    explicit = false,
    openapi = "3.1.0",
    options?: TemplateContext["options"]
) {
    const source = await generateZodClientFromOpenAPI({
        openApiDoc: {
            openapi,
            info: { title: "Negated structural schemas", version: "1" },
            paths: {},
            components: { schemas },
        },
        options: { shouldExportAllSchemas: true, shouldExportAllTypes: explicit, allReadonly: explicit, ...options },
        disableWriteToFile: true,
    });
    const { outputText } = transpileModule(source, {
        compilerOptions: { target: ScriptTarget.ES2020, module: ModuleKind.CommonJS },
    });
    const client: Record<string, z.ZodTypeAny> = new Function(
        "require",
        "exports",
        outputText + "\nreturn exports.schemas;"
    )(createRequire(import.meta.url), {});
    return { client, source };
}

test.each([false, true])(
    "applies negated array item assertions to raw JSON (explicit types/readonly: %s)",
    async (explicit) => {
        const { client, source } = await generate(
            {
                Inline: { ...rules, not: arrayOf(integer) },
                Named: { ...rules, not: ref("List") },
                List: arrayOf(ref("Integer")),
                Integer: integer,
                Minimum: { minimum: 1 },
                Nested: {
                    ...rules,
                    not: {
                        ...arrayOf(arrayOf({ ...ref("Integer"), allOf: [ref("Minimum"), { maximum: 3 }] })),
                        minItems: 1,
                        required: ["ignoredOnArrays"],
                    },
                },
                Untyped: { ...rules, not: { items: ref("Integer") } },
                Overlap: { oneOf: [rules, ref("Named")] },
                // The positive array parser strips fields. The excluded value refers to the supplied object.
                Raw: {
                    ...arrayOf({ type: "object", properties: { id: integer }, additionalProperties: false }),
                    not: arrayOf({ enum: [{ id: 1 }] }),
                },
            },
            explicit
        );

        for (const parser of [client.Inline!, client.Named!]) {
            for (const value of [[], [1], [0, -2]]) expect(parser.safeParse(value).success).toBe(false);
            for (const value of [[1.5], [1, null], null, "text", { id: "yes" }])
                expect(parser.parse(value)).toEqual(value);
            expect(parser.safeParse({ id: 1 }).success).toBe(false);
        }
        for (const value of [[[]], [[1], [2, 3]]]) expect(client.Nested!.safeParse(value).success).toBe(false);
        for (const value of [[], [1], [[1.5]], [[0]], [[4]], null]) expect(client.Nested!.parse(value)).toEqual(value);
        for (const value of [null, false, 1, {}, [], [1]]) expect(client.Untyped!.safeParse(value).success).toBe(false);
        expect(client.Untyped!.parse([1.5])).toEqual([1.5]);
        expect(client.Overlap!.parse([1])).toEqual([1]);
        expect(client.Overlap!.safeParse([1.5]).success).toBe(false);
        expect(client.Raw!.safeParse([{ id: 1 }]).success).toBe(false);
        const parsed = client.Raw!.parse([{ id: 1, marker: true }]);
        expect(parsed).toEqual([{ id: 1 }]);
        expect(Object.isFrozen(parsed)).toBe(explicit);

        expect(
            typeErrors(
                source +
                    `
const fraction: z.input<typeof Inline> = [1.5];
const preserved: z.output<typeof Nested> = null;
// @ts-expect-error the item-only predicate accepts null, so its negation excludes null
const excluded: z.output<typeof Untyped> = null;
`
            )
        ).toEqual([]);
    },
    30_000
);

test("matches JSON Schema 2020-12 for negated item predicates with and without references", async () => {
    const oracle = new Ajv2020({ strict: false });
    const items: SchemaObject[] = [
        integer,
        { type: "number", exclusiveMinimum: 0 },
        { type: "string", minLength: 2 },
        { enum: [null, true, "x"] },
        arrayOf(integer),
    ];
    const values = [
        null,
        false,
        0,
        1.5,
        "x",
        {},
        { id: 2 },
        { id: "x" },
        [],
        [null],
        [false],
        [0],
        [1, 2],
        [1.5],
        ["😀"],
        ["ab"],
        [[]],
        [[1]],
        [[1.5]],
    ];
    const schemas: Record<string, SchemaObject> = {};
    const checks = items.flatMap((item, i) => {
        schemas["Item" + i] = item;
        return [{}, { minItems: 1 }, { maxItems: 1 }].flatMap((bounds, j) => {
            const name = "Rows" + i + "Bound" + j;
            const predicate = { ...arrayOf(item), ...bounds };
            schemas[name] = { ...predicate, items: ref("Item" + i) };
            return [rules, { items: {} }, { type: "array" }].map((base, k) => {
                const suffix = name + "Base" + k;
                const inline = { ...base, not: predicate };
                schemas["Inline" + suffix] = inline;
                schemas["Named" + suffix] = { ...base, not: ref(name) };
                return { suffix, validate: oracle.compile(inline) };
            });
        });
    });

    const { client } = await generate(schemas);
    for (const { suffix, validate } of checks) {
        for (const value of values) {
            const expected = validate(value);
            for (const name of ["Inline" + suffix, "Named" + suffix])
                expect(client[name]!.safeParse(value).success, name + " on " + JSON.stringify(value)).toBe(expected);
        }
    }
});

test.each([false, true])(
    "selects structural array alternatives on the supplied JSON (explicit/readonly: %s)",
    async (explicit) => {
        const oracle = new Ajv2020({ strict: false });
        const x = { properties: { x: integer } };
        const y: SchemaObject = { properties: { y: { type: "string" } } };
        const choice = { oneOf: [arrayOf(x), arrayOf(y)] };
        const excluding = { items: x, not: { required: ["x"] } };
        const defaulting = (key: string): SchemaObject => ({
            required: [key],
            additionalProperties: false,
            properties: { [key]: { ...integer, default: 1 }, label: { type: "string", default: key } },
        });
        const { client, source } = await generate(
            {
                Choice: choice,
                Excluding: excluding,
                X: x,
                Rows: arrayOf(ref("X")),
                Referenced: { oneOf: [ref("Rows"), arrayOf(y)] },
                Wrapped: { oneOf: [arrayOf({ anyOf: [{ oneOf: [ref("X")] }] }), arrayOf({ not: { not: y } })] },
                Double: { oneOf: [{ not: { not: x } }, x] },
                ObjectChoice: arrayOf({ oneOf: [ref("X"), { type: "object" }] }),
                NotOne: { ...arrayOf(x), not: { oneOf: [x, { type: "string" }] } },
                NotAny: { ...arrayOf(x), not: { anyOf: [arrayOf(x), { type: "string" }] } },
                Left: defaulting("x"),
                Right: defaulting("y"),
                First: { oneOf: [arrayOf(ref("Left")), arrayOf(ref("Right"))] },
                Last: { oneOf: [arrayOf(ref("Right")), arrayOf(ref("Left"))] },
                Any: { oneOf: [{ anyOf: [arrayOf(ref("Left")), { type: "boolean" }] }, arrayOf(ref("Right"))] },
                One: { oneOf: [{ oneOf: [arrayOf(ref("Left")), { type: "boolean" }] }, arrayOf(ref("Right"))] },
                Not: { oneOf: [{ allOf: [arrayOf(ref("Left")), { not: { type: "null" } }] }, arrayOf(ref("Right"))] },
                Closed: { not: { allOf: [ref("Left"), { properties: { x: { minimum: 2 } } }] } },
                Own: { not: { required: ["__proto__"], properties: { ["__proto__"]: integer } } },
            },
            explicit
        );
        for (const [rule, names] of [
            [choice, ["Choice", "Referenced", "Wrapped"]],
            [excluding, ["Excluding"]],
        ] as const) {
            const validate = oracle.compile(rule);
            for (const input of [
                null,
                "t",
                {},
                { x: 2 },
                [],
                [1],
                [[]],
                [{}],
                [{ x: "s" }],
                [{ y: 2 }],
                [{ x: "s", y: 2 }],
            ]) {
                for (const name of names)
                    expect(client[name]!.safeParse(input).success, name + " on " + JSON.stringify(input)).toBe(
                        validate(input)
                    );
            }
        }
        for (const value of [1, [], [1], false]) expect(client.Double!.safeParse(value).success).toBe(false);
        expect(client.ObjectChoice!.safeParse([1, {}]).success).toBe(false);
        expect(client.ObjectChoice!.parse([1, { x: "s" }])).toEqual([1, { x: "s" }]);
        for (const parser of [client.NotOne!, client.NotAny!]) expect(parser.safeParse([1]).success).toBe(false);
        for (const parser of [client.First!, client.Last!, client.Any!, client.One!, client.Not!]) {
            expect(parser.safeParse([{}]).success).toBe(false);
            expect(parser.safeParse([{ x: 2, y: 3 }]).success).toBe(false);
            for (const key of ["x", "y"]) {
                const parsed = parser.parse([{ [key]: 2 }]);
                expect(parsed).toEqual([{ [key]: 2, label: key }]);
                expect(Object.isFrozen(parsed)).toBe(explicit);
            }
        }
        for (const value of [{}, { x: 1 }, { x: 2, other: 1 }]) expect(client.Closed!.parse(value)).toEqual(value);
        expect(client.Closed!.safeParse({ x: 2 }).success).toBe(false);
        expect(client.Own!.safeParse({}).success).toBe(true);
        expect(client.Own!.safeParse(JSON.parse('{"__proto__":1}')).success).toBe(false);
        expect(client.Own!.safeParse(JSON.parse('{"__proto__":"x"}')).success).toBe(true);
        expect(typeErrors(source)).toEqual([]);
    },
    30_000
);

test("keeps unresolved and approximate item assertions out of negation and overlap proofs", async () => {
    const approximate = [
        arrayOf({ type: "array", contains: { const: 1 } }),
        arrayOf({ type: "object", required: ["id"], properties: { id: { type: "integer", default: 1 } } }),
        arrayOf({ type: "object", properties: { id: integer }, additionalProperties: false }),
        arrayOf({ type: "string", pattern: "/^x$/" }),
    ];
    const inputs = [[[]], [{}], [{ id: 1, extra: true }], ["x"]];
    const schemas = Object.fromEntries(
        approximate.flatMap((predicate, i) => [
            ["Negated" + i, { ...rules, not: predicate }],
            ["Overlap" + i, { oneOf: [rules, predicate] }],
        ])
    );
    const { client } = await generate({
        ...schemas,
        Recursive: arrayOf(ref("Recursive")),
        NegatedCycle: { ...rules, not: ref("Recursive") },
    });
    expect(client.NegatedCycle!.parse([["leaf"]])).toEqual([["leaf"]]);
    for (const [i, value] of inputs.entries()) {
        expect(client["Negated" + i]!.parse(value)).toEqual(value);
        expect(client["Overlap" + i]!.parse(value)).toEqual(value);
    }
});

test("respects parser options when determining which predicates can be inverted", async () => {
    const { client } = await generate(
        {
            Restricted: { ...rules, not: arrayOf({ not: { type: "object" } }) },
            Optional: { ...rules, not: arrayOf({ properties: { label: { type: "string" } } }) },
            Integers: { ...rules, not: arrayOf(integer) },
        },
        false,
        "3.1.0",
        { strictObjects: true, additionalPropertiesDefaultValue: false, withImplicitRequiredProps: true }
    );
    expect(client.Restricted!.parse([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(client.Optional!.safeParse([{}]).success).toBe(false);
    expect(client.Optional!.safeParse([{ other: true }]).success).toBe(false);
    expect(client.Optional!.parse([{ label: false }])).toEqual([{ label: false }]);
    expect(client.Integers!.safeParse([1]).success).toBe(false);

    const { client: refined } = await generate(
        {
            Refined: { ...rules, not: arrayOf({ type: "integer", "x-replace": true }) },
            Reserved: { type: "string", not: { enum: ["reserved"] } },
        },
        false,
        "3.1.0",
        { schemaRefiner: (schema) => ("x-replace" in schema ? { ...schema, type: "number" } : schema) }
    );
    expect(refined.Refined!.parse([1.5])).toEqual([1.5]);
    expect(refined.Reserved!.safeParse("reserved").success).toBe(false);
    expect(refined.Reserved!.parse("available")).toBe("available");
});

test("keeps OpenAPI 3.0 reference sibling and array negation behavior", async () => {
    const { client } = await generate(
        {
            Legacy: { type: "array", not: arrayOf(integer) },
            Pure: { type: "array", not: { ...ref("Empty"), minItems: 1 } },
            Empty: { type: "array", maxItems: 0 },
        },
        false,
        "3.0.3"
    );
    expect(client.Legacy!.parse([1])).toEqual([1]);
    expect(client.Pure!.safeParse([]).success).toBe(false);
    expect(client.Pure!.parse([1])).toEqual([1]);
});
