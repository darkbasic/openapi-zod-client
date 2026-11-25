import { expect, test } from "vitest";
import { z } from "zod";
import { getZodSchema } from "../src/openApiToZod";

test.each([
    { pattern: "^/$", match: "/", miss: "\\/" },
    { pattern: "^\\/$", match: "/", miss: "\\/" },
    { pattern: "^\\\\/$", match: "\\/", miss: "/" },
    { pattern: "^\\\\\\/$", match: "\\/", miss: "/" },
    { pattern: "^[/]$", match: "/", miss: "\\" },
    { pattern: "/", match: "a/b", miss: "ab" },
    { pattern: "/^\\/$/", match: "/", miss: "//" },
    { pattern: "/\\\\/", match: "/\\/", miss: "\\" },
    { pattern: "/+teams/", match: "//teams/", miss: "teams" },
    { pattern: "/?code/", match: "code/", miss: "code" },
    { pattern: "/{2}teams/", match: "//teams/", miss: "/teams/" },
    { pattern: "/team/", match: "/team/", miss: "team" },
    { pattern: "/a\\/", match: "/a/", miss: "a/" },
    { pattern: "/abc/i", match: "/abc/i", miss: "ABC" },
    { pattern: "^.$", match: "😀", miss: "xy" },
    { pattern: "^\\P{Letter}$", match: "😀", miss: "β" },
    { pattern: "^\\-$", match: "-", miss: "x" }, // Legacy identity escape.
    { pattern: "^\u2028\u2029\n\r\t\x00$", match: "\u2028\u2029\n\r\t\x00", miss: "" },
    { pattern: "^\\\x01$", match: "\x01", miss: "\\\x01" },
    { pattern: "^\ud800$", match: "\ud800", miss: "�" },
])("round-trips pattern $pattern through UTF-8 JavaScript source", ({ pattern, match, miss }) => {
    const expression = getZodSchema({ schema: { type: "string", pattern } }).toString();
    const source = Buffer.from(expression).toString("utf8");
    const validator: z.ZodString = new Function("z", "return " + source)(z);
    expect(validator.safeParse(match).success).toBe(true);
    expect(validator.safeParse(miss).success).toBe(false);
});

test("rejects invalid ECMAScript patterns during generation", () => {
    expect(() => getZodSchema({ schema: { type: "string", pattern: "[" } })).toThrow(SyntaxError);
});
