import type { OpenAPIObject } from "openapi3-ts";
import { transpileModule } from "typescript";
import { expect, test } from "vitest";
import { z } from "zod";
import { generateZodClientFromOpenAPI } from "../src";
import { getZodClientTemplateContext } from "../src/template-context";

// https://github.com/astahmer/openapi-zod-client/issues/49
test("allOf-infer-required-only-item", async () => {
    const openApiDoc: OpenAPIObject = {
        openapi: "3.0.3",
        info: {
            title: "User",
            version: "1.0.0",
        },
        paths: {
            "/user": {
                get: {
                    responses: {
                        "200": {
                            description: "return user",
                            content: {
                                "application/json": {
                                    schema: {
                                        $ref: "#/components/schemas/userResponse",
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
        components: {
            schemas: {
                user: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string",
                        },
                        email: {
                            type: "string",
                        },
                    },
                },
                userResponse: {
                    type: "object",
                    properties: {
                        user: {
                            allOf: [
                                {
                                    $ref: "#/components/schemas/user",
                                },
                                {
                                    required: ["name"],
                                },
                            ],
                        },
                    },
                },
            },
        },
    };

    const output = await generateZodClientFromOpenAPI({
        disableWriteToFile: true,
        openApiDoc,
        options: {
            shouldExportAllTypes: true,
            shouldExportAllSchemas: true,
            withImplicitRequiredProps: true,
        },
    });
    expect(output).toMatchInlineSnapshot(`
      "import { makeApi, Zodios, type ZodiosOptions } from "@zodios/core";
      import { z } from "zod";

      type userResponse = {
        user?:
          | (user & {
              name: {} | null;
            })
          | undefined;
      };
      type user = {
        name?: string | undefined;
        email?: string | undefined;
      };

      const user: z.ZodType<user> = z
        .object({ name: z.string(), email: z.string() })
        .passthrough();
      const userResponse: z.ZodType<userResponse> = z
        .object({
          user: user.and(
            z
              .object({
                name: z.custom<globalThis.NonNullable<unknown> | null>(
                  (value) => value !== undefined
                ),
              })
              .passthrough()
          ),
        })
        .passthrough();

      export const schemas = {
        user,
        userResponse,
      };

      const endpoints = makeApi([
        {
          method: "get",
          path: "/user",
          requestFormat: "json",
          response: userResponse,
        },
      ]);

      export const api = new Zodios(endpoints);

      export function createApiClient(baseUrl: string, options?: ZodiosOptions) {
        return new Zodios(baseUrl, endpoints, options);
      }
      "
    `);
});

test("an object overlay requires relations only on the composed response", () => {
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
    const document: OpenAPIObject = {
        openapi: "3.1.0",
        info: { title: "Member relations", version: "1" },
        paths: {},
        components: {
            schemas: {
                Member: { type: "object", properties: { organization: { type: ["string", "null"] } } },
                Roles: {
                    type: "object",
                    properties: { roles: { type: "array", items: { type: "string" }, default: [] } },
                },
                Detail: {
                    allOf: [
                        ref("Member"),
                        ref("Roles"),
                        { type: "object", description: "Loaded relations", required: ["roles", "organization"] },
                    ],
                },
                Closed: { type: "object", required: ["missing"], additionalProperties: false },
                Dictionary: {
                    type: "object",
                    required: ["name"],
                    additionalProperties: { type: "string", default: "default name" },
                },
                Presence: {
                    allOf: [
                        { type: "object", required: ["first"] },
                        { type: "object", required: ["second"] },
                    ],
                },
            },
        },
    };
    const { schemas } = getZodClientTemplateContext(document, { shouldExportAllSchemas: true });
    const declarations = Object.entries(schemas)
        .map(([name, expression]) => `const ${name} = ${expression};`)
        .join("\n");
    const {
        Member,
        Detail,
        Presence,
        Closed,
        Dictionary,
    }: Record<"Member" | "Detail" | "Presence" | "Closed" | "Dictionary", z.ZodTypeAny> = new Function(
        "z",
        `${transpileModule(declarations, {}).outputText}\nreturn { Member, Detail, Presence, Closed, Dictionary };`
    )(z);

    expect(Member.safeParse({}).success).toBe(true);
    expect(Detail.safeParse({ roles: [], organization: null }).success).toBe(true);
    expect(Detail.safeParse({ organization: null }).success).toBe(false);
    expect(Detail.safeParse({ roles: [] }).success).toBe(false);
    expect(Detail.safeParse({ roles: [42], organization: null }).success).toBe(false);
    expect(Closed.safeParse({ missing: 1 }).success).toBe(false);
    expect(Dictionary.safeParse({}).success).toBe(false);
    expect(Dictionary.safeParse({ name: 42 }).success).toBe(false);
    expect(Dictionary.safeParse({ name: "Member" }).success).toBe(true);
    expect(Presence.safeParse({ first: false, second: null }).success).toBe(true);
    expect(Presence.safeParse({ first: false }).success).toBe(false);
});
