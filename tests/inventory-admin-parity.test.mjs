
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { frontendBody, backendBody, mediaBody, digest } from "./support/inventory-source-parity.mjs";
const root=new URL("../src/tools/inventory-admin/",import.meta.url);
const manifest=JSON.parse(fs.readFileSync(new URL("provenance.json",root),"utf8"));
test("all 61 imported inventory processing bodies match the original snapshot",()=>{
 for(const item of manifest.frontend){const file=new URL("../../margyn-2026/components/inventory-admin/original/"+item.path,import.meta.url);assert.equal(digest(frontendBody(fs.readFileSync(file,"utf8"),item.path)),item.normalizedSha256,item.path);}
 for(const item of manifest.backend){assert.equal(digest(backendBody(fs.readFileSync(new URL("original/"+item.path,root),"utf8"))),item.normalizedSha256,item.path);}
 for(const item of manifest.mediaHandlers){const mode=item.path.split("/").at(-2);assert.equal(digest(mediaBody(fs.readFileSync(new URL("media/"+mode+"/route.mjs",root),"utf8"))),item.normalizedSha256,item.path);}
 assert.equal(manifest.frontend.length+manifest.backend.length+manifest.mediaHandlers.length,61);
});
