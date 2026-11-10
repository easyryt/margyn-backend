
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { startTestBackend } from "./support/runtime.mjs";
const origin="http://inventory.test",prefix="/api/tools/inventory-admin";
test("Inventory Admin preserves stock, print, purchase and barcode workflows in private seller collections", {timeout:120000}, async t=>{
 const runtime=await startTestBackend(origin),realFetch=globalThis.fetch;
 t.after(async()=>{globalThis.fetch=realFetch;await runtime.close()});
 let cookie="";
 async function request(path,method="GET",body,session=cookie){const r=await realFetch(runtime.url+prefix+path,{method,headers:{Origin:origin,...(session?{Cookie:session}:{}),...(body instanceof FormData?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)})});return{status:r.status,body:await r.json()};}
 async function login(phone){const challenge=await(await realFetch(runtime.url+"/api/auth/request-otp",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({phone})})).json();const r=await realFetch(runtime.url+"/api/auth/verify-otp",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({challengeId:challenge.challengeId,code:challenge.developmentCode})});assert.equal(r.status,200);return r.headers.get("set-cookie").split(";")[0]}
 await t.test("all inventory, staff and image actions require a Margyn session",async()=>{for(const [path,method,body]of[["/products","GET"],["/dashboard/inventory-products","GET"],["/imagekit/list","GET"],["/imagekit-auth","GET"],["/inventory/raw","POST",{}],["/auth/register","POST",{}]])assert.equal((await request(path,method,body,"")).status,401)});
 cookie=await login("9876543250");const other=await login("9876543251");
 const marketplace=await(await realFetch(runtime.url+"/api/products")).json();
 let categoryId,productId,designId,rawId,jobId,barcodes;
 await t.test("original categories, dynamic attributes and products persist",async()=>{
  const category=await request("/categories","POST",{name:"Mobile Covers",metaFields:[{key:"brand",label:"Brand",type:"string",required:true}]});assert.equal(category.status,201,JSON.stringify(category.body));categoryId=category.body.category._id;
  const invalid=await request("/products","POST",{categoryId,name:"iPhone 13",attributes:{}});assert.equal(invalid.status,400);
  const product=await request("/products","POST",{categoryId,name:"Apple iPhone 13",attributes:{brand:"Apple"}});assert.equal(product.status,201,JSON.stringify(product.body));productId=product.body.product._id;
  assert.equal((await request("/products")).body.products[0].categoryId.name,"Mobile Covers");
  const design=await request("/product-designs","POST",{productId,name:"Floral Garden",mode:"SCREEN_PRINT",sku:"IP13-FLORAL",designCode:"FLORAL",designUrl:"https://example.com/floral.png"});assert.equal(design.status,201,JSON.stringify(design.body));designId=design.body.design._id;
  const choices=await request("/printing-jobs/"+productId+"?kind=designs");assert.equal(choices.status,200,JSON.stringify(choices.body));assert.equal(choices.body.designs[0]._id,designId);
  assert.equal((await request("/printing-jobs?kind=products")).body.products.length,1);
 });
 await t.test("RAW addition and original completed printing transactions move the exact stock",async()=>{
  const raw=await request("/inventory/raw","POST",{productId,quantity:100,minThreshold:5});assert.equal(raw.status,201,JSON.stringify(raw.body));rawId=raw.body.inventory._id;
  assert.equal((await request("/inventory/raw","POST",{productId,quantity:1.5})).status,400);
  const printing=await request("/printing-jobs","POST",{categoryId,productId,designId,quantity:10,status:"COMPLETED"});assert.equal(printing.status,201,JSON.stringify(printing.body));jobId=printing.body.printingJob._id;
  const dashboard=(await request("/dashboard/inventory-products")).body;assert.equal(dashboard[0].rawQuantity,90);assert.equal(dashboard[0].printedQuantity,10);
  assert.equal((await request("/printing-jobs/"+jobId,"PUT",{status:"COMPLETED"})).status,200);
  assert.equal((await request("/dashboard/inventory-products")).body[0].rawQuantity,90);
  assert.equal((await request("/printing-jobs","POST",{categoryId,productId,designId,quantity:200,status:"COMPLETED"})).status,400);
 });
 await t.test("barcode batches are exact, retries reuse labels, and packing consumes one unit",async()=>{
  const batch=await request("/printing-jobs/"+jobId+"/barcodes","POST",{});assert.equal(batch.status,201,JSON.stringify(batch.body));assert.equal(batch.body.barcodeCount,10);assert.equal((await request("/barcodes?productId="+productId)).status,200);barcodes=batch.body.barcodes;
  const repeat=await request("/printing-jobs/"+jobId+"/barcodes","POST",{});assert.equal(repeat.status,200);assert.deepEqual(repeat.body.barcodes.map(row=>row._id),barcodes.map(row=>row._id));
  const lookup=await request("/packing/lookup","POST",{code:barcodes[0].code});assert.equal(lookup.status,200);assert.equal(lookup.body.printedInventory.quantity,10);
  const scan=await request("/packing/scan","POST",{code:barcodes[0].code});assert.equal(scan.status,200,JSON.stringify(scan.body));assert.equal(scan.body.inventory.quantity,9);
  assert.equal((await request("/packing/scan","POST",{code:barcodes[0].code})).status,400);
  assert.equal((await request("/barcodes/packed")).body.totalPacked,1);
  const second=await request("/printing-jobs","POST",{categoryId,productId,designId,quantity:10,status:"COMPLETED"});assert.equal(second.status,201);const labels=await request("/printing-jobs/"+second.body.printingJob._id+"/barcodes","POST",{});assert.equal(labels.body.barcodeCount,10);
 });
 await t.test("purchase verification adds product-level RAW stock and retains the original duplicate-line rules",async()=>{
  const created=await request("/purchase-orders","POST",{supplierName:"Fixture supplier",items:[{productId,orderedQty:10},{productId,orderedQty:5}]});assert.equal(created.status,201,JSON.stringify(created.body));const po=created.body.purchaseOrder;assert.equal(po.items.length,1);assert.equal(po.items[0].orderedQty,15);
  const received=await request("/purchase-orders/"+po._id+"/verify","POST",{items:[{productId,receivedQty:12}]});assert.equal(received.status,200,JSON.stringify(received.body));assert.equal((await request("/dashboard/inventory-products")).body[0].rawQuantity,92);
  assert.equal((await request("/purchase-orders/"+po._id+"/verify","POST",{items:[{productId,receivedQty:12}]})).status,400);
  assert.equal((await request("/inventory/threshold/"+rawId,"PATCH",{minThreshold:100})).status,200);
  assert.equal((await request("/dashboard/inventory-products")).body[0].minThreshold,100);
  const lowStock=await request("/inventory/low-stock");assert.equal(lowStock.status,200);assert.ok(lowStock.body.lowStockItems.some(item=>item.productName==="Apple iPhone 13" && item.deficit===8),JSON.stringify(lowStock.body));
 });
 await t.test("other accounts cannot read or change these models, stock, designs or labels",async()=>{
  assert.equal((await request("/products","GET",undefined,other)).body.products.length,0);
  assert.equal((await request("/products/"+productId,"GET",undefined,other)).status,404);
  assert.equal((await request("/inventory/raw","POST",{productId,quantity:999},other)).status,404);
  assert.equal((await request("/packing/scan","POST",{code:barcodes[1].code},other)).status,404);
  assert.equal((await request("/dashboard/inventory-products")).body[0].rawQuantity,92);
  const same=await request("/categories","POST",{name:"Mobile Covers",metaFields:[]},other);assert.equal(same.status,201);
 });
 await t.test("staff creation remains private and never changes the Margyn account role",async()=>{
  const staff=await request("/auth/register","POST",{name:"Fixture packer",email:"packer@example.com",password:"fixture-password",role:"PACKER"});assert.equal(staff.status,201,JSON.stringify(staff.body));assert.equal(staff.body.user.role,"PACKER");assert.equal(staff.body.token,undefined);
  const me=await(await realFetch(runtime.url+"/api/auth/me",{headers:{Cookie:cookie}})).json();assert.equal(me.user.role,"customer");
 });
 await t.test("image upload, list, replacement and deletion are scoped to this seller",async()=>{
  const me=await(await realFetch(runtime.url+"/api/auth/me",{headers:{Cookie:cookie}})).json();const folder="/margyn/inventory/"+createHash("sha256").update(me.user.id).digest("hex").slice(0,24);
  const calls=[];const files=new Map();let emptyFolder=true;
  globalThis.fetch=async(url,options={})=>{
   const value=String(url);if(value.startsWith("https://api.imagekit.io/")||value.startsWith("https://upload.imagekit.io/")){
    calls.push({url:value,method:options.method||"GET"});assert.ok(options.headers.Authorization.startsWith("Basic "));
    if(value.startsWith("https://upload.imagekit.io/")){const form=options.body;assert.equal(form.get("folder"),folder);const file={size:form.get("file").size,fileId:"fixture-image",name:form.get("fileName"),filePath:folder+"/fixture.png",url:"https://ik.imagekit.io/t9rd9hyjk/fixture.png",thumbnail:"https://ik.imagekit.io/t9rd9hyjk/fixture.png"};files.set(file.fileId,file);return Response.json(file)}
    const parsed=new URL(value);if(parsed.searchParams.has("path")){if(emptyFolder)return Response.json({message:"Folder not found"},{status:404});return Response.json([...files.values(),{fileId:"foreign-image",name:"private.png",filePath:"/different-seller/private.png",url:"https://example.com/private.png"}]);}
    if(value.endsWith("/details"))return Response.json(files.get(parsed.pathname.split("/").at(-2))||{filePath:"/different-seller/private.png"});
    if(options.method==="DELETE")return new Response(null,{status:204});
    throw new Error("Unexpected ImageKit request");
   }return realFetch(url,options);
  };
  const empty=await request("/imagekit/list");assert.equal(empty.status,200);assert.deepEqual(empty.body.images,[]);emptyFolder=false;
  const auth=await request("/imagekit-auth");assert.equal(auth.status,200);assert.equal(auth.body.signature,"server-managed");
  const pixels=await sharp({create:{width:32,height:32,channels:3,background:"#7788cc"}}).png().toBuffer();const form=new FormData();form.set("file",new Blob([pixels],{type:"image/png"}),"fixture.png");form.set("folder","/different-seller");
  const uploaded=await request("/imagekit/upload","POST",form);assert.equal(uploaded.status,201,JSON.stringify(uploaded.body));assert.equal((await request("/imagekit/list")).body.images.length,1);
  const replace=new FormData();replace.set("fileId","fixture-image");replace.set("file",new Blob([pixels],{type:"image/png"}),"replacement.png");const changed=await request("/imagekit/replace","PUT",replace);assert.equal(changed.status,200,JSON.stringify(changed.body));assert.equal(changed.body.url,uploaded.body.url);
  const before=calls.filter(call=>call.method==="DELETE").length;assert.ok((await request("/imagekit/delete","DELETE",{fileId:"fixture-image"},other)).status>=400);assert.equal(calls.filter(call=>call.method==="DELETE").length,before);
  assert.equal((await request("/imagekit/delete","DELETE",{fileId:"fixture-image"})).status,200);
  const bad=new FormData();bad.set("file",new Blob(["not an image"],{type:"image/png"}),"bad.png");assert.equal((await request("/imagekit/upload","POST",bad)).status,400);
  globalThis.fetch=realFetch;
 });
 await t.test("marketplace products and other seller tools remain independent",async()=>{assert.deepEqual(await(await realFetch(runtime.url+"/api/products")).json(),marketplace);assert.equal((await realFetch(runtime.url+prefix+"/categories",{headers:{Cookie:cookie,Origin:"https://untrusted.invalid"},method:"POST",body:"{}"})).status,403);});
});
