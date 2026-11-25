import { fileURLToPath } from "node:url";
import type { OpenAPIObject } from "openapi3-ts";
import { expect, test } from "vitest";
import { generateZodClientFromOpenAPI } from "../src/generateZodClientFromOpenAPI";
import { getZodClientTemplateContext } from "../src/template-context";
import { typeErrors } from "./typeErrors";

test.each([false, true])("dictionary types survive shadowed builtin names (readonly: %s)", async (allReadonly) => {
    const output = await generateZodClientFromOpenAPI({
        openApiDoc: {
            openapi: "3.1.0",
            info: { title: "Component names", version: "1" },
            paths: {},
            components: {
                schemas: {
                    NonNullable: { type: "string" },
                    globalThis: { type: "object", properties: { value: { $ref: "#/components/schemas/NonNullable" } } },
                    Readonly: { type: "string" },
                    Array: { type: "array", items: { $ref: "#/components/schemas/Readonly" } },
                    Lists: {
                        type: "object",
                        required: ["first"],
                        additionalProperties: { $ref: "#/components/schemas/Array", type: "array" },
                    },
                    Record: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
                    Records: {
                        type: "object",
                        required: ["first"],
                        additionalProperties: { $ref: "#/components/schemas/Record", type: "object" },
                    },
                    Overlay: {
                        type: "object",
                        required: ["key"],
                        properties: { other: { $ref: "#/components/schemas/globalThis" } },
                    },
                    Dictionary: {
                        type: "object",
                        required: ["key"],
                        additionalProperties: { $ref: "#/components/schemas/NonNullable" },
                    },
                },
            },
        },
        disableWriteToFile: true,
        options: { shouldExportAllSchemas: true, shouldExportAllTypes: true, allReadonly },
    });
    expect(
        typeErrors(`${output}
const valid: Overlay = { key: null };
const entry: Dictionary = { key: "value" };
const lists: Lists = { first: ["one"], other: ["two"] };
${allReadonly ? "// @ts-expect-error lists are readonly" : ""}
lists.first.push("three");
const records: Records = { first: { id: "one" }, other: { id: "two" } };
// @ts-expect-error the object constraint keeps the referenced component's fields
const invalidRecord: Records = { first: { id: 2 } };
// @ts-expect-error the overlay requires a defined value
const invalid: Overlay = { key: undefined };
// @ts-expect-error the dictionary requires its named key
const missing: Dictionary = {};`)
    ).toEqual([]);
});

test.each([
    { allReadonly: false, withDefaultValues: true },
    { allReadonly: true, withDefaultValues: true },
    { allReadonly: false, withDefaultValues: false },
])(
    "array item defaults affect only recursive dictionary input (readonly: $allReadonly, defaults: $withDefaultValues)",
    async ({ allReadonly, withDefaultValues }) => {
        const document: OpenAPIObject = {
            openapi: "3.1.0",
            info: { title: "Array item defaults", version: "1" },
            paths: {},
            components: {
                schemas: {
                    Array: {
                        type: "object",
                        required: ["id"],
                        properties: { id: { type: "string" } },
                        default: { id: "component" },
                    },
                    Tree: {
                        type: "object",
                        additionalProperties: {
                            type: "array",
                            items: {
                                type: "object",
                                default: {},
                                properties: {
                                    next: { $ref: "#/components/schemas/Tree" },
                                    rows: {
                                        type: "array",
                                        items: {
                                            type: "array",
                                            default: [],
                                            items: {
                                                $ref: "#/components/schemas/Array",
                                                nullable: true,
                                                default: null,
                                            },
                                        },
                                    },
                                    plain: { type: "array", items: { $ref: "#/components/schemas/Array" } },
                                },
                            },
                        },
                    },
                },
            },
        };
        const output = await generateZodClientFromOpenAPI({
            openApiDoc: document,
            disableWriteToFile: true,
            options: { shouldExportAllSchemas: true, allReadonly, withDefaultValues },
        });
        const requiresItem = withDefaultValues
            ? ""
            : "// @ts-expect-error an item needs a value when defaults are disabled";
        expect(
            typeErrors(`${output}
type Input = z.input<typeof Tree>;
type Output = z.output<typeof Tree>;
const valid: Output = { branch: [{ next: {}, rows: [[], [null, { id: "ok" }]] }] };
${requiresItem}
const inline: Input = { branch: [undefined, { next: { leaf: [undefined] } }] };
${requiresItem}
const nested: Input = { branch: [{ rows: [undefined] }] };
${requiresItem}
const ref: Input = { branch: [{ rows: [[undefined]] }] };
// @ts-expect-error a bare item reference does not apply the component's default
const plain: Input = { branch: [{ plain: [undefined] }] };
// @ts-expect-error a defaulted ref still validates supplied values
const wrong: Input = { branch: [{ rows: [[{ id: 42 }]] }] };
// @ts-expect-error parsed array items are defined
const missingItem: Output = { branch: [undefined] };
// @ts-expect-error parsed nested arrays are defined
const missingArray: Output = { branch: [{ rows: [undefined] }] };
// @ts-expect-error parsed referenced items are defined
const missingEntry: Output = { branch: [{ rows: [[undefined]] }] };
${allReadonly ? "// @ts-expect-error readonly arrays cannot be modified" : ""}
valid.branch.push({});`)
        ).toEqual([]);
    }
);

test.each([false, true])("recursive dictionaries retain nullable object values (readonly: %s)", async (allReadonly) => {
    const output = await generateZodClientFromOpenAPI({
        openApiDoc: {
            openapi: "3.0.3",
            info: { title: "Recursive dictionary", version: "1" },
            paths: {},
            components: {
                schemas: {
                    Tree: {
                        type: "object",
                        required: ["primary"],
                        additionalProperties: {
                            type: "object",
                            nullable: true,
                            properties: { child: { $ref: "#/components/schemas/Tree" } },
                        },
                    },
                    SingleBranch: {
                        type: "object",
                        required: ["root"],
                        additionalProperties: { nullable: true, allOf: [{ $ref: "#/components/schemas/Tree" }] },
                    },
                    TreesByName: {
                        type: "object",
                        additionalProperties: { $ref: "#/components/schemas/Tree" },
                    },
                    Envelope: {
                        type: "object",
                        required: ["metadata", "tree"],
                        properties: {
                            tree: { $ref: "#/components/schemas/Tree" },
                            metadata: { type: "object", required: ["main"], additionalProperties: {} },
                        },
                    },
                },
            },
        },
        options: { shouldExportAllSchemas: true, shouldExportAllTypes: true, allReadonly },
        disableWriteToFile: true,
    });
    const source = `${output}
const tree: Tree = { primary: null, other: { child: { primary: {} } } };
const leaf: Tree = { primary: {}, other: null };
const trees: TreesByName = { tree, leaf };
const single: SingleBranch = { root: null, other: tree };
const envelope: Envelope = { tree, metadata: { main: null, anything: false } };
// @ts-expect-error unconstrained values need narrowing
const unchecked: string = envelope.metadata.anything;
// @ts-expect-error an unconstrained schema still needs a defined required key
const absentKey: Envelope = { tree, metadata: { main: undefined } };
// @ts-expect-error required dictionary entry
const missing: Tree = {};
// @ts-expect-error nullable dictionary values still reject other primitives
const invalid: Tree = { primary: {}, other: false };
// @ts-expect-error typed dictionary values require a Tree
const wrongTree: TreesByName = { root: "tree" };
`;
    expect(typeErrors(source)).toEqual([]);
});

test.each([false, true])("defaulted extras accept undefined only on input (readonly: %s)", async (allReadonly) => {
    const document: OpenAPIObject = {
        openapi: "3.0.3",
        info: { title: "Recursive defaulted dictionary", version: "1" },
        paths: {},
        components: {
            schemas: {
                Tree: {
                    type: "object",
                    required: ["main"],
                    additionalProperties: {
                        type: "object",
                        default: { field: "hello" },
                        nullable: true,
                        required: ["field"],
                        properties: {
                            field: { type: "string", default: "hello" },
                            child: { $ref: "#/components/schemas/Tree" },
                        },
                    },
                },
                TreeInput: { type: "object", properties: { root: { $ref: "#/components/schemas/Tree" } } },
                Defaults: {
                    type: "object",
                    required: ["main"],
                    additionalProperties: { type: "string", default: "fallback" },
                },
            },
        },
    };
    const output = await generateZodClientFromOpenAPI({
        openApiDoc: document,
        options: { shouldExportAllSchemas: true, shouldExportAllTypes: true, allReadonly },
        disableWriteToFile: true,
    });
    expect(
        typeErrors(`${output}
const validInput: z.input<typeof Tree> = { main: { child: { main: null, other: undefined } }, other: undefined };
const defaultedField: string | undefined = Tree.parse({ main: {} }).main?.field;
// @ts-expect-error a required parsed field always has its default
const invalidField: Tree = { main: {} };
// @ts-expect-error defaulted keys accept explicit undefined only for extras
const invalidInput: z.input<typeof Tree> = { main: undefined };
// @ts-expect-error required keys must be supplied even when the value schema has a default
const missingInput: z.input<typeof Tree> = { other: {} };
// @ts-expect-error parsed extras have consumed their defaults
const invalidOutput: z.output<typeof Tree> = { main: { child: { main: null, other: undefined } } };
const treeInput: z.input<typeof TreeInput> = { root: validInput };
// @ts-expect-error a caller-chosen component name must keep its own output contract
const wrongTreeInput: TreeInput = { root: validInput };
const defaults: z.input<typeof Defaults> = { main: "given", other: undefined };
const defaulted: string = Defaults.parse(defaults).other;
// @ts-expect-error parsed extras must be strings
const invalidDefaults: z.output<typeof Defaults> = { main: "given", other: undefined };`)
    ).toEqual([]);
});

test("named properties and required extras retain their individual dictionary types", async () => {
    const output = await generateZodClientFromOpenAPI({
        openApiDoc: {
            openapi: "3.1.0",
            info: { title: "Mixed dictionary", version: "1" },
            paths: {},
            components: {
                schemas: {
                    Count: { type: "integer" },
                    Counts: {
                        type: "object",
                        required: ["name", "total"],
                        properties: { name: { type: "string" } },
                        additionalProperties: { $ref: "#/components/schemas/Count" },
                    },
                },
            },
        },
        options: { shouldExportAllSchemas: true, shouldExportAllTypes: true },
        disableWriteToFile: true,
    });
    expect(
        typeErrors(`${output}
const input: z.input<typeof Counts> = { name: "labels", total: 5, extra: 2 };
const output = Counts.parse(input);
const name: string = output.name;
const total: number = output.total;
// @ts-expect-error the declared named property must be a string
const invalidName: Counts = { name: 8, total: 5 };
// @ts-expect-error a required extra has the catchall value type
const invalidTotal: Counts = { name: "labels", total: "wrong" };
// @ts-expect-error all values must belong to the named or catchall value schemas
const invalidExtra: Counts = { name: "labels", total: 5, extra: true };
`)
    ).toEqual([]);
});

test.each([false, true])(
    "reference siblings and target defaults retain the dictionary's input and output (defaults: %s)",
    async (withDefaultValues) => {
        const document: OpenAPIObject = {
            openapi: "3.1.0",
            info: { title: "Referenced dictionary values", version: "1" },
            paths: {},
            components: {
                schemas: {
                    Code: { type: "string", nullable: true, default: "a" },
                    Codes: {
                        type: "object",
                        required: ["code"],
                        additionalProperties: { $ref: "#/components/schemas/Code" },
                    },
                    Allowed: {
                        type: "object",
                        required: ["code"],
                        additionalProperties: { $ref: "#/components/schemas/Code", type: "string", enum: ["a", "b"] },
                    },
                    Scalar: { type: ["string", "integer"] },
                    Labels: {
                        type: "object",
                        required: ["name"],
                        additionalProperties: { $ref: "#/components/schemas/Scalar", type: "string" },
                    },
                    Kinds: {
                        type: "object",
                        required: ["id"],
                        additionalProperties: { $ref: "#/components/schemas/Scalar", enum: [1, "valid"] },
                    },
                    FileData: { type: "string", format: "binary" },
                    Files: {
                        type: "object",
                        required: ["file"],
                        additionalProperties: { $ref: "#/components/schemas/FileData", type: "string" },
                    },
                },
            },
        };
        const output = await generateZodClientFromOpenAPI({
            openApiDoc: document,
            disableWriteToFile: true,
            options: { shouldExportAllSchemas: true, shouldExportAllTypes: true, withDefaultValues },
        });
        const context = getZodClientTemplateContext(document, {
            shouldExportAllSchemas: true,
            shouldExportAllTypes: true,
            withDefaultValues,
        });
        expect(Object.keys(context.inputType ?? {}).sort()).toEqual(withDefaultValues ? ["Allowed", "Codes"] : []);
        expect(
            typeErrors(`${output}
const codes: z.input<typeof Codes> = { code: null, other: null };
const allowed: z.input<typeof Allowed> = { code: "a", other: "b" };
${withDefaultValues ? "" : "// @ts-expect-error disabled defaults reject undefined extras"}
const extras: z.input<typeof Codes> = { code: "a", other: undefined };
// @ts-expect-error required keys always precede defaults
const missing: z.input<typeof Codes> = {};
// @ts-expect-error parsed extras have consumed defaults
const badOutput: Codes = { code: "a", other: undefined };
// @ts-expect-error enum siblings constrain the complete dictionary
const badEnum: Allowed = { code: "a", other: "invalid" };
const label: string = Labels.parse({name:"test"}).name;
// @ts-expect-error an explicit type sibling narrows the referenced union
const badLabel: Labels = { name: "test", extra: 1 };
const kind: 1 | "valid" = Kinds.parse({id:1}).id;
// @ts-expect-error a standalone primitive enum sibling narrows the referenced value
const badKind: Kinds = { id: "test" };
const files: Files = { file: new File([], "upload") };
// @ts-expect-error binary entries are Files
const wrongFile: Files = { file: "upload" };
`)
        ).toEqual([]);
    }
);

test.each([false, true])(
    "annotated recursive object branches keep their defaulted input (defaults: %s)",
    async (withDefaultValues) => {
        const document: OpenAPIObject = {
            openapi: "3.1.0",
            info: { title: "Tagged recursive branch", version: "1" },
            paths: {},
            components: {
                schemas: {
                    Ready: {
                        type: "object",
                        required: ["kind", "next"],
                        properties: {
                            kind: { type: "string", enum: ["ready"], default: "ready" },
                            next: { anyOf: [{ $ref: "#/components/schemas/Ready" }, { type: "null" }], default: null },
                        },
                    },
                    Result: {
                        discriminator: { propertyName: "kind" },
                        oneOf: [
                            { $ref: "#/components/schemas/Ready" },
                            {
                                type: "object",
                                required: ["kind"],
                                properties: { kind: { type: "string", enum: ["done"] } },
                            },
                        ],
                    },
                },
            },
        };
        const output = await generateZodClientFromOpenAPI({
            openApiDoc: document,
            disableWriteToFile: true,
            options: { shouldExportAllSchemas: true, shouldExportAllTypes: true, withDefaultValues },
        });
        expect(
            typeErrors(`${output}
const ready: z.input<typeof Ready> = { kind: "ready", next: null };
${withDefaultValues ? "" : "// @ts-expect-error disabled defaults require named input properties"}
const nested: z.input<typeof Ready> = { next: {} };
const result: Result = { kind: "ready", next: null };
// @ts-expect-error both parsed fields are present after defaults
const incomplete: Ready = {};
`)
        ).toEqual([]);
    }
);

test("schemas-only and grouped common files annotate recursive input defaults", async () => {
    const response = { content: { "application/json": { schema: { $ref: "#/components/schemas/Tree" } } } };
    const document: OpenAPIObject = {
        openapi: "3.0.3",
        info: { title: "Shared tree", version: "1" },
        paths: {
            "/one": { get: { tags: ["one"], responses: { "200": response } } },
            "/two": { get: { tags: ["two"], responses: { "200": response } } },
        },
        components: {
            schemas: {
                Tree: {
                    type: "object",
                    required: ["label"],
                    properties: {
                        label: { type: "string", default: "leaf" },
                        child: { $ref: "#/components/schemas/Tree" },
                    },
                },
            },
        },
    };
    const single = await generateZodClientFromOpenAPI({
        openApiDoc: document,
        disableWriteToFile: true,
        templatePath: fileURLToPath(new URL("../src/templates/schemas-only.hbs", import.meta.url)),
    });
    const grouped = await generateZodClientFromOpenAPI({
        openApiDoc: document,
        disableWriteToFile: true,
        options: { groupStrategy: "tag-file" },
    });
    for (const output of [single, grouped.__common]) {
        expect(
            typeErrors(`${output}
const nested: z.input<typeof Tree> = { child: {} };
const label: string = Tree.parse(nested).label;
`)
        ).toEqual([]);
    }
});

test("exporting only types for unused components does not require their schema values", async () => {
    const output = await generateZodClientFromOpenAPI({
        openApiDoc: {
            openapi: "3.0.3",
            info: { title: "Unused types", version: "1" },
            paths: {},
            components: {
                schemas: {
                    Thing: {
                        type: "object",
                        required: ["n"],
                        properties: {
                            n: { type: "number", default: 0 },
                            file: { $ref: "#/components/schemas/File" },
                            upload: { $ref: "#/components/schemas/Upload" },
                        },
                    },
                    Rows: { type: "array", items: { $ref: "#/components/schemas/Thing" } },
                    File: { type: "object", required: ["label"], properties: { label: { type: "string" } } },
                    Upload: {
                        type: "object",
                        required: ["file"],
                        properties: { file: { type: "string", format: "binary" } },
                    },
                },
            },
        },
        disableWriteToFile: true,
        options: { shouldExportAllTypes: true },
    });
    expect(
        typeErrors(`${output}
const rows: Rows = [{ n: 0 }];
const fileComponent: File = { label: "component" };
const upload: Upload = { file: new globalThis.File([], "upload") };
// @ts-expect-error binary uploads use the platform File type
const wrongUpload: Upload = { file: { label: "upload" } };
// @ts-expect-error only parsed output is required for an unused component
const missing: Thing = {};`)
    ).toEqual([]);
});

test("a recursive dictionary inherits nullable defaults through a chain of component aliases", async () => {
    const output = await generateZodClientFromOpenAPI({
        openApiDoc: {
            openapi: "3.0.3",
            info: { title: "Reference chain", version: "1" },
            paths: {},
            components: {
                schemas: {
                    Code: { type: "string", nullable: true, default: "code" },
                    Alias: { $ref: "#/components/schemas/Code" },
                    Node: {
                        type: "object",
                        required: ["codes"],
                        properties: {
                            next: { $ref: "#/components/schemas/Node" },
                            codes: {
                                type: "object",
                                required: ["primary"],
                                additionalProperties: { $ref: "#/components/schemas/Alias" },
                            },
                        },
                    },
                },
            },
        },
        disableWriteToFile: true,
        options: { shouldExportAllSchemas: true },
    });
    expect(
        typeErrors(`${output}
const input: z.input<typeof Node> = { codes: { primary: null, extra: undefined } };
const parsed: string | null = Node.parse(input).codes.extra;
// @ts-expect-error defaults only consume explicit undefined on non-required entries
const missing: z.input<typeof Node> = { codes: { primary: undefined } };`)
    ).toEqual([]);
});
