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
        const { outputText } = transpileModule(source, {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
        });
        const client: Record<string, z.ZodTypeAny> = new Function(
            "require",
            "exports",
            outputText + "\nreturn exports.schemas;"
        )(createRequire(import.meta.url), {});
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
