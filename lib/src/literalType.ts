import { type ts, t } from "tanu";

export function literalType(value: unknown): ts.TypeNode {
    if (Array.isArray(value)) return t.tuple(value.map(literalType));

    if (value && typeof value === "object") {
        return t.type(
            "",
            Object.fromEntries(Object.entries(value).map(([key, item]) => [JSON.stringify(key), literalType(item)]))
        ).type;
    }

    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return t.union([value]);
    return t.reference("null");
}
