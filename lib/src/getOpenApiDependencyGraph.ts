import type { SchemaObject } from "openapi3-ts";

import { isReferenceObject } from "./isReferenceObject";
import { type SchemaInput, normalizeBooleanSchema } from "./normalizeBooleanSchema";
import { lowerStructuralConditional } from "./schemaAssertions";

export const getOpenApiDependencyGraph = (
    schemaRef: string[],
    getSchemaByRef: (ref: string) => SchemaInput,
    supportsSchemaRefSiblings = false
) => {
    const normalizedSchemas = new WeakMap<object, SchemaObject>();
    const visitedsRefs = {} as Record<string, boolean>;
    const refsDependencyGraph = {} as Record<string, Set<string>>;
    const resolver = {
        supportsSchemaRefSiblings,
        getSchemaByRef: (ref: string) => {
            const target = getSchemaByRef(ref);
            return target == null ? target : normalizeBooleanSchema(target, normalizedSchemas);
        },
    };

    const visit = (input: SchemaInput, fromRef: string): void => {
        if (!input || typeof input === "boolean") return;
        const normalized = normalizeBooleanSchema(input, normalizedSchemas);
        const conditional = lowerStructuralConditional(normalized, resolver);
        const schema = conditional ? { allOf: [conditional.base, conditional.allowed] } : normalized;

        if (isReferenceObject(schema)) {
            if (!refsDependencyGraph[fromRef]) {
                refsDependencyGraph[fromRef] = new Set();
            }

            refsDependencyGraph[fromRef]!.add(schema.$ref);

            if (!visitedsRefs[schema.$ref]) {
                visitedsRefs[fromRef] = true;
                visit(getSchemaByRef(schema.$ref), schema.$ref);
            }

            if (!supportsSchemaRefSiblings) return;
        }

        // A schema object's $ref siblings are independent child schemas in 3.1.
        const local: SchemaObject = { ...schema };
        if (local.not) visit(local.not, fromRef);
        for (const composite of [local.allOf, local.oneOf, local.anyOf]) {
            for (const branch of composite ?? []) visit(branch, fromRef);
        }

        if (local.items) visit(local.items, fromRef);
        for (const child of Object.values(local.properties ?? {})) visit(child, fromRef);
        if (typeof local.additionalProperties === "object") visit(local.additionalProperties, fromRef);
    };

    schemaRef.forEach((ref) => visit(getSchemaByRef(ref), ref));

    const deepDependencyGraph = {} as Record<string, Set<string>>;
    const visitedsDeepRefs = {} as Record<string, boolean>;
    schemaRef.forEach((ref) => {
        const deps = refsDependencyGraph[ref];
        if (!deps) return;
        if (!deepDependencyGraph[ref]) {
            deepDependencyGraph[ref] = new Set();
        }

        const visit = (dep: string) => {
            deepDependencyGraph[ref]!.add(dep);
            if (refsDependencyGraph[dep] && ref !== dep) {
                refsDependencyGraph[dep]!.forEach((transitive) => {
                    if (visitedsDeepRefs[ref + "__" + transitive]) return;
                    visitedsDeepRefs[ref + "__" + transitive] = true;
                    visit(transitive);
                });
            }
        };

        deps.forEach((dep) => visit(dep));
    });

    return { refsDependencyGraph, deepDependencyGraph };
};
