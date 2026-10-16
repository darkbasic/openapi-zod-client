import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";

import SwaggerParser from "@apidevtools/swagger-parser";
import { ModuleKind, transpileModule } from "typescript";
import { expect, test } from "vitest";
import { z } from "zod";

const runFile = promisify(execFile);
const libraryDirectory = resolve(__dirname, "..");

async function generateThingSchema(input: string, outputPath: string): Promise<z.ZodTypeAny> {
    await runFile(
        process.execPath,
        [
            join(libraryDirectory, "bin.js"),
            input,
            "--output",
            outputPath,
            "--template",
            join(libraryDirectory, "src/templates/schemas-only.hbs"),
            "--export-schemas",
        ],
        { cwd: libraryDirectory }
    );

    const source = await readFile(outputPath, "utf8");
    const generated: { schemas?: Record<string, z.ZodTypeAny> } = {};
    runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText, {
        exports: generated,
        require: (name: string) => {
            if (name !== "zod") throw new Error(`Unexpected generated import: ${name}`);
            return { z };
        },
    });

    expect(generated.schemas).toHaveProperty("Thing");
    return generated.schemas!.Thing!;
}

test.each(["3.1.0", "3.1.1", "3.1.2"])(
    "generates working schemas from an unchanged OpenAPI %s document through the CLI",
    async (version) => {
        const directory = await mkdtemp(join(tmpdir(), "openapi-zod-client-3.1-"));
        try {
            const inputPath = join(directory, "openapi.json");
            const outputPath = join(directory, "schemas.ts");
            const input = JSON.stringify({
                openapi: version,
                info: { title: "OpenAPI patch version regression", version: "1" },
                paths: {
                    "/things": {
                        get: {
                            operationId: "getThings",
                            responses: {
                                "200": {
                                    description: "A thing",
                                    content: {
                                        "application/json": { schema: { $ref: "#/components/schemas/Thing" } },
                                    },
                                },
                            },
                        },
                    },
                },
                components: {
                    schemas: {
                        Label: { $ref: "./definitions.json#/Label" },
                        Thing: {
                            type: "object",
                            required: ["label"],
                            properties: { label: { $ref: "#/components/schemas/Label" } },
                        },
                    },
                },
            });
            await writeFile(inputPath, input);
            await writeFile(
                join(directory, "definitions.json"),
                JSON.stringify({ Label: { type: ["string", "null"] } })
            );

            // The parser must accept the declared version without relabeling the document.
            expect(await SwaggerParser.bundle(inputPath)).toHaveProperty("openapi", version);
            const schema = await generateThingSchema(inputPath, outputPath);
            expect(schema.safeParse({ label: "ready" }).success).toBe(true);
            expect(schema.safeParse({ label: null }).success).toBe(true);
            expect(schema.safeParse({ label: 42 }).success).toBe(false);
            expect(schema.safeParse({}).success).toBe(false);
            expect(await readFile(inputPath, "utf8")).toBe(input);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
    30_000
);

test.each(["3.0.3", "3.1.2"])(
    "generates schemas from OpenAPI %s over local HTTP with external references",
    async (version) => {
        const directory = await mkdtemp(join(tmpdir(), "openapi-zod-client-http-"));
        const requestedPaths: string[] = [];
        const documents: Record<string, unknown> = {
            "/openapi.json": {
                openapi: version,
                info: { title: "Local HTTP regression", version: "1" },
                paths: {},
                components: {
                    schemas: {
                        Thing: {
                            type: "object",
                            required: ["label"],
                            properties: { label: { $ref: "./definitions.json#/Label" } },
                        },
                    },
                },
            },
            "/definitions.json": { Label: { type: "string", enum: ["ready", "waiting"] } },
        };
        const server = createServer((request, response) => {
            const path = request.url ?? "";
            requestedPaths.push(path);
            response.setHeader("Content-Type", "application/json");
            response.statusCode = documents[path] ? 200 : 404;
            response.end(JSON.stringify(documents[path] ?? { error: "Not found" }));
        });

        try {
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Expected an HTTP server address");

            const schema = await generateThingSchema(
                `http://127.0.0.1:${address.port}/openapi.json`,
                join(directory, "schemas.ts")
            );

            expect(requestedPaths).toContain("/openapi.json");
            expect(requestedPaths).toContain("/definitions.json");
            expect(schema.safeParse({ label: "ready" }).success).toBe(true);
            expect(schema.safeParse({ label: "waiting" }).success).toBe(true);
            expect(schema.safeParse({ label: "other" }).success).toBe(false);
            expect(schema.safeParse({ label: 42 }).success).toBe(false);
            expect(schema.safeParse({}).success).toBe(false);
        } finally {
            if (server.listening) {
                await new Promise<void>((resolve, reject) => {
                    server.close((error) => (error ? reject(error) : resolve()));
                });
            }
            await rm(directory, { recursive: true, force: true });
        }
    },
    30_000
);
