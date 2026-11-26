import { ts } from "tanu";

const file = ts.createSourceFile("", "", ts.ScriptTarget.ESNext, true);
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
export const printTs = (node: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, node, file);
