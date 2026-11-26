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
            [second, { not: { not: ref("Rule") } }, true],
        ];
        for (const [i, [a, b]] of cases.entries()) {
            schemas["First" + i] = { allOf: [a, b] };
            schemas["Last" + i] = { allOf: [b, a] };
        }
        schemas.Choice = {
            oneOf: [
                { type: "array", items: { required: ["x"], properties: { x: { type: "integer", default: 1 } } } },
                { type: "array", items: { required: ["y"] } },
            ],
        };
        schemas.SelectedRows = {
            allOf: [
                ref("Choice"),
                {
                    type: "array",
                    items: { type: "object", properties: { y: { type: "integer" } }, additionalProperties: false },
                },
            ],
        };
        schemas.ClosedObject = {
            items: { type: "integer" },
            not: { not: { type: "object", properties: { id: { type: "integer" } }, additionalProperties: false } },
        };
        schemas.CheckedRows = {
            allOf: [
                { type: "array", minItems: 2 },
                {
                    type: "array",
                    items: {
                        ...item,
                        properties: {
                            ...item.properties,
                            choice: { anyOf: [{ type: "integer" }, { type: "string" }] },
                        },
                    },
                },
            ],
        };
        schemas.Form = { type: "object", properties: { rows: ref("CheckedRows") } };
        schemas.NestedEnum = {
            type: "object",
            properties: {
                tags: {
                    allOf: [
                        { type: "array", items: { type: "string", enum: ["only"] } },
                        { type: "array", items: { type: "string", default: "only" } },
                    ],
                },
            },
        };
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
        expect(client.SelectedRows!.parse([{ y: 2, extra: 3 }])).toEqual([{ y: 2 }]);
        expect(client.ClosedObject!.parse({ id: 1, extra: "discard" })).toEqual({ id: 1 });
        expect(client.CheckedRows!.safeParse("wrong")).toMatchObject({
            success: false,
            error: {
                issues: [expect.objectContaining({ code: "invalid_type", expected: "array", received: "string" })],
            },
        });
        expect(client.CheckedRows!.safeParse([{}], { errorMap: () => ({ message: "localized" }) })).toMatchObject({
            success: false,
            error: {
                issues: [
                    expect.objectContaining({ code: "too_small", minimum: 2, path: [], message: "localized" }),
                    expect.objectContaining({ code: "invalid_type", path: [0, "tag"], message: "localized" }),
                ],
            },
        });
        const invalid = client.Form!.safeParse(
            { rows: [{ tag: "a", choice: false }, { tag: "b" }] },
            {
                errorMap: () => ({ message: "localized" }),
            }
        );
        expect(invalid.error?.format()).toEqual({
            _errors: [],
            rows: { _errors: [], 0: { _errors: [], choice: { _errors: ["localized", "localized"] } } },
        });
        expect(client.NestedEnum!.safeParse({ tags: ["only", "other"] })).toMatchObject({
            success: false,
            error: {
                issues: [expect.objectContaining({ code: "invalid_literal", expected: "only", path: ["tags", 1] })],
            },
        });
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
        const amount: SchemaObject = {
            type: ["object", "null"],
            properties: { amount: { type: "number" }, currency: { type: "string", default: "EUR" } },
            required: ["amount"],
            additionalProperties: false,
        };
        const unit: SchemaObject = {
            type: ["object", "null"],
            properties: { unit: { type: "string" } },
            required: ["unit"],
            additionalProperties: false,
        };
        const indexed: SchemaObject = { type: ["object", "null"], additionalProperties: { type: "number" } };
        const details = (detail: SchemaObject) =>
            rows({
                ...unit,
                required: ["detail", "label"],
                properties: { detail, label: { type: "string", default: "row" } },
            });
        const container = (key: string, field: SchemaObject, value: unknown): SchemaObject => ({
            type: "object",
            required: [key],
            properties: { [key]: field },
            additionalProperties: false,
            default: { [key]: value },
        });
        const binary: SchemaObject = { type: "string", format: "binary" };
        const schemas = {
            NamedIndex: indexed,
            ContainerDefault: intersect(
                details(container("values", indexed, {})),
                details(container("values", { type: "object" }, { currency: "EUR" }))
            ),
            ListDefault: intersect(
                details({ ...rows(indexed), default: [{}] }),
                details({ ...rows({ type: "object" }), default: [{ currency: "EUR" }] })
            ),
            DisjointDefault: intersect(
                details(container("numbers", indexed, {})),
                details(container("values", { type: "object" }, { currency: "EUR" }))
            ),
            MergedFile: intersect(
                details(binary),
                details({
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                    additionalProperties: false,
                })
            ),
            SoleFile: intersect(details(binary), rows(unit)),
            NestedField: intersect(
                rows({ ...unit, required: ["detail"], properties: { detail: ref("NamedIndex") } }),
                rows({ ...unit, required: ["detail"], properties: { detail: amount } })
            ),
            RecursiveIndex: { type: "object", properties: { money: indexed, child: ref("RecursiveIndex") } },
            RecursiveAmount: { type: "object", properties: { money: amount, child: ref("RecursiveAmount") } },
            RecursiveFields: intersect(
                rows({ ...unit, required: ["detail"], properties: { detail: ref("RecursiveIndex") } }),
                rows({ ...unit, required: ["detail"], properties: { detail: ref("RecursiveAmount") } })
            ),
            RecursiveLeft: {
                type: "object",
                properties: { left: indexed, id: { type: "number" }, child: ref("RecursiveLeft") },
            },
            RecursiveRight: { type: "object", properties: { right: amount, child: ref("RecursiveRight") } },
            DisjointFields: intersect(rows(ref("RecursiveLeft")), rows(ref("RecursiveRight"))),
            OpenDefault: intersect(
                rows({ ...unit, required: ["detail"], properties: { detail: { ...indexed, default: {} } } }),
                rows({
                    ...unit,
                    required: ["detail"],
                    properties: { detail: { type: "object", default: { currency: "EUR" } } },
                })
            ),
            IndexedPair: intersect(rows(indexed), rows(amount)),
            StaticIndex: intersect(rows({ ...amount, type: "object" }), rows({ ...indexed, type: "object" })),
            NestedIndex: intersect(rows(rows(indexed)), rows(rows(amount))),
            NumericIndex: intersect(rows(indexed), rows({ ...amount, properties: { amount: { type: "number" } } })),
            IndexChoice: intersect(rows(amount), {
                anyOf: [rows(indexed), rows({ ...indexed, additionalProperties: { type: "string" } })],
            }),
            Pair: intersect(rows(amount), rows(unit)),
            ReversePair: intersect(rows(unit), rows(amount)),
            NestedPair: intersect(rows(rows(amount)), rows(rows(unit))),
            MixedPair: intersect(
                rows({ anyOf: [amount, { enum: ["raw"] }] }),
                rows({ anyOf: [{ const: "raw" }, unit] })
            ),
            PairWithGuard: intersect(rows(amount), rows(unit), rows({ required: ["raw"] })),
            PartialPair: intersect(rows({ anyOf: [{ const: { amount: 1, raw: true } }, unit] }), rows(amount)),
            FileProjection: intersect(
                rows({ anyOf: [{ type: "string", format: "binary" }, amount] }),
                rows({ ...unit, properties: { name: { type: "string" } }, required: ["name"] })
            ),
            PartialDictionary: intersect(
                rows({
                    anyOf: [
                        { const: { amount: 1, raw: 2 } },
                        { type: "object", additionalProperties: { type: "number" } },
                    ],
                }),
                rows(amount)
            ),
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
        const raw = { amount: 1, unit: "kg", raw: true };
        const parsed = { amount: 1, currency: "EUR", unit: "kg" };
        for (const parser of [client.Pair!, client.ReversePair!, client.PairWithGuard!]) {
            expect(parser.parse([raw, null])).toEqual([parsed, null]);
            expect(parser.safeParse([{ amount: 1 }]).success).toBe(false);
        }
        for (const parser of [client.IndexedPair!, client.StaticIndex!, client.IndexChoice!]) {
            expect(parser.parse([{ amount: 1, score: 2 }])).toEqual([{ amount: 1, score: 2, currency: "EUR" }]);
            expect(parser.safeParse([{ amount: 1, currency: "EUR" }]).success).toBe(false);
        }
        const file = new File([], "a.bin");
        const mergedFile = client.MergedFile!.parse([{ detail: file }])[0];
        expect(mergedFile).toMatchObject({ detail: { name: "a.bin" }, label: "row" });
        expect(mergedFile.detail).not.toBeInstanceOf(File);
        expect(client.SoleFile!.parse([{ detail: file, unit: "kg" }])[0].detail).toBe(file);
        expect(client.ContainerDefault!.parse([{}])).toEqual([
            { label: "row", detail: { values: { currency: "EUR" } } },
        ]);
        expect(client.ListDefault!.parse([{}])).toEqual([{ label: "row", detail: [{ currency: "EUR" }] }]);
        expect(client.OpenDefault!.parse([{}])).toEqual([{ detail: { currency: "EUR" } }]);
        expect(client.NestedField!.parse([{ detail: { amount: 1, score: 2 } }, null])).toEqual([
            { detail: { amount: 1, score: 2, currency: "EUR" } },
            null,
        ]);
        expect(client.FileProjection!.parse([new File([], "a.bin")])).toEqual([{ name: "a.bin" }]);
        expect(client.NestedPair!.parse([[raw, null]])).toEqual([[parsed, null]]);
        expect(client.MixedPair!.parse(["raw", raw])).toEqual(["raw", parsed]);
        expect(client.PartialPair!.parse([{ amount: 1, raw: true }, raw])).toEqual([
            { amount: 1, currency: "EUR" },
            parsed,
        ]);
        expect(
            client.PartialDictionary!.parse([
                { amount: 1, raw: 2 },
                { amount: 2, score: 4 },
            ])
        ).toEqual([
            { amount: 1, currency: "EUR" },
            { amount: 2, currency: "EUR", score: 4 },
        ]);
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
declare const key: string;
const indexedRow = { amount: 1, score: 2, currency: "EUR" };
const indexed: z.output<typeof IndexedPair> = [indexedRow, null];
const nestedField: z.output<typeof NestedField> = [{ detail: indexedRow }, null];
const parsedDetail = NestedField.parse([])[0]!.detail!;
const mergedFile = MergedFile.parse([])[0]!;
const mergedLabel: string = mergedFile.label;
// @ts-expect-error the object merge loses the File prototype
const notAFile: File = mergedFile.detail;
const untouchedFile: File = SoleFile.parse([])[0]!.detail;
const outer = ContainerDefault.parse([{}])[0]!;
const unaffectedLabel: string = outer.label;
// @ts-expect-error an ancestor object's default can supply undeclared entries at values
const nestedDefault: number | undefined = outer.detail.values[key];
const length: number = ListDefault.parse([{}])[0]!.detail.length;
// @ts-expect-error a whole-list default can materialize keys in an entry
const fromList: number | undefined = ListDefault.parse([{}])[0]!.detail[0]![key];
const unchangedIndex: number | undefined = DisjointDefault.parse([{}])[0]!.detail.numbers![key];
const recursiveField = RecursiveFields.parse([])[0]!.detail;
const shallow: string | undefined = recursiveField.money?.currency;
// @ts-expect-error a recursive overlap can contain another independently defaulted dictionary
const unresolved = recursiveField.child.money[key];
const disjoint: number | undefined = DisjointFields.parse([])[0]!.child?.id;
const openDefault: z.output<typeof OpenDefault> = [{ detail: { currency: "EUR" } }];
// @ts-expect-error a whole-object default can supply an undeclared key
const unknownIndex: number | undefined = OpenDefault.parse([{}])[0]!.detail![key];
const nestedCurrency: string = parsedDetail.currency;
// @ts-expect-error a nested dictionary's arbitrary key can select currency
const badNestedIndex: number | undefined = parsedDetail[key];
const staticIndex: z.output<typeof StaticIndex> = [indexedRow];
const nestedIndex: z.output<typeof NestedIndex> = [[indexedRow, null]];
const choiceIndex: z.output<typeof IndexChoice> = [indexedRow];
const parsedIndex = IndexedPair.parse([])[0]!;
const knownCurrency: string = parsedIndex.currency;
const lookup: number | string | undefined = parsedIndex[key];
// @ts-expect-error an arbitrary key can select another producer's string default
const wrongIndex: number | undefined = parsedIndex[key];
const numeric: number | undefined = NumericIndex.parse([])[0]![key];
// @ts-expect-error both numeric producers reject string entries
const invalidIndex: z.output<typeof NumericIndex> = [{ amount: 1, score: "bad" }];
// @ts-expect-error the numeric dictionary rejects a string supplied in the original input
const rawIndex: z.input<typeof IndexedPair> = [indexedRow];
type PairRow = { amount: number; unit: string; currency: string };
for (const parser of [Pair, ReversePair, PairWithGuard] as const) {
    const rows: readonly (PairRow | null)[] = parser.parse([]);
    parser.parse([]).forEach(row => {
        if (!row) return;
        const unit: string = row.unit;
        // @ts-expect-error both producers strip this raw field
        row.raw;
        ${readonly ? "// @ts-expect-error the parsed row is readonly" : ""}
        row.amount = 2;
    });
}
const supplied = { amount: 1, unit: "kg" };
const rawPair: z.input<typeof Pair> = [supplied, null];
// @ts-expect-error the input still requires unit
const missingUnit: z.input<typeof Pair> = [{ amount: 1 }];
// @ts-expect-error the parsed row includes its materialized default
const missingDefault: z.output<typeof Pair> = [{ amount: 1, unit: "kg" }];
const nestedPair: readonly (readonly (PairRow | null)[])[] = NestedPair.parse([]);
NestedPair.parse([]).forEach(rows => rows.forEach(row => { if (row) { const amount: number = row.amount; const unit: string = row.unit; } }));
const mixedPair: readonly ("raw" | PairRow | null)[] = MixedPair.parse([]);
const optionalContribution: z.output<typeof PartialPair> = [{ amount: 1, currency: "EUR", unit: "kg" }];
const noContribution: z.output<typeof PartialPair> = [{ amount: 1, currency: "EUR" }];
// @ts-expect-error the raw assertion accepts this extra key, but no producer retains it
const rawOnly: z.output<typeof PartialPair> = [{ amount: 1, currency: "EUR", raw: true }];
const fileProjection: z.output<typeof FileProjection> = [{ name: "a.bin" }];
const extra: z.output<typeof PartialDictionary> = [{ amount: 1, currency: "EUR" }, { amount: 2, currency: "EUR", score: 4 }];
PartialPair.parse([]).forEach(row => {
    if (!row) return;
    const amount: number = row.amount;
    // @ts-expect-error the raw-only alternative's extra key never survives the other producer
    row.raw;
    if ("unit" in row) { const maybeUnit: string = row.unit; }
});
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
    const refs = ["rows", "choice"];
    const code = arrayProjectionCode(plan, refs, { parser: "rows.and(choice)", outputs: refs }, false, () => "option");
    expect(code.match(/\.safeParse\(/g)!.length).toBeLessThan(25);
});

test("a dictionary under a single owner preserves its shared reference graph", async () => {
    const rows = (properties: NonNullable<SchemaObject["properties"]>): SchemaObject => ({
        type: "array",
        items: { type: "object", properties, additionalProperties: false },
    });
    const schemas: Record<string, SchemaObject> = {
        Leaf: { type: "object", additionalProperties: { type: "number" } },
    };
    let child = ref("Leaf");
    for (let i = 0; i < 8; i++) {
        schemas["Level" + i] = {
            type: "object",
            properties: { left: child, right: child },
            additionalProperties: false,
        };
        child = ref("Level" + i);
    }
    schemas.Root = { allOf: [rows({ tree: child }), rows({ count: { type: "number", default: 1 } })] };
    const source = await generateZodClientFromOpenAPI({
        openApiDoc: {
            openapi: "3.1.0",
            info: { title: "Shared nested rows", version: "1" },
            paths: {},
            components: { schemas },
        },
        options: { shouldExportAllSchemas: true },
        disableWriteToFile: true,
    });
    expect(source.length).toBeLessThan(12_000);
    const { outputText } = transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
    });
    const root: z.ZodTypeAny = new Function("require", "exports", outputText + "\nreturn exports.schemas.Root;")(
        createRequire(import.meta.url),
        {}
    );
    expect(root.parse([{ tree: { left: {} }, count: 2 }])).toEqual([{ tree: { left: {} }, count: 2 }]);
    expect(
        typeErrors(
            source +
                "\nconst value: number | undefined = Root.parse([])[0]!.tree?.left?.left?.left?.left?.left?.left?.left?.left?.extra;"
        )
    ).toEqual([]);
}, 30_000);

test("disabled defaults do not widen a dictionary when a binary field still needs merging", () => {
    const rows = (items: SchemaObject): SchemaObject => ({ type: "array", items });
    const operands = [
        rows({
            type: "object",
            properties: {
                attachment: { type: "string", format: "binary" },
                currency: { type: "string", default: "EUR" },
            },
        }),
        rows({
            type: "object",
            properties: { attachment: { type: "object", properties: { name: { type: "string" } } } },
            additionalProperties: { type: "number" },
        }),
    ];
    const resolver = makeSchemaResolver({ openapi: "3.1.0", info: { title: "Defaults", version: "1" }, paths: {} });
    expect(arrayProjection(operands, resolver)?.mergedItems?.widen).toBe(true);
    expect(arrayProjection(operands, resolver, false, { withDefaultValues: false })?.mergedItems?.widen).toBe(false);
});
