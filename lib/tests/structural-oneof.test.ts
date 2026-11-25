import { createRequire } from "node:module";
import type { SchemaObject } from "openapi3-ts";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, test } from "vitest";
import type { z } from "zod";
import { generateZodClientFromOpenAPI } from "../src/generateZodClientFromOpenAPI";
import { makeSchemaResolver } from "../src/makeSchemaResolver";
import { structuralOneOfOverlaps } from "../src/schemaAssertions";
import { typeErrors } from "./typeErrors";

const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });

test.each([false, true])(
    "checks structural oneOf options on raw nonobjects (explicit types and readonly: %s)",
    async (explicit) => {
        const rules: SchemaObject = { properties: { name: { type: "string" } } };
        const tagged = (kind: string): SchemaObject => ({
            required: ["kind"],
            properties: { kind: { type: "string", enum: [kind], default: kind } },
        });
        const discriminator = { propertyName: "kind" };
        const integer: SchemaObject = { type: "integer" };
        const conditional: SchemaObject = { ...rules, if: { type: "number" }, then: { minimum: 1 } };
        const cases: [string, SchemaObject, unknown[], unknown[]][] = [
            ["All", { allOf: [ref("Rules"), ref("Rules")] }, [], [1.5, []]],
            ["Any", { anyOf: [{ contains: { const: "marker" } }, ref("Rules")] }, [], [1.5, ["other"]]],
            ["Integer", { allOf: [ref("Rules"), integer] }, [1.5], [2]],
            ["Scalar", { anyOf: [integer, { type: "boolean" }] }, [1.5], [2, false]],
            ["Uncertain", { anyOf: [{ oneOf: [{ type: "number" }, { type: "number" }] }, integer] }, [1.5], []],
            ["Pattern", { ...rules, pattern: "^[a-z]$" }, ["ab"], ["x"]],
            ["LegacyPattern", { ...rules, pattern: "/^[a-z]$/" }, ["x"], []],
            ["Conditional", conditional, [0], [1.5, [], false]],
            ["ExceptIntegers", { ...rules, if: integer, then: false }, [2], [1.5, [], false]],
        ];
        const choices: Record<string, SchemaObject> = {};
        for (const [index, then] of [
            {},
            { required: ["id"] },
            { properties: { id: { minimum: 0 }, added: { type: "string", default: "new" } } },
        ].entries()) {
            choices["Closed" + index] = {
                properties: { id: integer },
                additionalProperties: false,
                if: { type: "object" },
                then,
            };
        }
        for (const [name, option] of cases) {
            choices[name + "First"] = { oneOf: [option, ref("Rules")] };
            choices[name + "Last"] = { oneOf: [ref("Rules"), option] };
        }
        const source = await generateZodClientFromOpenAPI({
            openApiDoc: {
                openapi: "3.1.0",
                info: { title: "Structural options", version: "1" },
                paths: {},
                components: {
                    schemas: {
                        ...choices,
                        Node: { oneOf: [{ additionalProperties: ref("Node") }, { type: "string" }] },
                        Rules: rules,
                        ObjectCond: conditional,
                        AnyCond: { anyOf: [ref("ObjectCond")] },
                        Unsupported: {
                            anyOf: [{ ...rules, if: { type: "number", minimum: 9 }, then: { minimum: 10 } }],
                        },
                        AlwaysElse: {
                            ...rules,
                            if: { allOf: [false, { type: "number" }] },
                            then: false,
                            else: true,
                        },
                        Contradiction: {
                            ...rules,
                            if: { allOf: [integer, { type: "string" }] },
                            then: true,
                            else: false,
                        },
                        NumberKind: { type: "number" },
                        Positive: { minimum: 1 },
                        RefCond: { ...ref("Rules"), if: ref("NumberKind"), then: ref("Positive"), else: false },
                        ElseOnly: { ...rules, if: { type: "integer" }, else: { type: "string" } },
                        RecursiveCond: {
                            ...rules,
                            if: { type: "object" },
                            then: { properties: { child: ref("RecursiveCond") } },
                            else: false,
                        },
                        Alias: ref("Rules"),
                        Inline: { oneOf: [rules, integer] },
                        Named: { oneOf: [ref("Alias"), integer] },
                        Sibling: { oneOf: [{ ...ref("Alias"), minimum: 5 }, integer] },
                        Wrapped: { allOf: [{ anyOf: [{ oneOf: [ref("Alias")] }] }] },
                        Ambiguous: { oneOf: [ref("Rules"), ref("Wrapped")] },
                        WrappedSibling: { oneOf: [ref("Rules"), { ...ref("Wrapped"), minimum: 3 }] },
                        Approximate: { oneOf: [ref("Rules"), { type: "array", contains: { const: "marker" } }] },
                        NumberArray: { oneOf: [ref("Rules"), { type: "array", items: integer }] },
                        Cat: tagged("cat"),
                        Dog: { ...tagged("dog"), type: "object" },
                        Tagged: { oneOf: [ref("Cat"), tagged("fox")], discriminator },
                        Single: { oneOf: [ref("Cat"), ref("Dog")], discriminator },
                    },
                },
            },
            options: { shouldExportAllSchemas: true, shouldExportAllTypes: explicit, allReadonly: explicit },
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
        for (const [name, , accepts, rejects] of cases) {
            for (const schema of [client[name + "First"]!, client[name + "Last"]!]) {
                for (const value of accepts) expect(schema.safeParse(value).success, name).toBe(true);
                for (const value of rejects) expect(schema.safeParse(value).success, name).toBe(false);
            }
        }
        expect(client.Node!.parse({ child: { leaf: 1 } })).toEqual({ child: { leaf: 1 } });
        expect(client.Node!.safeParse("text").success).toBe(false);
        for (const schema of [client.Closed0!, client.Closed1!, client.Closed2!]) {
            const parsed = schema.parse({ id: 1, other: true });
            expect(parsed).toEqual({ id: 1 });
            expect(Object.isFrozen(parsed)).toBe(explicit);
        }
        expect(client.Closed1!.safeParse({}).success).toBe(false);
        expect(client.Closed2!.safeParse({ id: -1 }).success).toBe(false);
        for (const schema of [client.ObjectCond!, client.AnyCond!]) {
            expect(schema.safeParse(0).success).toBe(false);
            expect(schema.safeParse(1.5).success).toBe(true);
            expect(schema.parse([])).toEqual([]);
            expect(schema.safeParse({ name: 2 }).success).toBe(false);
        }
        expect(client.RefCond!.safeParse([]).success).toBe(false);
        expect(client.RefCond!.safeParse(0).success).toBe(false);
        expect(client.RefCond!.parse(2)).toBe(2);
        for (const value of [1, 1.5, "x", {}, []]) {
            expect(client.Contradiction!.safeParse(value).success).toBe(false);
            expect(client.AlwaysElse!.parse(value)).toEqual(value);
        }
        expect(client.Unsupported!.parse(1.5)).toBe(1.5);
        expect(client.Unsupported!.parse([])).toEqual([]);
        expect(client.ElseOnly!.safeParse(1.5).success).toBe(false);
        expect(client.ElseOnly!.parse(1)).toBe(1);
        expect(client.ElseOnly!.parse("x")).toBe("x");
        expect(client.RecursiveCond!.parse({ child: { name: "leaf" } })).toEqual({ child: { name: "leaf" } });
        expect(client.RecursiveCond!.safeParse({ child: true }).success).toBe(false);
        for (const parser of [client.Named!, client.Inline!]) {
            expect(parser.parse(1.5)).toBe(1.5);
            expect(parser.parse({ name: "ok" })).toEqual({ name: "ok" });
            expect(parser.safeParse(2).success).toBe(false);
            expect(parser.safeParse({ name: 2 }).success).toBe(false);
        }
        expect(client.Sibling!.parse(2)).toBe(2);
        expect(client.Sibling!.safeParse(5).success).toBe(false);
        expect(client.Ambiguous!.safeParse(1.5).success).toBe(false);
        expect(client.WrappedSibling!.parse(1.5)).toBe(1.5);
        expect(client.WrappedSibling!.safeParse(3).success).toBe(false);
        expect(client.Approximate!.parse(["allowed"])).toEqual(["allowed"]);
        expect(client.NumberArray!.parse([1.5])).toEqual([1.5]);
        expect(client.NumberArray!.safeParse([1]).success).toBe(false);
        for (const input of [1, [], null, true, "x"]) {
            expect(client.Tagged!.safeParse(input).success).toBe(false);
            expect(client.Single!.parse(input)).toEqual(input);
        }
        for (const parser of [client.Single!, client.Tagged!]) {
            expect(parser.safeParse({}).success).toBe(false);
            const parsed = parser.parse({ kind: "cat" });
            expect(parsed).toEqual({ kind: "cat" });
            expect(Object.isFrozen(parsed)).toBe(explicit);
        }
        expect(
            typeErrors(
                source +
                    `
const oneMatch: z.input<typeof Named> = 1.5;
const cat: z.output<typeof Tagged> = { kind: "cat" };
// @ts-expect-error both structural options match numbers
const twoMatches: z.input<typeof Tagged> = 1;
// @ts-expect-error both structural options match arrays
const ambiguous: z.output<typeof Tagged> = [];
const permitted: z.output<typeof Single> = true;
const recursive: z.input<typeof Node> = { child: { leaf: true } };
// @ts-expect-error every string matches both alternatives
const recursiveString: z.output<typeof Node> = "text";
const selected: z.input<typeof RecursiveCond> = { child: { name: "leaf" } };
// @ts-expect-error the conditional else rejects arrays
const outside: z.input<typeof RefCond> = [];
`
            )
        ).toEqual([]);
    },
    30_000
);

test("limits the overlap analysis to resolvable 3.1 options", () => {
    const schemas: Record<string, SchemaObject> = {
        Cycle: { allOf: [ref("Cycle")] },
        CycleWithMatch: { anyOf: [ref("CycleWithMatch"), ref("Rules")] },
        Rules: { properties: { name: { type: "string" } } },
    };
    const resolver = (openapi: string) =>
        makeSchemaResolver({ openapi, info: { title: "Version", version: "1" }, paths: {}, components: { schemas } });
    expect(structuralOneOfOverlaps([ref("Rules"), ref("Cycle")], resolver("3.1.0"))).toEqual([]);
    expect(
        structuralOneOfOverlaps([ref("Rules"), ref("CycleWithMatch")], resolver("3.1.0")).find(
            ({ kind }) => kind === "number"
        )?.always
    ).toBe(2);
    expect(structuralOneOfOverlaps([ref("Rules"), { type: "integer" }], resolver("3.0.3"))).toEqual([]);
});
