// Fails if any symbol exported from src/index.ts, or any public member of an
// exported class or interface, has no TSDoc comment.
import ts from "typescript";

const configPath = new URL("../tsconfig.build.json", import.meta.url).pathname;
const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const program = ts.createProgram(config.fileNames, config.options);
const checker = program.getTypeChecker();
const entry = program.getSourceFile(new URL("../src/index.ts", import.meta.url).pathname);
const missing = [];
let checked = 0;

const hasDoc = (symbol) => symbol.getDocumentationComment(checker).some((part) => part.text.trim() !== "");
const isPrivate = (decl) =>
  ts.getCombinedModifierFlags(decl) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected) ||
  (decl.name && ts.isPrivateIdentifier(decl.name));

for (const exported of checker.getExportsOfModule(checker.getSymbolAtLocation(entry))) {
  const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  checked++;
  if (!hasDoc(symbol)) missing.push(exported.name);
  const decl = symbol.declarations?.[0];
  if (!decl || !(ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl))) continue;
  for (const member of decl.members) {
    if (isPrivate(member)) continue;
    const memberSymbol = member.name ? checker.getSymbolAtLocation(member.name) : member.symbol;
    const label = ts.isConstructorDeclaration(member) ? "constructor" : member.name?.getText();
    checked++;
    const doc = memberSymbol ? hasDoc(memberSymbol) : ts.getJSDocCommentsAndTags(member).length > 0;
    if (!doc) missing.push(`${exported.name}.${label}`);
  }
}

if (missing.length > 0) {
  console.error(`TSDoc missing on ${missing.length} of ${checked} public symbols:\n${missing.map((m) => `  ${m}`).join("\n")}`);
  process.exit(1);
}
console.log(`TSDoc check passed: ${checked} public symbols and members documented.`);
