
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeFrontend, normalizeServer, digest } from "./support/listing-source-parity.mjs";
const root=new URL("../src/tools/listing-tool/",import.meta.url);
const manifest=JSON.parse(fs.readFileSync(new URL("provenance.json",root),"utf8"));
test("all 96 imported Listing Tool processing bodies match the source snapshot",()=>{
 for(const item of manifest.frontend){
  const file=new URL("../../margyn-2026/components/listing-tool/original/"+item.path,import.meta.url);
  assert.equal(digest(normalizeFrontend(fs.readFileSync(file,"utf8"),item.path)),item.normalizedSha256,item.path);
 }
 for(const item of manifest.backend){const file=new URL(item.path.startsWith("frontend/")?item.path.replace(/\.ts$/,".mjs"):"original/"+item.path,root);assert.equal(digest(normalizeServer(fs.readFileSync(file,"utf8"))),item.normalizedSha256,item.path);}
 for(const item of manifest.assets){const file=new URL("../../margyn-2026/public/listing-tool/"+item.path,import.meta.url);assert.equal(digest(fs.readFileSync(file)),item.sha256,item.path);}
 assert.equal(manifest.frontend.length+manifest.backend.length,96);
});
