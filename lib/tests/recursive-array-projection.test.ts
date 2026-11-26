import { createRequire } from "node:module";
import type { SchemaObject } from "openapi3-ts";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, test } from "vitest";
import type { z } from "zod";
import { generateZodClientFromOpenAPI } from "../src/generateZodClientFromOpenAPI";
import { typeErrors } from "./typeErrors";

const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
const rows = (items: SchemaObject): SchemaObject => ({ type: "array", items });
const leaf: SchemaObject = {
    type: "object",
    properties: { label: { type: "string" } },
    required: ["label"],
    additionalProperties: false,
};
const flags: SchemaObject = {
    type: "object",
    properties: { flag: { type: "boolean" } },
    required: ["flag"],
    additionalProperties: false,
};
const limit = { maxItems: 10 };

function parsers(source: string): Record<string, z.ZodTypeAny> {
    const { outputText } = transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
    });
    return new Function("require", "exports", outputText + "\nreturn exports.schemas;")(
        createRequire(import.meta.url),
        {}
    );
}

test.each([
    { explicit: false, readonly: false },
    { explicit: false, readonly: true },
    { explicit: true, readonly: false },
    { explicit: true, readonly: true },
])(
    "recursive array projections (explicit $explicit, readonly $readonly)",
    async ({ explicit, readonly }) => {
        const alternatives = (first: SchemaObject) => ({ anyOf: [rows(first), rows(leaf)] });
        const numeric: SchemaObject = {
            type: "object",
            properties: { value: { type: "number" } },
            required: ["value"],
            additionalProperties: false,
        };
        const schemas = {
            Tree: { allOf: [{ anyOf: [rows(ref("Tree")), rows(leaf)] }, limit] },
            Alternatives: { anyOf: [rows(ref("Mixed")), rows(leaf), { type: "string" }] },
            Mixed: { allOf: [ref("Alternatives"), limit, { minItems: 1 }] },
            Exclusive: { allOf: [{ oneOf: [rows(ref("Exclusive")), rows(leaf), { type: "number" }] }, limit] },
            Merged: { allOf: [alternatives(ref("Merged")), rows(flags), limit] },
            Reversed: { allOf: [rows(flags), alternatives(ref("Reversed"))] },
            Finite: { allOf: [alternatives(numeric), rows(flags)] },
            Link: { type: "object", properties: { child: ref("Indirect") } },
            Indirect: { allOf: [{ anyOf: [rows(ref("Link")), rows(leaf)] }, limit] },
        };
        const source = await generateZodClientFromOpenAPI({
            openApiDoc: {
                openapi: "3.1.0",
                info: { title: "Recursive array projections", version: "1" },
                paths: {},
                components: { schemas },
            },
            options: { shouldExportAllSchemas: true, shouldExportAllTypes: explicit, allReadonly: readonly },
            disableWriteToFile: true,
        });
        const client = parsers(source);
        expect(client.Tree!.parse([[{ label: "leaf", extra: true }]])).toEqual([[{ label: "leaf" }]]);
        expect(client.Tree!.safeParse([[], { label: "leaf" }]).success).toBe(false);
        expect(client.Mixed!.parse("leaf")).toBe("leaf");
        expect(client.Exclusive!.parse([[3]])).toEqual([[3]]);
        for (const parser of [client.Merged!, client.Reversed!, client.Finite!]) {
            const merged = parser.parse([{ label: "leaf", flag: true, extra: true }]);
            expect(merged).toEqual([{ label: "leaf", flag: true }]);
            expect(Object.isFrozen(merged)).toBe(readonly);
        }
        expect(
            client.Finite!.safeParse([
                { label: "leaf", flag: true },
                { value: 1, flag: false },
            ]).success
        ).toBe(false);
        expect(client.Indirect!.parse([{ child: [{ child: [] }] }])).toEqual([{ child: [{ child: [] }] }]);
        expect(
            typeErrors(
                source +
                    `
const nested: z.output<typeof Tree> = [[{ label: "leaf" }]];
// @ts-expect-error each array must match a single complete branch
const heterogeneous: z.output<typeof Tree> = [[], { label: "leaf" }];
// @ts-expect-error a recursive leaf requires a string label
const invalid: z.input<typeof Tree> = [[{ label: false }]];
const scalar: z.output<typeof Mixed> = "leaf";
const mixed: z.output<typeof Mixed> = ["leaf", [{ label: "leaf" }]];
// @ts-expect-error the referenced union has no boolean alternative
const invalidScalar: z.output<typeof Mixed> = false;
const exclusive: z.output<typeof Exclusive> = [[3]];
// @ts-expect-error the scalar alternative accepts numbers
const invalidExclusive: z.output<typeof Exclusive> = "leaf";
const merged: z.output<typeof Merged> = [{ flag: true, label: "leaf" }];
const flags: boolean[] = Merged.parse([]).map(row => row.flag);
const reversed: boolean[] = Reversed.parse([]).map(row => row.flag);
const finite: z.output<typeof Finite> = [{ flag: true, value: 1 }];
// @ts-expect-error one union branch must produce the complete array
const heterogeneousMerge: z.output<typeof Finite> = [{ flag: true, value: 1 }, { flag: false, label: "leaf" }];
// @ts-expect-error the merged array requires the fields of both producers
Finite.parse([]).push({ flag: true });
// @ts-expect-error the second producer requires flag
const missing: z.output<typeof Merged> = [{ label: "leaf" }];
const linked: z.output<typeof Indirect> = [{ child: [{ child: [] }] }];
${readonly ? "// @ts-expect-error the parsed array is readonly" : ""}
Tree.parse([]).pop();
`
            )
        ).toEqual([]);
    },
    30000
);

test.each([false, true])(
    "recursive unions select whole array branches (readonly %s)",
    async (readonly) => {
        const label: SchemaObject = { type: "object", properties: { label: { type: "string" } } };
        const amount: SchemaObject = { type: "object", properties: { amount: { type: "number" } } };
        const field = (key: string, tag: number): SchemaObject => ({
            type: "object",
            properties: { [key]: { type: "string" }, tag: { enum: [tag] } },
            required: [key],
        });
        const choices = (key: string, object: string, tag: number) => ({
            anyOf: [...[0, 1, 2].map((i) => rows(field(key + i, i))), field(object, tag)],
        });
        const schemas = {
            // An untyped items keyword also admits all non-array JSON values.
            Branched: { allOf: [{ items: ref("Branched") }, { anyOf: [rows(label), amount, label] }] },
            TwoArrays: { allOf: [{ items: ref("TwoArrays") }, { anyOf: [rows(label), rows(amount)] }] },
            BranchBase: { anyOf: [rows(ref("BranchBase")), leaf] },
            Checked: {
                ...ref("BranchBase"),
                allOf: [{ anyOf: [{ type: "array" }, { type: "object", additionalProperties: false }] }],
                properties: { marker: { type: "string" } },
                required: ["marker"],
            },
            Correlated: {
                allOf: [{ items: ref("Correlated") }, choices("a", "left", 8), choices("b", "right", 9)],
            },
        };
        const source = await generateZodClientFromOpenAPI({
            openApiDoc: {
                openapi: "3.1.0",
                info: { title: "Recursive alternatives", version: "1" },
                paths: {},
                components: { schemas },
            },
            options: { shouldExportAllSchemas: true, allReadonly: readonly },
            disableWriteToFile: true,
        });
        const client = parsers(source);
        expect(client.Checked!.parse({ label: "L", marker: "present" })).toEqual({ label: "L" });
        expect(client.Checked!.safeParse({ label: "L" }).success).toBe(false);
        const mixed = [
            { left: "L", right: "R", a0: "A", b0: "B" },
            { left: "L", right: "R", a1: "A", b0: "B" },
        ];
        expect(client.Correlated!.safeParse(mixed).success).toBe(false);
        expect(client.Correlated!.parse([mixed[0]])).toEqual([mixed[0]]);
        expect(
            typeErrors(
                source +
                    `
const label: z.output<typeof Branched> = { label: "L" };
const amount: z.output<typeof Branched> = { amount: 3 };
const nested: z.output<typeof Branched> = [{ label: "L" }];
// @ts-expect-error the object alternatives preserve their property types
const badLeaf: z.output<typeof Branched> = { label: false, amount: "wrong" };
const empty: z.output<typeof TwoArrays> = [];
// @ts-expect-error the union only has array alternatives
const object: z.output<typeof TwoArrays> = { label: "L" };
// The reference sibling checks the raw marker, and the base strips it.
const checked: z.output<typeof Checked> = { label: "L" };
const checkedTree: z.output<typeof Checked> = [{ label: "L" }];
const base = { left: "L", right: "R" };
const first: z.output<typeof Correlated> = [{ ...base, a0: "A", b0: "B" }];
const second: z.output<typeof Correlated> = [{ ...base, a1: "A", b2: "B" }];
// @ts-expect-error the first producer chooses one branch for the entire array
const mixedFirst: z.output<typeof Correlated> = [{ ...base, a0: "A", b0: "B" }, { ...base, a1: "A", b0: "B" }];
// @ts-expect-error the second producer chooses one branch for the entire array
const mixedSecond: z.output<typeof Correlated> = [{ ...base, a0: "A", b0: "B" }, { ...base, a0: "A", b1: "B" }];
// @ts-expect-error inputs also have to satisfy one complete branch per producer
const badInput: z.input<typeof Correlated> = [{ ...base, a0: "A", b0: "B" }, { ...base, a0: "A", b1: "B" }];
`
            )
        ).toEqual([]);
    },
    30000
);
