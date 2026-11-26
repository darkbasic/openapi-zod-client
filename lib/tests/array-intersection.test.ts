import { createRequire } from "node:module";
import type { SchemaObject } from "openapi3-ts";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, test } from "vitest";
import type { z } from "zod";
import { generateZodClientFromOpenAPI } from "../src/generateZodClientFromOpenAPI";
import { arrayProjection, arrayProjectionCode } from "../src/arrayProjection";
import { makeSchemaResolver } from "../src/makeSchemaResolver";
import { typeErrors } from "./typeErrors";

const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });

test.each([false, true])(
    "array intersections keep parsed elements in either order (readonly/explicit %s)",
    async (readonly) => {
        const item: SchemaObject = {
            type: "object",
            required: ["tag"],
            additionalProperties: false,
            properties: { tag: { type: "string" }, unit: { type: "string", default: "kg" } },
        };
        const raw = [{ tag: "ok", extra: true }];
        const rule: SchemaObject = { items: item };
        const second: SchemaObject = {
            type: "array",
            items: {
                ...item,
                properties: { tag: { type: "string", minLength: 2 }, lang: { type: "string", default: "it" } },
            },
        };
        const schemas: Record<string, SchemaObject> = {
            Rule: rule,
            Alias: { allOf: [ref("Rule")] },
            Bare: { items: {} },
            Variant: { anyOf: [ref("Rule"), { type: "null" }] },
            Sibling: { ...ref("Bare"), allOf: [{ type: "array", items: item }] },
            Label: { type: "string" },
            DefaultItem: { items: { ...ref("Label"), default: "kg" } },
            DefaultFirst: { allOf: [ref("DefaultItem"), { type: "array" }] },
            DefaultLast: { allOf: [{ type: "array" }, ref("DefaultItem")] },
            Mixed: { allOf: [{ type: ["array", "object", "boolean"] }, { items: ref("Mixed") }] },
            Nested: { allOf: [{ type: "array" }, { items: ref("Nested") }] },
            NullableNested: { allOf: [{ type: ["array", "null"] }, { items: ref("NullableNested") }] },
            PartialItem: { ...item, required: [] },
            Recursive: { ...item, properties: { ...item.properties, child: ref("Recursive") } },
        };
        const cases: [SchemaObject, SchemaObject, boolean][] = [
            [{ type: "array" }, ref("Alias"), false],
            [{ type: "array" }, { ...rule, type: "array" }, false],
            [{ type: ["object", "array"], minItems: 1 }, rule, false],
            [{ type: "array", not: { maxItems: 0 } }, ref("Rule"), false],
            [{ enum: [raw] }, ref("Rule"), false],
            [{ type: "array" }, ref("Variant"), false],
            [ref("Bare"), { type: "array", items: item }, false],
            [second, ref("Variant"), true],
            [{ type: "array", items: { minLength: 1 } }, rule, false],
            [{ type: "array", items: { type: "object" } }, rule, false],
            [{ anyOf: [{ type: "array" }, { type: "boolean" }] }, rule, false],
        ];
        for (const [i, [a, b]] of cases.entries()) {
            schemas["First" + i] = { allOf: [a, b] };
            schemas["Last" + i] = { allOf: [b, a] };
        }
        schemas.Conflict = {
            allOf: [
                rule,
                {
                    type: "array",
                    items: { ...item, properties: { ...item.properties, unit: { type: "string", default: "lb" } } },
                },
            ],
        };
        schemas.RefGuards = {
            ...ref("Rule"),
            allOf: [{}],
            items: {
                type: "object",
                required: ["extra"],
                properties: { extra: { type: "boolean" } },
            },
        };
        const identity: SchemaObject = { type: "array", maxItems: 1 };
        schemas.Choose = { anyOf: [identity, second] };
        schemas.LengthChoice = { allOf: [ref("Choose"), ref("Rule")] };
        schemas.ReverseChoice = { allOf: [ref("Rule"), ref("Choose")] };
        schemas.Overlap = { allOf: [rule, { anyOf: [{ type: "array" }, second] }] };
        schemas.PerItem = {
            allOf: [rule, { items: { anyOf: [{ type: "object", properties: {}, enum: raw }, second.items!] } }],
        };
        const nestedRows: SchemaObject = { type: "array", items: { type: "array", items: item } };
        const objectCheck: SchemaObject = { items: { properties: { name: { type: "string" } } } };
        schemas.NestedRows = { allOf: [nestedRows, objectCheck] };
        schemas.ReverseNestedRows = { allOf: [objectCheck, nestedRows] };
        schemas.NestedChoice = {
            allOf: [nestedRows, { items: { items: { anyOf: [{ type: "object", enum: raw }, second.items!] } } }],
        };
        schemas.AbsentOnly = { allOf: [rule, { type: "array", items: { default: { tag: "fallback" } } }] };
        const source = await generateZodClientFromOpenAPI({
            openApiDoc: {
                openapi: "3.1.0",
                info: { title: "Array intersections", version: "1" },
                paths: {},
                components: { schemas },
            },
            options: { shouldExportAllSchemas: true, shouldExportAllTypes: readonly, allReadonly: readonly },
            disableWriteToFile: true,
        });
        const { outputText } = transpileModule(source, {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
        });
        const client: Record<string, z.ZodTypeAny> = new Function(
            "require",
            "exports",
            outputText + "\nreturn exports.schemas;"
        )(createRequire(import.meta.url), {});
        for (const [i, [, , two]] of cases.entries()) {
            for (const name of ["First" + i, "Last" + i]) {
                const parsed = client[name]!.parse(raw);
                expect(parsed, name).toEqual([{ tag: "ok", unit: "kg", ...(two ? { lang: "it" } : {}) }]);
                expect(Object.isFrozen(parsed), name).toBe(readonly);
                expect(Object.isFrozen(parsed[0]), name).toBe(readonly);
                expect(client[name]!.safeParse([{ tag: 2 }]).success).toBe(false);
            }
        }
        for (const parser of [client.DefaultFirst!, client.DefaultLast!])
            expect(parser.parse([undefined])).toEqual(["kg"]);
        for (const parser of [client.LengthChoice!, client.ReverseChoice!]) {
            expect(parser.parse(raw)).toEqual([{ tag: "ok", unit: "kg" }]);
            expect(parser.parse([raw[0], raw[0]])).toEqual(Array(2).fill({ tag: "ok", unit: "kg", lang: "it" }));
        }
        expect(client.Overlap!.parse([raw[0], raw[0]])).toEqual(Array(2).fill({ tag: "ok", unit: "kg" }));
        expect(client.PerItem!.parse([raw[0], { tag: "two" }])).toEqual([
            { tag: "ok", unit: "kg" },
            { tag: "two", unit: "kg", lang: "it" },
        ]);
        expect(client.Mixed!.parse([[true], {}])).toEqual([[true], {}]);
        for (const parser of [client.NestedRows!, client.ReverseNestedRows!]) {
            expect(parser.parse([raw])).toEqual([[{ tag: "ok", unit: "kg" }]]);
        }
        expect(client.NestedChoice!.parse([[raw[0], { tag: "two" }]])).toEqual([
            [
                { tag: "ok", unit: "kg" },
                { tag: "two", unit: "kg", lang: "it" },
            ],
        ]);
        expect(client.AbsentOnly!.parse(raw)).toEqual([{ tag: "ok", unit: "kg" }]);
        expect(client.RefGuards!.parse(raw)).toEqual([{ tag: "ok", unit: "kg" }]);
        expect(client.RefGuards!.safeParse([{ tag: "ok", extra: 5 }]).success).toBe(false);
        expect(client.Sibling!.parse(raw)).toEqual([{ tag: "ok", unit: "kg" }]);
        expect(client.First2!.safeParse([]).success).toBe(false);
        expect(client.First2!.parse({ key: true })).toEqual({ key: true });
        expect(client.First4!.safeParse([{ tag: "ok" }]).success).toBe(false);
        expect(client.Last7!.safeParse([{ tag: "x" }]).success).toBe(false);
        expect(client.Conflict!.safeParse([{ tag: "ok" }]).success).toBe(false);
        expect(client.PartialItem!.parse({})).toEqual({});
        expect(
            typeErrors(
                source +
                    `
const input: z.input<typeof First0> = [{ tag: "ok" }];
const both: string[] = First7.parse(input).map(item => item.unit + item.lang);
const unit: string = First0.parse(input)[0]!.unit;
// @ts-expect-error items must contain a string tag
const invalid: z.input<typeof Last0> = [{ tag: 2 }];
const mixed: z.output<typeof Mixed> = [true, [[]], {}];
const recursive: z.output<typeof Nested> = [[[]], []];
const nullable: z.output<typeof NullableNested> = [null, []];
// @ts-expect-error only recursively nested arrays match
const invalidRecursive: z.output<typeof Nested> = [1];
const currency: string = Recursive.parse({ tag: "ok" }).unit;
const optional: z.output<typeof PartialItem> = {};
`
            )
        ).toEqual([]);
    },
    30_000
);

test.each([false, true])(
    "array projection preserves validated keys on parsed items (readonly/explicit %s)",
    async (readonly) => {
        const item: SchemaObject = {
            type: "object",
            properties: { id: { type: "integer" } },
            additionalProperties: false,
        };
        const required: SchemaObject = { type: "object", required: ["id", "raw"] };
        const rows = (items: SchemaObject): SchemaObject => ({ type: "array", items });
        const intersect = (...allOf: SchemaObject[]): SchemaObject => ({ allOf });
        const schemas = {
            RecursiveRows: intersect(rows({ anyOf: [ref("RecursiveRows"), item] }), rows({ required: ["id"] })),
            Items: rows(item),
            Guard: rows(required),
            Result: intersect(ref("Items"), ref("Guard")),
            Reversed: intersect(ref("Guard"), ref("Items")),
            Nested: intersect(
                rows(ref("Items")),
                rows(rows({ ...item, properties: { label: { type: "string" } } })),
                rows(ref("Guard")),
                rows(rows({ required: ["label"] }))
            ),
            Dictionary: intersect(rows({ type: "object", additionalProperties: { type: "string" } }), rows(required)),
            Optional: intersect(rows(item), rows({ anyOf: [required, { type: "object" }] })),
            DeclaredGuard: { ...ref("Items"), allOf: [{}], items: { ...item, required: ["id"] } },
            Defaulted: rows({ ...item, default: {} }),
            DefaultedGuard: { ...ref("Defaulted"), allOf: [{}], items: { ...required, default: { id: 1, raw: true } } },
        };
        const source = await generateZodClientFromOpenAPI({
            openApiDoc: {
                openapi: "3.1.0",
                info: { title: "Required keys", version: "1" },
                paths: {},
                components: { schemas },
            },
            options: { shouldExportAllSchemas: true, shouldExportAllTypes: readonly, allReadonly: readonly },
            disableWriteToFile: true,
        });
        const { outputText } = transpileModule(source, {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
        });
        const client: Record<string, z.ZodTypeAny> = new Function(
            "require",
            "exports",
            outputText + "\nreturn exports.schemas;"
        )(createRequire(import.meta.url), {});
        for (const parser of [client.Result!, client.Reversed!]) {
            expect(parser.parse([{ id: 1, raw: true }])).toEqual([{ id: 1 }]);
            expect(parser.safeParse([{ raw: true }]).success).toBe(false);
        }
        expect(client.Nested!.parse([[{ id: 1, label: "ok", raw: true }]])).toEqual([[{ id: 1, label: "ok" }]]);
        expect(client.Optional!.parse([{}])).toEqual([{}]);
        expect(client.DefaultedGuard!.parse([undefined])).toEqual([{}]);
        expect(
            typeErrors(
                source +
                    `
const recursive: z.output<typeof RecursiveRows> = [[{ id: 1 }], []];
const row = Result.parse([])[0]!;
const id: number = row.id;
const reverseId: number = Reversed.parse([])[0]!.id;
const declaredId: number = DeclaredGuard.parse([])[0]!.id;
const nested: [number, string][] = Nested.parse([])[0]!.map(row => [row.id, row.label]);
const dictionaryId: string = Dictionary.parse([])[0]!.id;
// @ts-expect-error the producer strips this key
const stripped = row.raw;
// @ts-expect-error a union branch accepts an object without id
const optional: number = Optional.parse([])[0]!.id;
// @ts-expect-error the guard can validate its own item default
const defaulted: number = DefaultedGuard.parse([undefined])[0]!.id;
${readonly ? "// @ts-expect-error parsed readonly rows cannot be mutated" : ""}
row.id = 2;
`
            )
        ).toEqual([]);
    },
    30_000
);

test("visits shared conjunctive references once per analysis", () => {
    const schemas: Record<string, SchemaObject> = { N0: { items: { type: "object", additionalProperties: false } } };
    for (let i = 1; i <= 12; i++) schemas["N" + i] = { allOf: [ref("N" + (i - 1)), ref("N" + (i - 1))] };
    const resolver = makeSchemaResolver({
        openapi: "3.1.0",
        info: { title: "DAG", version: "1" },
        paths: {},
        components: { schemas },
    });
    let calls = 0;
    const tracked = {
        ...resolver,
        getSchemaByRef: (name: string) => {
            calls++;
            return resolver.getSchemaByRef(name);
        },
    };
    expect(arrayProjection([ref("N12"), { type: "array" }], tracked)?.contributes).toEqual([true, false]);
    expect(calls).toBeLessThan(100);
});

test("emits a shared union decision once", () => {
    const rows: SchemaObject = { type: "array", items: { type: "object", additionalProperties: false } };
    const schemas: Record<string, SchemaObject> = { U0: rows, U1: { type: "array", minItems: 2 } };
    for (let i = 2; i <= 14; i++) schemas["U" + i] = { anyOf: [ref("U" + (i - 1)), ref("U" + (i - 2))] };
    const resolver = makeSchemaResolver({
        openapi: "3.1.0",
        info: { title: "DAG", version: "1" },
        paths: {},
        components: { schemas },
    });
    const plan = arrayProjection([rows, ref("U14")], resolver)!;
    const code = arrayProjectionCode(plan, ["rows", "choice"], "rows.and(choice)", false, () => "option");
    expect(code.match(/\.safeParse\(/g)!.length).toBeLessThan(25);
});
