
import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { startTestBackend } from "./support/runtime.mjs";
import { getSubscription } from "../src/services/subscriptions.mjs";
const origin = "http://localhost:3000";
const prefix = "/api/tools/listing-tool";
function phone(suffix = "A") {
 return { productName: "Clear iPhone 13 floral phone cover " + suffix, designName: "Floral Garden " + suffix, designCode: "FLORAL" + suffix,
 designNumber: "317.1", sku: "MBRO-MC-AP-IP13-UVV-FLORAL" + suffix + "-WL-TRNSPT-317.1.V1", groupId: "1", models: [{ model: "Apple iPhone 13" }],
 price: 121, mrp: 899, inventory: 20, brand: "Mobiro", category: "Mobile Cases & Covers", image1: "https://example.com/cover.png" };
}
function general() {
 return { draft: { id: "integration-general", productName: "Universal Transparent Phone Charms Holder Insert Tabs (Pack of 10)",
 category: "Beads & Charms", genericName: "Beads & Charms", productType: "Phone Charms Holder", quantity: "10", price: "64", wrongDefectiveReturnsPrice: "63", mrp: "399", gst: "18", weight: "10", inventory: "2000", hsn: "392640", variation: "Free Size", image1: "https://example.com/product.png", groupId: "1", description: "Holder tabs" },
 codes: { brandCode: "MBRO", categoryCode: "CHM", productCode: "HLDR", colorCode: "GLD" }, parentVersion: 1, productContext: "Holder tabs", variants: Array.from({length:20},(_,i)=>({ id: "variant-"+(i+2), version: i+2, productName: "Clear Phone Charms Holder Insert Tabs for Mobile Cases (Pack of 10)", overrides: { inventory: "8", description: "A".repeat(1000) } })) };
}
test("Listing Tool uses original CRUD, transactions, imports and seller-isolated collections", { timeout: 120000 }, async t => {
 const runtime = await startTestBackend(origin);
 const realFetch = globalThis.fetch;
 t.after(async () => { globalThis.fetch = realFetch; await runtime.close(); });
 let cookie = "";
 async function request(path, method = "GET", data, session = cookie) {
   const response = await realFetch(runtime.url + prefix + path, { method, headers: { Origin: origin, ...(session ? { Cookie: session } : {}), ...(data instanceof FormData ? {} : { "Content-Type": "application/json" }) }, ...(data === undefined ? {} : { body: data instanceof FormData ? data : JSON.stringify(data) }) });
   return { status: response.status, body: await response.json() };
 }
 async function login(phone) {
   const challenge = await (await realFetch(runtime.url + "/api/auth/request-otp", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ phone }) })).json();
   const response = await realFetch(runtime.url + "/api/auth/verify-otp", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ challengeId: challenge.challengeId, code: challenge.developmentCode }) });
   assert.equal(response.status, 200); return response.headers.get("set-cookie").split(";")[0];
 }
 await t.test("guests cannot read, write or invoke AI", async () => {
   for (const [path,method,data] of [["/products/dashboard","GET"],["/general-products","GET"],["/designs","POST",{}],["/ai/variant-titles","POST",{}]]) assert.equal((await request(path,method,data,"")).status,401);
 });
 cookie = await login("9876543240");
 const second = await login("9876543241");
 const marketplace = await (await realFetch(runtime.url + "/api/products")).json();
 let parentId, generalId, revision;
 await t.test("original model proxy supports dashboard aggregations and transactional family creation", async () => {
   const initial = await request("/products/dashboard");assert.equal(initial.status,200,JSON.stringify(initial.body));assert.equal(initial.body.stats.totalProducts,0);
   const parent=phone(),variant={...parent,sku:parent.sku.replace("V1","V2"),productName:"Clear floral iPhone 13 cover variant"};
   const saved=await request("/products/batch","POST",{parent,variants:[variant]});assert.equal(saved.status,201,JSON.stringify(saved.body));parentId=saved.body.product.id;
   assert.equal(saved.body.variants.length,1);assert.equal(saved.body.variants[0].parentId,parentId);
   const dashboard=await request("/products/dashboard");assert.equal(dashboard.body.stats.totalProducts,1);assert.equal(dashboard.body.stats.totalVariants,1);
   assert.equal((await request("/products/"+parentId)).status,200);
 });
 await t.test("same identifiers are independent across accounts; cross-account IDs and writes are rejected", async () => {
   assert.equal((await request("/products/"+parentId,"GET",undefined,second)).status,404);
   assert.equal((await request("/products/"+parentId,"PATCH",{inventory:999},second)).status,404);
   const saved=await request("/products","POST",phone(),second);assert.equal(saved.status,201,JSON.stringify(saved.body));assert.notEqual(saved.body.product.id,parentId);
   const [a,b]=await Promise.all([request("/products/"+parentId),request("/products/"+saved.body.product.id,"GET",undefined,second)]);assert.equal(a.body.product.inventory,20);assert.equal(b.body.product.inventory,20);
 });
 await t.test("original charm creation keeps separate charm records and defaults", async () => {
   const result=await request("/products/"+parentId+"/with-charm","POST",{});assert.equal(result.status,201,JSON.stringify(result.body));
   const charms=await request("/charms");assert.equal(charms.body.count,1);assert.equal(charms.body.charms[0].wrongDefectiveReturnsPrice,2);
   assert.equal((await request("/charms","GET",undefined,second)).body.count,0);
   assert.equal((await request("/products/dashboard")).body.stats.totalRecords,2);
 });
 await t.test("original general-family saves accept large batches, are idempotent and retain revision guards", async () => {
   const saved=await request("/general-products/batch","POST",{products:[general()]});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.counts.created,1);
   generalId=saved.body.saved[0].databaseId;revision=saved.body.saved[0].databaseRevision;
   assert.equal((await request("/general-products/batch","POST",{products:[general()]})).body.counts.unchanged,1);
   const result=await request("/general-products/"+generalId);assert.equal(result.body.product.variants.length,20);assert.equal(result.body.product.draft.sku,"MBRO-CHM-HLDR-GLD-10PC-V1");
   const analytics=await request("/general-products/analytics");assert.equal(analytics.body.stats.totalProducts,1);assert.equal(analytics.body.stats.totalListings,21);
   assert.equal((await request("/general-products/"+generalId,"GET",undefined,second)).status,404);
   assert.equal((await request("/general-products/"+generalId+"?revision="+(revision+1),"DELETE")).status,409);
 });
 await t.test("AI design saves use the same original design route within the active account", async () => {
   const {withListingUser}=await import("../src/tools/listing-tool/mongoose-context.mjs");
   const {listingFetch}=await import("../src/tools/listing-tool/listing-fetch.mjs");
   const user=await (await realFetch(runtime.url+"/api/auth/me",{headers:{Cookie:cookie}})).json();
   const result=await withListingUser(user.user.id,()=>listingFetch("http://margyn-listing.internal/api/designs",{method:"POST",body:JSON.stringify({designName:"Ocean Floral",designCode:"OCNFLR",imageUrl:"https://example.com/design.png",source:"ai"})}));
   assert.equal(result.status,201,await result.clone().text());
   assert.equal((await request("/designs")).body.count,1);
   assert.equal((await request("/designs","GET",undefined,second)).body.count,0);
 });
 await t.test("spreadsheet multipart imports use the original mapper and original validation", async () => {
   assert.equal((await request("/designs","POST",{designName:"Imported Garden",designCode:"IMPORTAB"})).status,201);
   const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([["Product Name","Meesho Price","MRP","Inventory","Compatible Models","SKU ID","Group ID","Design Name"],["Apple iPhone 14 clear cover","113","899","30","Apple iPhone 14","MBRO-MC-AP-IP14-UVV-IMPORTAB-WL-TRNSPT-318.1.V1","1","Imported Design"]]),"Listings");
   const form=new FormData();form.append("file",new Blob([XLSX.write(workbook,{type:"buffer",bookType:"xlsx"})]),"listings.xlsx");
   const result=await request("/products/import","POST",form);assert.equal(result.status,200,JSON.stringify(result.body));
   assert.equal((await request("/products/dashboard")).body.stats.totalProducts,2);
 });
 await t.test("all four original AI handlers keep provider settings and multipart/JSON fields", async () => {
   const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJXcAAAAASUVORK5CYII=","base64");
   let output,aiCalls=0,uploadCalls=0;
   globalThis.fetch=async(url,options)=>{
     if(String(url).startsWith("https://api.imagekit.io/v1/files")) return Response.json(String(url).endsWith("/details") ? { filePath:"/design-library/fixture.png",fileId:"fixture",size:100,url:"https://ik.imagekit.io/t9rd9hyjk/fixture.png" } : []);
     if(String(url).startsWith("https://upload.imagekit.io/")){assert.match(options.body.get("folder"), /^\/margyn\/inventory\/[a-f0-9]{24}\/listings$/);uploadCalls++;return Response.json({fileId:"fixture",url:"https://ik.imagekit.io/t9rd9hyjk/fixture.png",thumbnailUrl:"https://ik.imagekit.io/t9rd9hyjk/fixture.png"});}
     if(String(url).startsWith("https://api.openai.com/")||String(url).startsWith("https://generativelanguage.googleapis.com/")){
       aiCalls++;const data=JSON.parse(options.body);assert.ok(data.model||data.contents);
       return Response.json(String(url).includes("openai")?{output_text:JSON.stringify(output),usage:{input_tokens:100,output_tokens:50,total_tokens:150}}:{candidates:[{content:{parts:[{text:JSON.stringify(output)}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:50,totalTokenCount:150}});
     }
     return realFetch(url,options);
   };
   const coverTitle="Apple iPhone 13 Back Cover Case with Clear Floral Garden Print";
   for(const provider of ["gemini","openai"]){
     const suffix=provider==="gemini"?"ALPHA":"BETA";
     output={titleOptions:[coverTitle],color:"Transparent",material:"Not specified",designName:"Floral "+suffix,designCode:"FLR"+suffix};
     const form=new FormData();for(const [k,v]of Object.entries({provider,category:"Mobile Cases & Covers",model:"Apple iPhone 13",theme:"Floral",productType:"Back Cover",titleCount:"1"}))form.set(k,v);form.set("image",new Blob([png],{type:"image/png"}),"cover.png");
     const cover=await request("/ai/product-copy","POST",form);assert.equal(cover.status,200,JSON.stringify(cover.body));assert.equal(cover.body.titleOptions[0],coverTitle);assert.ok(cover.body.designId);
     output={titles:["Apple iPhone 13 Back Cover Case with Elegant Botanical Floral Print"]};
     const titles=await request("/ai/variant-titles","POST",{provider,parentTitle:coverTitle,category:"Mobile Cases & Covers",model:"Apple iPhone 13",theme:"Floral",productType:"Back Cover",count:1});assert.equal(titles.status,200,JSON.stringify(titles.body));assert.equal(titles.body.titles.length,1);
     const title="Universal Transparent Phone Charms Holder Insert Tabs (Pack of 10)";
     output={title,color:"Transparent",material:"Plastic",netQuantity:"10",variation:"Free Size",description:"Phone holder inserts",skuCodes:{productCode:"HLDR",colorCode:"GLD"}};
     const generalForm=new FormData();for(const [k,v]of Object.entries({provider,category:"Beads & Charms",genericName:"Beads & Charms",productType:"Phone Charms Holder",quantity:"10"}))generalForm.set(k,v);generalForm.set("image",new Blob([png],{type:"image/png"}),"holder.png");
     const generalCopy=await request("/ai/general-product-copy","POST",generalForm);assert.equal(generalCopy.status,200,JSON.stringify(generalCopy.body));assert.equal(generalCopy.body.netQuantity,"10");
     output={titles:["Clear Phone Charms Holder Lanyard Insert Tabs for Mobile Cases (Pack of 10)"]};
     const generalTitles=await request("/ai/general-product-variant-titles","POST",{provider,parentTitle:title,category:"Beads & Charms",genericName:"Beads & Charms",productType:"Phone Charms Holder",quantity:"10",count:1});assert.equal(generalTitles.status,200,JSON.stringify(generalTitles.body));assert.equal(generalTitles.body.titles.length,1);
   }
   assert.equal(aiCalls,8);assert.equal(uploadCalls,4);
   const account=await (await realFetch(runtime.url+"/api/auth/me",{headers:{Cookie:cookie}})).json();
   const subscription=await getSubscription(account.user.id);
   assert.equal(subscription.usedTokens,aiCalls*150);
   assert.equal(subscription.inputTokens,aiCalls*100);
   assert.equal(subscription.outputTokens,aiCalls*50);
 });
 await t.test("native image staging requires login and keeps the original extension capability check", async () => {
   const {randomUUID}=await import("node:crypto");const {readFile,rm}=await import("node:fs/promises");const path=await import("node:path");
   const jobId=randomUUID(),folder=path.resolve(".local/margyn-listing-staging",jobId),root=path.resolve(".local/margyn-listing-staging");
   assert.ok(folder.startsWith(root+path.sep));
   t.after(async()=>{await rm(folder,{recursive:true,force:true})});
   const input={action:"prepare",jobId,target:{rowId:"fixture-row",field:"image1"},file:{name:"fixture.png",type:"image/png",base64:Buffer.from([137,80,78,71,13,10,26,10,...Array(24).fill(0)]).toString("base64")}};
   const send=(data,headers={})=>realFetch(runtime.url+"/api/meesho-upload",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json",...headers},body:JSON.stringify(data)});
   assert.equal((await send(input)).status,401);
   const staged=await send(input,{Cookie:cookie});assert.equal(staged.status,200,await staged.clone().text());const descriptor=await staged.json();assert.ok(descriptor.token);assert.equal(descriptor.path,undefined);
   const extension="a".repeat(32),resolve={action:"resolve",jobId,token:descriptor.token};
   assert.equal((await send(resolve,{Origin:"https://untrusted.invalid","X-Listing-Extension":extension})).status,400);
   const result=await send(resolve,{Origin:"chrome-extension://"+extension,"X-Listing-Extension":extension});assert.equal(result.status,200,await result.clone().text());const file=await result.json();assert.ok(file.path.startsWith(folder));assert.equal((await readFile(file.path)).length,32);
   const preflight=await realFetch(runtime.url+"/api/meesho-upload",{method:"OPTIONS",headers:{Origin:"chrome-extension://"+extension}});assert.equal(preflight.status,204);
 });
 await t.test("invalid AI input and foreign origins are rejected before provider calls", async () => {
   globalThis.fetch=async(url,options)=>{if(String(url).startsWith("https://"))throw new Error("Unexpected external request");return realFetch(url,options)};
   assert.equal((await request("/ai/variant-titles","POST",{})).status,400);
   const result=await realFetch(runtime.url+prefix+"/products",{method:"POST",headers:{Origin:"https://untrusted.invalid",Cookie:cookie,"Content-Type":"application/json"},body:JSON.stringify(phone("B"))});assert.equal(result.status,403);
 });
 await t.test("listing records never alter the marketplace product collection", async () => {
   const after=await (await realFetch(runtime.url+"/api/products")).json();assert.deepEqual(after,marketplace);
   assert.equal((await request("/general-products/"+generalId+"?revision="+revision,"DELETE")).status,200);
 });
});
