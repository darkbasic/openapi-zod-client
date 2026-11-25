import { transpileModule } from "typescript";
import type { OpenAPIObject } from "openapi3-ts";
import { expect, test } from "vitest";
import { z } from "zod";
import { getZodClientTemplateContext } from "../src/template-context";
import { typeErrors } from "./typeErrors";

test("a readonly dictionary can reference itself through an anyOf value", () => {
    const context = getZodClientTemplateContext(
        {
            openapi: "3.1.0",
            info: { title: "Recursive dictionary", version: "1" },
            paths: {},
            components: {
                schemas: {
                    Tree: {
                        type: "object",
                        required: ["primary"],
                        additionalProperties: {
                            anyOf: [{ $ref: "#/components/schemas/Tree" }, { type: "string" }, { type: "null" }],
                        },
                    },
                },
            },
        },
        { shouldExportAllSchemas: true, allReadonly: true }
    );
    expect(
        typeErrors(`import { z } from "zod";
${context.types.Tree}
const Tree: z.ZodType<Tree> = ${context.schemas.Tree};
const tree: Tree = { primary: { primary: "leaf" }, extra: null };
// @ts-expect-error the named key is readonly
tree.primary = null;
// @ts-expect-error the index signature is readonly
tree.extra = "leaf";
// @ts-expect-error every level requires its primary entry
const invalid: Tree = { primary: {} };`)
    ).toEqual([]);
});

test.each([false, true])("anyOf types match runtime unions (readonly: %s)", (allReadonly) => {
    const document: OpenAPIObject = {
        openapi: "3.1.0",
        info: { title: "anyOf types", version: "1" },
        paths: {},
        components: {
            schemas: {
                Status: { type: ["string", "null"], enum: ["ready", 'quoted "label"', null] },
                Mixed: {
                    type: ["string", "integer", "boolean", "null"],
                    enum: ["ready", -1, 0, true, false, null],
                },
                Node: {
                    type: "object",
                    required: ["status", "mixed", "parent", "choice", "children"],
                    properties: {
                        settings: { type: "object", properties: { label: { type: "string" } } },
                        status: { $ref: "#/components/schemas/Status" },
                        mixed: { $ref: "#/components/schemas/Mixed" },
                        parent: { anyOf: [{ $ref: "#/components/schemas/Node" }, { type: "null" }] },
                        choice: { nullable: true, anyOf: [{ type: "string" }, { type: "number" }] },
                        children: {
                            anyOf: [{ type: "array", items: { $ref: "#/components/schemas/Node" } }, { type: "null" }],
                        },
                    },
                },
            },
        },
    };
    const context = getZodClientTemplateContext(document, {
        shouldExportAllSchemas: true,
        shouldExportAllTypes: true,
        allReadonly,
    });
    // The lockfile pins Zod 3.19, before .readonly(); check readonly TypeScript separately.
    if (!allReadonly) {
        const declarations = Object.entries(context.schemas)
            .map(([name, expression]) => `const ${name} = ${expression};`)
            .join("\n");
        const schema: z.ZodTypeAny = new Function("z", transpileModule(declarations, {}).outputText + "\nreturn Node;")(
            z
        );
        const valid = { status: "ready", mixed: -1, parent: null, choice: null, children: [] };

        expect(schema.safeParse(valid).success).toBe(true);
        expect(schema.safeParse({ ...valid, settings: { label: undefined } }).success).toBe(true);
        expect(schema.safeParse({ ...valid, parent: valid, choice: "ready", children: [valid] }).success).toBe(true);
        expect(schema.safeParse({ ...valid, choice: 1 }).success).toBe(true);
        expect(schema.safeParse({ ...valid, parent: [valid] }).success).toBe(false);
        expect(schema.safeParse({ ...valid, choice: ["ready"] }).success).toBe(false);
        expect(schema.safeParse({ ...valid, children: valid }).success).toBe(false);
        expect(schema.safeParse({ ...valid, children: [[valid]] }).success).toBe(false);
    }

    const source = `import { z } from "zod";
${Object.values(context.types).join("\n")}
${(allReadonly ? [] : Object.entries(context.schemas))
    .map(
        ([name, expression]) =>
            `const ${name}${context.emittedType[name] ? `: z.ZodType<${name}>` : ""} = ${expression};`
    )
    .join("\n")}
const valid: Node = { status: "ready", mixed: -1, parent: null, choice: null, children: [] };
const nested: Node = { ...valid, parent: valid, choice: "ready", children: [valid] };
const numericChoice: Node = { ...valid, choice: 1 };
const omitted: Node = { ...valid, settings: {} };
const explicitUndefined: Node = { ...valid, settings: { label: undefined } };
// @ts-expect-error the optional property accepts only strings and undefined
const invalidSettings: Node = { ...valid, settings: { label: 3 } };
const statuses: Status[] = ["ready", 'quoted "label"', null];
const mixed: Mixed[] = ["ready", -1, 0, true, false, null];
// @ts-expect-error anyOf does not introduce array alternatives
const invalidParent: Node = { ...valid, parent: [valid] };
// @ts-expect-error nullable anyOf does not introduce array alternatives
const invalidChoice: Node = { ...valid, choice: ["ready"] };
// @ts-expect-error the array branch accepts arrays of nodes, not a single node
const invalidChildren: Node = { ...valid, children: valid };
// @ts-expect-error anyOf does not add another array dimension
const nestedArrays: Node = { ...valid, children: [[valid]] };
// @ts-expect-error numeric enum members are not strings
const invalidMixed: Node = { ...valid, mixed: "-1" };
${
    allReadonly
        ? "// @ts-expect-error allReadonly preserves readonly array branches\nnested.children?.push(valid);"
        : "nested.children?.push(valid);"
}
`;
    expect(typeErrors(source)).toEqual([]);
});
