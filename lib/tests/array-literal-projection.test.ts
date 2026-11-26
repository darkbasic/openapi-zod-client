import { createRequire } from "node:module";
import type { SchemaObject } from "openapi3-ts";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, test } from "vitest";
import type { z } from "zod";
import { generateZodClientFromOpenAPI } from "../src/generateZodClientFromOpenAPI";
import { typeErrors } from "./typeErrors";

const rows = (items: SchemaObject): SchemaObject => ({ type: "array", items });
const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
const intersect = (...allOf: SchemaObject[]): SchemaObject => ({ allOf });

test.each([false, true])(
    "array projections preserve unchanged scalar literals (readonly/explicit %s)",
    async (explicit) => {
        const only: SchemaObject = { type: "string", enum: ["only"] };
        const withDefault: SchemaObject = { type: "string", default: "fallback" };
        const stripped: SchemaObject = {
            type: "object",
            properties: { id: { type: "number" } },
            required: ["id"],
            additionalProperties: false,
        };
        const guard = rows({ anyOf: [{ const: "only" }, { type: "object", required: ["raw"] }] });
        const producer = rows({ anyOf: [stripped, { type: "string" }] });
        const schemas = {
            Fixed: { items: withDefault, const: ["A", "B"] },
            Tuple: intersect(ref("Fixed"), rows({ type: "string" })),
            Rule: rows(only),
            Defaulted: rows(withDefault),
            Forward: intersect(ref("Rule"), ref("Defaulted")),
            Reverse: intersect(ref("Defaulted"), ref("Rule")),
            Nested: intersect(rows(ref("Rule")), rows(ref("Defaulted"))),
            Unchecked: intersect({ anyOf: [rows(only), {}] }, rows(withDefault)),
            Dynamic: intersect(rows(only), rows(withDefault), rows({ ...withDefault, default: "other" })),
            NestedUnchecked: intersect(rows({ anyOf: [rows(only), {}] }), rows(rows(withDefault))),
            Choices: intersect(
                rows({ anyOf: [{ const: 1 }, { const: true }, { type: "null" }] }),
                rows({ type: ["number", "boolean", "null"], default: 2 })
            ),
            Mixed: intersect(guard, producer),
            MixedOptional: intersect(rows({ anyOf: [only, { type: "object" }] }), producer),
            DefaultedGuard: { ...ref("Defaulted"), allOf: [{}], items: { ...only, default: "only" } },
            TupleGuard: { enum: [["A", "B"]] },
            CheckedTuple: intersect(ref("TupleGuard"), ref("Defaulted")),
            ArrayTuple: intersect(ref("TupleGuard"), { type: ["integer", "array"] }),
            CheckedArrayTuple: intersect(ref("ArrayTuple"), ref("Defaulted")),
            Clipped: intersect({ const: [["A"]] }, rows({ anyOf: [{ const: ["A"] }, stripped] })),
            ConflictingTuple: intersect({ const: [["A", "B"]] }, rows({ anyOf: [{ const: ["A"] }, stripped] })),
            MixedLengths: intersect(
                {
                    anyOf: [
                        {
                            enum: [
                                ["a", "b"],
                                ["c", "d"],
                            ],
                        },
                        rows({ type: "integer" }),
                    ],
                },
                rows({ anyOf: [{ type: "string" }, { type: "integer", default: 0 }] })
            ),
            BroadDefault: { items: { default: { tag: "x" } } },
            MaybeTuple: { ...ref("BroadDefault"), allOf: [{ anyOf: [{ const: null }, { const: [1] }, {}] }] },
            NullableGuard: { type: ["null", "array"], enum: [null, ["hi"]] },
            Impossible: intersect(ref("NullableGuard"), rows(stripped)),
            ObjectRows: intersect({ enum: [[], [[1]], [{ id: 1 }]] }, rows(stripped)),
            Alternatives: intersect({ enum: [[], ["A", "B"], ["C"], ["D", "E"]] }, ref("Defaulted")),
            NestedTuples: intersect(rows({ const: [["A"], ["B", "C"]] }), rows(rows(rows(withDefault)))),
            UncheckedTuple: intersect({ anyOf: [ref("TupleGuard"), {}] }, ref("Defaulted")),
            UncheckedNestedTuple: intersect(rows({ anyOf: [ref("TupleGuard"), {}] }), rows(rows(withDefault))),
            MixedTuple: intersect(
                { const: ["only", { id: 1, raw: true }, ["nested"], {}] },
                rows({
                    anyOf: [
                        { type: "string" },
                        rows(withDefault),
                        {
                            ...stripped,
                            properties: { id: { type: "number", default: 0 }, unit: { type: "string", default: "kg" } },
                        },
                    ],
                })
            ),
            Whole: intersect({ enum: [["only"], [{ id: 1, raw: true }]] }, producer),
        };
        const source = await generateZodClientFromOpenAPI({
            openApiDoc: {
                openapi: "3.1.0",
                info: { title: "Scalar item guards", version: "1" },
                paths: {},
                components: { schemas },
            },
            options: { shouldExportAllSchemas: true, shouldExportAllTypes: explicit, allReadonly: explicit },
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
        for (const parser of [client.Forward!, client.Reverse!]) {
            expect(parser.parse(["only"])).toEqual(["only"]);
            expect(parser.safeParse(["other"]).success).toBe(false);
            expect(parser.safeParse([undefined]).success).toBe(false);
        }
        expect(client.Nested!.parse([["only"]])).toEqual([["only"]]);
        expect(client.Unchecked!.parse(["other"])).toEqual(["other"]);
        expect(client.NestedUnchecked!.parse([["other"]])).toEqual([["other"]]);
        expect(client.Dynamic!.parse(["only"])).toEqual(["only"]);
        expect(client.Choices!.parse([1, true, null])).toEqual([1, true, null]);
        expect(client.Mixed!.parse(["only", { id: 1, raw: true }])).toEqual(["only", { id: 1 }]);
        expect(client.DefaultedGuard!.parse([undefined])).toEqual(["fallback"]);
        expect(client.CheckedTuple!.parse(["A", "B"])).toEqual(["A", "B"]);
        expect(client.CheckedTuple!.safeParse(["B", "A"]).success).toBe(false);
        for (const tuple of [[], ["A", "B"], ["C"], ["D", "E"]])
            expect(client.Alternatives!.parse(tuple)).toEqual(tuple);
        expect(client.NestedTuples!.parse([[["A"], ["B", "C"]]])).toEqual([[["A"], ["B", "C"]]]);
        expect(client.MixedTuple!.parse(["only", { id: 1, raw: true }, ["nested"], {}])).toEqual([
            "only",
            { id: 1, unit: "kg" },
            ["nested"],
            { id: 0, unit: "kg" },
        ]);
        const clipped = client.Clipped!.parse([["A"]]);
        expect(clipped).toEqual([["A"]]);
        expect(Object.isFrozen(clipped)).toBe(explicit);
        expect(Object.isFrozen(clipped[0])).toBe(false);
        expect(client.ConflictingTuple!.safeParse([["A", "B"]]).success).toBe(false);
        expect(client.MixedLengths!.safeParse(["a", "d"]).success).toBe(false);
        expect(client.MixedLengths!.parse([1, 2])).toEqual([1, 2]);
        expect(client.MaybeTuple!.parse(["ok"])).toEqual(["ok"]);
        expect(client.Impossible!.safeParse(["hi"]).success).toBe(false);
        expect(client.ObjectRows!.safeParse([[1]]).success).toBe(false);
        expect(client.ObjectRows!.parse([{ id: 1 }])).toEqual([{ id: 1 }]);
        expect(client.UncheckedTuple!.parse(["any"])).toEqual(["any"]);
        expect(client.UncheckedNestedTuple!.parse([["any"]])).toEqual([["any"]]);
        expect(client.Whole!.parse([{ id: 1, raw: true }])).toEqual([{ id: 1 }]);
        expect(
            typeErrors(
                source +
                    `
const tuple: readonly ["A", "B"] = Tuple.parse([]);
const checked = CheckedTuple.parse([]);
const checkedSlots: readonly ["A", "B"] = checked;
const intersectedTuple: readonly ["A", "B"] = CheckedArrayTuple.parse([]);
const clipped: z.output<typeof Clipped> = [["A"]];
Clipped.parse([])[0][0] = "A";
${explicit ? "// @ts-expect-error the outer array is readonly" : ""}
Clipped.parse([])[0] = ["A"];
const mixedInts: z.output<typeof MixedLengths> = [3, 4, 5];
// @ts-expect-error tuple alternatives stay correlated alongside a broad array branch
const mixedStrings: z.output<typeof MixedLengths> = ["a", "d"];
// @ts-expect-error the broad array branch only admits integers
const mixedKinds: z.output<typeof MixedLengths> = ["a", 3];
const validObjects: z.output<typeof ObjectRows> = [{ id: 1 }];
// @ts-expect-error arrays cannot occupy object-only slots
const incompatibleObjects: z.output<typeof ObjectRows> = [[1]];
const alternatives: readonly [] | readonly ["A", "B"] | readonly ["C"] | readonly ["D", "E"] = Alternatives.parse([]);
const nestedTuples: readonly [readonly ["A"], readonly ["B", "C"]] = NestedTuples.parse([])[0]!;
const validNestedTuples: z.output<typeof NestedTuples> = [[["A"], ["B", "C"]]];
const mixedTuple = MixedTuple.parse([]);
type ParsedObject = { id: number, unit: string };
const mixedSlots: readonly ["only", ParsedObject, readonly ["nested"], ParsedObject] = mixedTuple;
const validMixed: z.output<typeof MixedTuple> = ["only", { id: 1, unit: "kg" }, ["nested"], { id: 0, unit: "kg" }];
// @ts-expect-error the object literal validates a field which the producer strips
mixedTuple[1].raw;
const uncheckedTuple: z.output<typeof UncheckedTuple> = ["any"];
const uncheckedNestedTuple: z.output<typeof UncheckedNestedTuple> = [["any"]];
const exactLength: 2 = checked.length;
// @ts-expect-error slots in different alternatives cannot be combined
const unrelated: z.output<typeof Alternatives> = ["A", "E"];
// @ts-expect-error tuple slots cannot change places
const reversed: z.output<typeof CheckedTuple> = ["B", "A"];
// @ts-expect-error the typed tuple rejects an extra entry
const tooLong: z.output<typeof CheckedTuple> = ["A", "B", "A"];
${explicit ? "// @ts-expect-error readonly tuples disallow writes" : ""}
CheckedTuple.parse([])[0] = "A";
const forward: readonly "only"[] = Forward.parse([]);
const reverse: readonly "only"[] = Reverse.parse([]);
const nested: readonly "only"[] = Nested.parse([])[0]!;
const valid: z.output<typeof Forward> = ["only"];
const unchecked: z.output<typeof Unchecked> = ["other"];
const nestedUnchecked: z.output<typeof NestedUnchecked> = [["other"]];
const dynamic: readonly "only"[] = Dynamic.parse([]);
const choices: (true | 1 | null)[] = Choices.parse([]).map(item => item);
const mixed: ("only" | { id: number })[] = Mixed.parse([]).map(item => item);
const optionalMixed: ("only" | { id: number })[] = MixedOptional.parse([]).map(item => item);
const whole: ("only" | { id: number })[] = Whole.parse([]).map(item => item);
// @ts-expect-error the object producer strips this raw key
Mixed.parse([]).forEach(item => typeof item === "object" && item.raw);
// @ts-expect-error the producer can materialize its own default when all guards accept undefined
const defaulted: "only" = DefaultedGuard.parse([undefined])[0]!;
`
            )
        ).toEqual([]);
    },
    30000
);
