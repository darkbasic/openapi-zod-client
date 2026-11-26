import type { ReferenceObject, SchemaObject } from "openapi3-ts";

import { isReferenceObject } from "./isReferenceObject";
import { hasOnlyScalarOutputs } from "./schemaAssertions";

type IntersectionMode = "native" | "shallow-readonly" | "preserve-readonly";

const closedObjectKeys = new Set(["type", "properties", "required", "additionalProperties", "description", "title"]);

// A native merge of disjoint, closed object parsers creates only the outer object.
// Each child is already the exact value returned by the single parser declaring it.
export function intersectionMode(
    operands: Array<SchemaObject | ReferenceObject> | undefined,
    readonly: boolean
): IntersectionMode {
    if (!readonly) return "native";
    if (!operands) return "preserve-readonly";
    if (operands.every((op) => !isReferenceObject(op) && hasOnlyScalarOutputs(op))) return "native";
    const keys = new Set<string>();
    for (const op of operands) {
        if (
            isReferenceObject(op) ||
            op.type !== "object" ||
            op.additionalProperties !== false ||
            !op.properties ||
            !Object.keys(op).every((key) => closedObjectKeys.has(key))
        )
            return "preserve-readonly";
        for (const key of Object.keys(op.properties)) {
            if (keys.has(key)) return "preserve-readonly";
            keys.add(key);
        }
    }

    return "shallow-readonly";
}

// Native intersections allocate new containers. Restore a container's readonly state
// from the parsers that produced it. Reused values already have the correct state.
export const restoreMergedReadonly = `const intrinsicObject = ({}).constructor as globalThis.ObjectConstructor;
    const object = (value: unknown): value is { [key: string]: unknown } => value !== null && typeof value === "object";
    const restore = (value: unknown, raw: unknown, sources: unknown[], descend = true): void => {
        if (!object(value) || value === raw || sources.includes(value)) return;
        const parsed = sources.filter(source => source !== raw).filter(object);
        if (!parsed.length) return;
        if (parsed.every(source => intrinsicObject.isFrozen(source))) intrinsicObject.freeze(value);
        if (descend) for (const key of z.util.objectKeys(value))
            restore(value[key], object(raw) ? raw[key] : undefined, parsed.map(source => source[key]));
    };`;

// Keep the sources of every readonly merge until its new containers are restored.
// An enclosing intersection cannot recover this information from a native merge.
export function intersectionCode(producers: string[], mode: IntersectionMode, guards: string[] = []): string {
    const intersect = (codes: string[]) => codes.reduce((left, right) => `${left}.and(${right})`);
    const checks = guards.map((ref) => `${ref}.transform(() => ({}))`);
    let merged = intersect(producers);
    if (mode === "shallow-readonly") merged += ".readonly()";
    if (mode === "preserve-readonly" && producers.length > 1) {
        const names = producers.map((_, i) => `source${i}`);
        const observed = names.map((name, i) => `${name}.superRefine(value => { parsed[${i}] = value; })`);
        // Observe native parse results without transforming them. A union needs the
        // original dirty status to report a matching branch's field validation error.
        // Zod evaluates the lazy getter once per parse, including concurrent async parses.
        merged = `((${names.join(", ")}) => z.lazy(() => {
            const parsed: unknown[] = [];
            let raw: unknown;
            const intersection = ${intersect(observed)};
            return z.custom<z.input<typeof intersection>>().superRefine(value => { raw = value; })
                .pipe(intersection.superRefine(data => {
                    ${restoreMergedReadonly}
                    restore(data, raw, parsed);
                }));
        }))(${producers.join(", ")})`;
    }

    if (checks.length === 0) return merged;
    // Empty guard outputs preserve the current parse context without restoring stripped fields.
    return intersect([...checks, `${merged}.transform(data => ({ data }))`]) + ".transform(parts => parts.data)";
}
