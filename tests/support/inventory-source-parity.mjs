import ts from "typescript";
import { createHash } from "node:crypto";
export const digest = value => createHash("sha256").update(value).digest("hex");
function initializers(source, names) {
 const tree=ts.createSourceFile("source.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),edits=[];
 function visit(node){if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&names.includes(node.name.text)&&node.initializer)edits.push([node.initializer.getStart(tree),node.initializer.end]);ts.forEachChild(node,visit)}visit(tree);
 for(const [start,end]of edits.sort((a,b)=>b[0]-a[0]))source=source.slice(0,start)+'"INVENTORY_TRANSPORT"'+source.slice(end);
 return source;
}
export function frontendBody(source, relative) {
 source=source.replace('import { inventoryFetch as fetch } from "@/components/inventory-admin/server";\n','').replaceAll('"@/components/inventory-admin/server"','"next/headers"').replaceAll('"@/components/inventory-admin/link"','"next/link"').replaceAll('"@/components/inventory-admin/navigation"','"next/navigation"');
 source=source.replaceAll("https://inventory-system-ecew.onrender.com/api","INVENTORY_API").replaceAll("/api/tools/inventory-admin","INVENTORY_API").replace(/(["'`])\/api\//g,(_match,quote)=>quote+"INVENTORY_API/");
 if(relative === "inventory/InventoryList.tsx")source=source.replace("Inventory Admin","Phone models");
 return initializers(source,["API","IMAGEKIT_UPLOAD_URL","IMAGEKIT_PUBLIC_KEY"]).replaceAll("\r\n","\n");
}
export function backendBody(source) {
 return source.replaceAll("../../../mongoose-context.cjs","mongoose").replaceAll("../../../auth-context.cjs","../middlewares/auth.middleware").replaceAll("\r\n","\n");
}
export function mediaBody(source) {
 source=source.replaceAll("process.env.NEXT_PUBLIC_IMAGEKIT_PUBLIC_KEY","process.env.IMAGEKIT_PUBLIC_KEY").replaceAll("process.env.NEXT_PUBLIC_IMAGEKIT_URL_ENDPOINT","process.env.IMAGEKIT_URL_ENDPOINT");
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const tree=ts.createSourceFile("source.mjs",js,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 return ts.createPrinter({removeComments:true,newLine:ts.NewLineKind.LineFeed}).printFile(ts.factory.updateSourceFile(tree,tree.statements.filter(node=>!ts.isImportDeclaration(node))));
}
