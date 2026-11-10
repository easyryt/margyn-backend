
import ts from "typescript";
import { createHash } from "node:crypto";
export const digest = value => createHash("sha256").update(value).digest("hex");
function canonicalInitializer(source, names) {
 const tree=ts.createSourceFile("module.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX), edits=[];
 function visit(node){ if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer&&names.includes(node.name.text))edits.push([node.initializer.getStart(tree),node.initializer.end]);ts.forEachChild(node,visit); }visit(tree);
 for(const [start,end] of edits.sort((a,b)=>b[0]-a[0]))source=source.slice(0,start)+'"INTEGRATION_ENDPOINT"'+source.slice(end);
 return source;
}
export function normalizeFrontend(source, relative) {
 let normalized=source.replaceAll("@/components/listing-tool/original/","@/").replaceAll('"@/components/listing-tool/navigation"','"next/navigation"').replaceAll('"@/components/listing-tool/link"','"next/link"').replaceAll('"/api/tools/listing-tool/ai/','"/api/ai/');
 for(const asset of ["meesho-template.xlsx","general-products-template.xlsx","listing-meesho-extension.zip"])normalized=normalized.replaceAll("/listing-tool/"+asset,"/"+asset);
 if(relative==="app/page.tsx")normalized=normalized.replace("Listing Tool","Catalog Analytics");
 return canonicalInitializer(normalized,["API_BASE_URL","API_BASE"]).replaceAll("\r\n","\n");
}
export function normalizeServer(source) {
 for(const key of ["AI_PROVIDER","GEMINI_CONTENT_MODEL","OPENAI_CONTENT_MODEL"])source=source.replaceAll("(process.env.LISTING_"+key+" || process.env."+key+")","process.env."+key);
 source=source.replaceAll('"margyn-listing-staging"','"meesho-staging"');
 const js=ts.transpileModule(canonicalInitializer(source,["PRODUCT_API_BASE_URL"]),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const tree=ts.createSourceFile("module.mjs",js,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const body=ts.factory.updateSourceFile(tree,tree.statements.filter(node=>!ts.isImportDeclaration(node)));
 return ts.createPrinter({removeComments:true,newLine:ts.NewLineKind.LineFeed}).printFile(body);
}
