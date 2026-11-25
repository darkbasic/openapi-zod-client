import type { SchemaObject } from "openapi3-ts";
import { capitalize, kebabToCamel, snakeToCamel } from "pastable/server";
import { match, P } from "ts-pattern";

export const asComponentSchema = (name: string) => `#/components/schemas/${name}`;

export function normalizeString(text: string) {
    const prefixed = prefixStringStartingWithNumberIfNeeded(text);
    return prefixed
        .normalize("NFKD") // The normalize() using NFKD method returns the Unicode Normalization Form of a given string.
        .trim() // Remove whitespace from both sides of a string (optional)
        .replace(/\s+/g, "_") // Replace spaces with _
        .replace(/-+/g, "_") // Replace - with _
        .replace(/[^\w\-]+/g, "_") // Remove all non-word chars
        .replace(/--+/g, "-"); // Replace multiple - with single -
}

export const wrapWithQuotesIfNeeded = (str: string) => {
    if (/^[A-Za-z]\w*$/.test(str)) {
        return str;
    }

    return JSON.stringify(str);
};

const prefixStringStartingWithNumberIfNeeded = (str: string) => {
    const firstAsNumber = Number(str[0]);
    if (typeof firstAsNumber === "number" && !Number.isNaN(firstAsNumber)) {
        return "_" + str;
    }

    return str;
};

const pathParamWithBracketsRegex = /({\w+})/g;
const wordPrecededByNonWordCharacter = /[^\w\-]+/g;

export const pathParamToVariableName = (name: string) => {
    // Replace all underscores with # to preserve them when doing snakeToCamel
    const preserveUnderscore = name.replaceAll("_", "#");
    return snakeToCamel(preserveUnderscore.replaceAll("-", "_")).replaceAll("#", "_");
};

const matcherRegex = /{(\b\w+(?:-\w+)*\b)}/g;
export const replaceHyphenatedPath = (path: string) => {
    const matches = path.match(matcherRegex);
    if (matches === null) {
        return path.replaceAll(matcherRegex, ":$1");
    }

    matches.forEach((match) => {
        const replacement = pathParamToVariableName(match.replaceAll(matcherRegex, ":$1"));
        path = path.replaceAll(match, replacement);
    });
    return path;
};

/** @example turns `/media-objects/{id}` into `MediaObjectsId` */
export const pathToVariableName = (path: string) =>
    capitalize(kebabToCamel(path).replaceAll("/", "")) // /media-objects/{id} -> MediaObjects{id}
        .replace(pathParamWithBracketsRegex, (group) => capitalize(group.slice(1, -1))) // {id} -> Id
        .replace(wordPrecededByNonWordCharacter, "_"); // "/robots.txt" -> "/robots_txt"

type SingleType = Exclude<SchemaObject["type"], any[] | undefined>;
export const isPrimitiveType = (type: SingleType): type is PrimitiveType => primitiveTypeList.includes(type as any);

const primitiveTypeList = ["string", "number", "integer", "boolean", "null"] as const;
export type PrimitiveType = typeof primitiveTypeList[number];

export const primitiveEnumValues = (values: NonNullable<SchemaObject["enum"]>, type: PrimitiveType) =>
    values.filter((value) =>
        type === "integer" ? Number.isInteger(value) : type === "null" ? value === null : typeof value === type
    );

export const escapeControlCharacters = (str: string): string => {
    // RegExp.source already quotes slashes and line terminators. Keep the remaining
    // non-printable characters and lone surrogates representable in a UTF-8 source file.
    return str.replace(/(\\*)([\s\S])/gu, (match, escapes: string, char: string) => {
        if (!/[\u0000-\u001F\u007F-\u009F\uD800-\uDFFF\uFFFE\uFFFF]/u.test(char)) return match;
        const code = char.codePointAt(0)!;
        const hex = code.toString(16);
        const escaped = char === "\t" ? "\\t" : code <= 0xff ? "\\x" + hex.padStart(2, "0") : "\\u" + hex;
        // A legacy identity escape already consumes the last backslash.
        return escapes.slice(0, escapes.length - (escapes.length % 2)) + escaped;
    });
};

export const toBoolean = (value: undefined | string | boolean, defaultValue: boolean) =>
    match(value)
        .with(P.string.regex(/^false$/i), false, () => false)
        .with(P.string.regex(/^true$/i), true, () => true)
        .otherwise(() => defaultValue);
