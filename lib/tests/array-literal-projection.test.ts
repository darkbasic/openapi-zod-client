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
        expect(client.Whole!.parse([{ id: 1, raw: true }])).toEqual([{ id: 1 }]);
        expect(
            typeErrors(
                source +
                    `
const tuple: readonly ["A", "B"] = Tuple.parse([]);
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
