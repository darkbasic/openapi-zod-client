import type { SchemaObject } from "openapi3-ts";
import { z } from "zod";

import { escapeControlCharacters } from "./utils";

type StringRule = ["regex", RegExp] | ["min" | "max", number];
type NumericBound = ["gt" | "gte" | "lt" | "lte", number];

function schemaPattern(pattern: string) {
    // Preserve the legacy /^...$/ spelling. Other slashes are part of the pattern.
    if (pattern.startsWith("/^") && pattern.endsWith("$/")) pattern = pattern.slice(1, -1);
    try {
        return new RegExp(pattern, "u");
    } catch {
        // OpenAPI 3.0 also permits earlier ECMAScript syntax, including identity escapes.
        return new RegExp(pattern);
    }
}

const hostnameLabel = /[\da-z](?:[\da-z-]{0,61}[\da-z])?/.source;
const hostnamePattern = new RegExp(`^(?:${hostnameLabel}\\.)*${hostnameLabel}$`, "i");

function stringRules(schema: SchemaObject): StringRule[] {
    // Binary strings are Files. Text constraints operate on JSON strings.
    if (schema.format === "binary") return [];
    const rules: StringRule[] = [];

    // Measure Unicode code points without losing the concrete ZodString in generated clients.
    if (schema.minLength !== undefined) {
        const min = Math.min(schema.minLength, Number.MAX_SAFE_INTEGER);
        rules.push(min <= 1 ? ["min", min] : ["regex", new RegExp(`^[\\s\\S]{${min}}`, "u")]);
    }

    if (schema.maxLength !== undefined && schema.maxLength < Number.MAX_SAFE_INTEGER) {
        rules.push(
            schema.maxLength === 0 ? ["max", 0] : ["regex", new RegExp(`^[\\s\\S]{0,${schema.maxLength}}$`, "u")]
        );
    }

    if (schema.pattern) rules.push(["regex", schemaPattern(schema.pattern)]);
    if (schema.format === "hostname") rules.push(["max", 253], ["regex", hostnamePattern]);
    return rules;
}

export function getZodChainableStringValidations(schema: SchemaObject) {
    return stringRules(schema)
        .map(([method, arg]) =>
            method === "regex" ? `regex(/${escapeControlCharacters(arg.source)}/${arg.flags})` : `${method}(${arg})`
        )
        .join(".");
}

export function numberBounds(schema: SchemaObject): NumericBound[] {
    const bounds: NumericBound[] = [];
    if (schema.minimum !== undefined) bounds.push([schema.exclusiveMinimum === true ? "gt" : "gte", schema.minimum]);
    if (typeof schema.exclusiveMinimum === "number") bounds.push(["gt", schema.exclusiveMinimum]);
    if (schema.maximum !== undefined) bounds.push([schema.exclusiveMaximum === true ? "lt" : "lte", schema.maximum]);
    if (typeof schema.exclusiveMaximum === "number") bounds.push(["lt", schema.exclusiveMaximum]);
    return bounds;
}

// Use the same rules and Zod methods as the emitted parser when deciding whether a
// scalar default satisfies its bounds. Other kinds of JSON values ignore these keywords.
export function acceptsScalarBounds(schema: SchemaObject, candidate: unknown): boolean {
    if (typeof candidate === "string") {
        let rule = z.string();
        for (const [method, arg] of stringRules(schema)) {
            rule = method === "regex" ? rule.regex(arg) : rule[method](arg);
        }

        return rule.safeParse(candidate).success;
    }

    if (typeof candidate === "number") {
        let rule = z.number();
        for (const [method, limit] of numberBounds(schema)) rule = rule[method](limit);
        return rule.safeParse(candidate).success;
    }

    return true;
}
