import { createRequire } from "node:module";
import type { OpenAPIObject, SchemaObject } from "openapi3-ts";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, test } from "vitest";
import type { z } from "zod";
import { generateZodClientFromOpenAPI } from "../src";
import { typeErrors } from "./typeErrors";

const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
const mapOf = (schema: SchemaObject): SchemaObject => ({ type: "object", additionalProperties: schema });

test.each([false, true])(
    "compiles and validates string assertions (readonly and explicit types: %s)",
    async (explicit) => {
        const host: SchemaObject = { type: "string", format: "hostname" };
        const path: SchemaObject = { type: "string", pattern: "^api\\/\\p{Letter}+$" };
        const size: SchemaObject = { type: "string", minLength: 2, maxLength: 2, default: "🎉🎉" };
        const email: SchemaObject = { type: "string", format: "email" };
        const time: SchemaObject = { type: "string", format: "date-time" };
        const document: OpenAPIObject = {
            openapi: "3.1.0",
            info: { title: "String contracts", version: "1" },
            paths: {},
            components: {
                schemas: {
                    Host: host,
                    AliasHost: ref("Host"),
                    HostList: { type: "array", items: ref("AliasHost") },
                    DirectHosts: mapOf(host),
                    NamedHosts: mapOf(ref("AliasHost")),
                    ApiPath: path,
                    Paths: mapOf(ref("ApiPath")),
                    Size: size,
                    SizedLabels: mapOf(ref("Size")),
                    Literal: { type: ["string", "null"], enum: ["x", "xy", "zz", null], minLength: 2, pattern: "^x" },
                    Email: email,
                    Time: time,
                    Emails: mapOf(ref("Email")),
                    Times: mapOf(ref("Time")),
                    Tagged: {
                        oneOf: [
                            {
                                type: "object",
                                required: ["kind"],
                                properties: { kind: { type: "string", enum: ["first", "excluded"], pattern: "^f" } },
                            },
                            {
                                type: "object",
                                required: ["kind"],
                                properties: { kind: { type: "string", enum: ["next"] } },
                            },
                        ],
                        discriminator: { propertyName: "kind" },
                    },
                    Inline: {
                        type: "object",
                        properties: { host, size, email, time, uri: { type: "string", format: "uri" }, path },
                        required: ["host", "size", "email", "time", "uri", "path"],
                    },
                },
            },
        };
        const source = await generateZodClientFromOpenAPI({
            openApiDoc: document,
            disableWriteToFile: true,
            options: { shouldExportAllSchemas: true, shouldExportAllTypes: explicit, allReadonly: explicit },
        });
        expect(typeErrors(source + "\nschemas.Size.min(1).max(4);")).toEqual([]);
        const { outputText } = transpileModule(source, {
            compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 },
        });
        const schemas: Record<string, z.ZodTypeAny> = new Function(
            "require",
            "exports",
            outputText + "\nreturn exports.schemas;"
        )(createRequire(import.meta.url), {});

        const longest = ["a".repeat(63), "a".repeat(63), "a".repeat(63), "a".repeat(61)].join(".");
        for (const name of ["localhost", "1Api.eu-west.example", "xn--bcher-kva.example", longest]) {
            expect(schemas.Host!.parse(name)).toBe(name);
            expect(schemas.HostList!.parse([name])).toEqual([name]);
            for (const map of [schemas.DirectHosts!, schemas.NamedHosts!]) {
                expect(map.parse({ primary: name })).toEqual({ primary: name });
            }
        }
        for (const name of [
            "",
            ".",
            "https://example.com",
            "example.com:443",
            "a..b",
            "-a.b",
            "a.b-",
            "a_b",
            "a.b\n",
            "example.",
            "bücher.example",
            "a".repeat(64) + ".local",
            longest + "a",
        ]) {
            for (const map of [schemas.DirectHosts!, schemas.NamedHosts!]) {
                expect(map.safeParse({ primary: name }).success).toBe(false);
            }
            expect(schemas.HostList!.safeParse([name]).success).toBe(false);
        }

        expect(schemas.Paths!.parse({ node: "api/α" })).toEqual({ node: "api/α" });
        expect(schemas.Paths!.safeParse({ node: "api\\α" }).success).toBe(false);
        expect(schemas.SizedLabels!.parse({ first: undefined, second: "x\n" })).toEqual({
            first: "🎉🎉",
            second: "x\n",
        });
        for (const label of ["🎉", "x🎉z"]) expect(schemas.SizedLabels!.safeParse({ label }).success).toBe(false);
        for (const label of ["xy", null]) expect(schemas.Literal!.parse(label)).toBe(label);
        for (const label of ["x", "zz", "xx"]) expect(schemas.Literal!.safeParse(label).success).toBe(false);
        for (const kind of ["first", "next"]) expect(schemas.Tagged!.parse({ kind })).toEqual({ kind });
        expect(schemas.Tagged!.safeParse({ kind: "excluded" }).success).toBe(false);

        // Existing inline Zod format checks stay available. Reference expansion doesn't turn these
        // annotations into stricter assertions, e.g. for RFC 5321 mailboxes or RFC 3339 leap seconds.
        expect(schemas.Emails!.parse({ mail: "!ok@example.com" })).toEqual({ mail: "!ok@example.com" });
        const leap = "2016-12-31t23:59:60z";
        expect(schemas.Times!.parse({ timestamp: leap })).toEqual({ timestamp: leap });
        const valid = {
            host: "api.example",
            size: "🎉🎉",
            email: "x@example.com",
            time: "2024-12-31T23:59:59Z",
            uri: "urn:isbn:1234",
            path: "api/α",
        };
        expect(schemas.Inline!.parse(valid)).toEqual(valid);
        for (const field of [
            { email: "bad" },
            { time: "bad" },
            { uri: "bad" },
            { host: valid.uri },
            { path: "api_α" },
        ]) {
            expect(schemas.Inline!.safeParse({ ...valid, ...field }).success).toBe(false);
        }
    }
);
