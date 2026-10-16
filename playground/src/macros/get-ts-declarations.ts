import fs from "node:fs";
import path from "node:path";

import { safeJSONParse } from "pastable";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";
import type { PackageJson } from "type-fest";

const getDeps = (pkg: PackageJson) =>
    Object.keys(pkg.dependencies ?? {}).concat(Object.keys(pkg.peerDependencies ?? {}));

const getPkg = async (name: string) =>
    safeJSONParse<PackageJson>(await fs.promises.readFile(`./node_modules/${name}/package.json`, "utf8"));

const getTypesDeclaration = async (name: string, typesEntry?: string) => {
    const pkg = await getPkg(name);
    const types = typesEntry ?? pkg.types ?? pkg.typings;
    if (!types) return;

    const bundle = await rollup({
        input: path.resolve("./node_modules/", name, types),
        plugins: [dts({ respectExternal: true })],
        external: (id) => getDeps(pkg).includes(id),
    });
    const result = await bundle.generate({});

    return result.output[0].code;
};

const getTsDeclarations = async () => {
    const declarations = await Promise.all([
        getTypesDeclaration("@zodios/core"),
        // The root Zod 3.25 entry adds a circular namespace wrapper that rollup-plugin-dts cannot bundle.
        getTypesDeclaration("zod", "v3/index.d.cts"),
    ]);

    return {
        data: [
            { name: "@zodios/core", code: `declare module '@zodios/core' { ${declarations[0]} }` },
            { name: "zod", code: `declare module 'zod' { ${declarations[1]} }` },
        ],
    };
};

// eslint-disable-next-line import/no-unused-modules
export default getTsDeclarations;

// uncomment to run with tsx
// await getTsDeclarations();
