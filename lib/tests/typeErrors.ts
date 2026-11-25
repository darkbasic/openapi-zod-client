import { fileURLToPath } from "node:url";
import ts from "typescript";

export function typeErrors(source: string | Record<string, string>): string[] {
    const sources = typeof source === "string" ? { ".generated-types.ts": source } : source;
    const files = new Map(
        Object.entries(sources).map(([name, code]) => [fileURLToPath(new URL(name, import.meta.url)), code])
    );
    const options: ts.CompilerOptions = {
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        types: [],
    };
    const host = ts.createCompilerHost(options);
    const fileExists = host.fileExists.bind(host);
    host.fileExists = (name) => files.has(name) || fileExists(name);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
        files.has(name)
            ? ts.createSourceFile(name, files.get(name)!, languageVersion, true)
            : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);

    return ts
        .getPreEmitDiagnostics(ts.createProgram([...files.keys()], options, host))
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}
