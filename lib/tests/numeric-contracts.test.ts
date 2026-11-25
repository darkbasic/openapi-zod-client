import { createRequire } from "node:module";
import type { OpenAPIObject, SchemaObject } from "openapi3-ts";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, test } from "vitest";
import type { z } from "zod";
import { generateZodClientFromOpenAPI } from "../src";
import { typeErrors } from "./typeErrors";

const step = 1e-7;
const dose: SchemaObject = { type: "number", multipleOf: step };
const doseRef = { $ref: "#/components/schemas/Dose" };

test("compiles numeric constraints and checks exact decimal multiples in generated clients", async () => {
    const openApiDoc: OpenAPIObject = {
        openapi: "3.1.0",
        info: { title: "Measurements", version: "1" },
        paths: {},
        components: {
            schemas: {
                Dose: dose,
                Readings: { type: "object", additionalProperties: doseRef },
                Sample: { type: "object", required: ["dose"], properties: { dose } },
                Bounded: { allOf: [doseRef], minimum: -1, maximum: 1 },
                Local: { $ref: "#/components/schemas/AnyValue", multipleOf: step },
                AnyValue: {},
                Choices: { type: ["number", "null"], enum: [step, 1.5e-7, null], multipleOf: step },
                Tenth: { type: "number", multipleOf: 0.1 },
                Third: { type: "integer", multipleOf: 3 },
                Instrument: { type: "number", multipleOf: 1.25e-9 },
                BigStep: { type: "number", multipleOf: 1e21 },
                WideCoefficient: { type: "number", multipleOf: 0.10000000000000002 },
                Smallest: { type: "number", multipleOf: 5e-324 },
                Largest: { type: "number", multipleOf: 1e308 },
                BigInt: { type: "string" },
                globalThis: { type: "string" },
            },
        },
    };
    const source = await generateZodClientFromOpenAPI({
        openApiDoc,
        disableWriteToFile: true,
        options: { shouldExportAllSchemas: true },
    });
    expect(typeErrors(source)).toEqual([]);
    const { outputText } = transpileModule(source, {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
    });
    const schemas: Record<string, z.ZodTypeAny> = new Function(
        "require",
        "exports",
        outputText + "\nreturn exports.schemas;"
    )(createRequire(import.meta.url), {});

    for (const [value, expected] of [
        [0, true],
        [-0, true],
        [step, true],
        [-2e-7, true],
        [3e-6, true],
        [1.5e-7, false],
        [1e-8, false],
        [0.00000010000000000000001, false],
    ] as const) {
        expect(schemas.Dose!.safeParse(value).success).toBe(expected);
        expect(schemas.Readings!.safeParse({ latest: value }).success).toBe(expected);
        expect(schemas.Sample!.safeParse({ dose: value }).success).toBe(expected);
        expect(schemas.Bounded!.safeParse(value).success).toBe(expected);
        expect(schemas.Local!.safeParse(value).success).toBe(expected);
    }
    expect(schemas.Bounded!.safeParse(2).success).toBe(false);
    expect(schemas.Local!.parse("available")).toBe("available");
    expect(schemas.Choices!.parse(step)).toBe(step);
    expect(schemas.Choices!.parse(null)).toBeNull();
    expect(schemas.Choices!.safeParse(1.5e-7).success).toBe(false);

    for (const [name, valid, invalid] of [
        ["Tenth", [0.3, -0.3, 1e21], [1e-7, 0.1 + 0.2]],
        ["Third", [3, 3e21], [0.3, 1e21]],
        ["Instrument", [0, 3.75e-9, 1e100], [1e-9, 3.750000000000001e-9]],
        ["BigStep", [0, 2e21, -1e24], [1e20, 1.5e21]],
        ["WideCoefficient", [0.10000000000000002, 0.20000000000000004], [0.1, 0.2]],
        ["Smallest", [5e-324, 1e-323, 1e308], []],
        ["Largest", [0, -1e308], [1, Number.MAX_VALUE]],
    ] as const) {
        for (const value of valid) expect(schemas[name]!.safeParse(value).success, name + ": " + value).toBe(true);
        for (const value of [...invalid, Infinity, -Infinity, NaN]) {
            expect(schemas[name]!.safeParse(value).success, name + ": " + value).toBe(false);
        }
    }
    const result = schemas.Dose!.safeParse(0.5e-7);
    expect(result.error?.issues).toMatchObject([{ code: "not_multiple_of", multipleOf: step }]);
});
