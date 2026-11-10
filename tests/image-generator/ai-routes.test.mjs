import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import sharp from "sharp";
import { HAND_REVIEW_CHECKS } from "../../src/tools/image-generator/lib/charm-hand-composition.mjs";

// Execute the real Next route functions in memory with mocked provider HTTP.
// This covers upload handling, image finishing and the three/four-image contract
// without a browser, listener, real credentials, or paid generation calls.
const root = join(process.cwd(), "src/tools/image-generator");
const modules = new Map();
function loadSource(filename) {
  const path = resolve(filename);
  if (modules.has(path)) return modules.get(path).exports;
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = new Module(path);
  loaded.filename = path;
  loaded.paths = Module._nodeModulePaths(dirname(path));
  const nativeRequire = createRequire(path);
  loaded.require = (specifier) => specifier.startsWith("@/")
    ? loadSource(join(root, `${specifier.slice(2)}.mjs`))
    : specifier.startsWith(".") ? loadSource(resolve(dirname(path), specifier)) : nativeRequire(specifier);
  modules.set(path, loaded);
  loaded._compile(compiled, path);
  return loaded.exports;
}

const coverRoute = loadSource(join(root, "app/api/generate/route.mjs"));
const charmRoute = loadSource(join(root, "app/api/generate-charms/route.mjs"));
const providersRoute = loadSource(join(root, "app/api/providers/route.mjs"));
const packRoute = loadSource(join(root, "app/api/generate-charm-pack/route.mjs"));
const packGeneration = loadSource(join(root, "lib/charm-pack-generation.mjs"));
const packOptions = loadSource(join(root, "lib/charm-pack-options.mjs"));
const packTag = loadSource(join(root, "lib/charm-pack-tag.mjs"));
const fixture = await sharp({ create: { width: 128, height: 128, channels: 4, background: { r: 210, g: 80, b: 110, alpha: 1 } } }).png().toBuffer();
const phoneFixture = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#00ff00"/><rect x="38" y="8" width="52" height="112" rx="5" fill="#d2506e"/></svg>')).png().toBuffer();
const allPassing = JSON.stringify({ checks: Object.fromEntries(HAND_REVIEW_CHECKS.map((key) => [key, true])), issues: [] });

async function withProviderMocks(operation, responder) {
  const originalFetch = globalThis.fetch;
  const keys = ["GEMINI_API_KEY", "OPENAI_API_KEY", "GEMINI_CONTENT_MODEL", "GEMINI_IMAGE_MODEL", "OPENAI_CONTENT_MODEL", "OPENAI_IMAGE_MODEL", "OPENAI_IMAGE_QUALITY", "GEMINI_IMAGE_SIZE", "GEMINI_REFERENCE_MAX_EDGE", "GEMINI_ANALYSIS_MAX_EDGE", "GEMINI_MAX_OUTPUT_TOKENS", "OPENAI_REFERENCE_MAX_EDGE", "OPENAI_ANALYSIS_MAX_EDGE", "OPENAI_MAX_OUTPUT_TOKENS"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.GEMINI_API_KEY = "gemini-route-test";
  process.env.OPENAI_API_KEY = "openai-route-test";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const isGemini = String(url).includes("generativelanguage.googleapis.com");
    const request = init.body instanceof FormData ? null : JSON.parse(init.body);
    const isImage = init.body instanceof FormData || request?.generationConfig?.responseModalities?.includes("IMAGE");
    const texts = isGemini ? request.contents.flatMap((entry) => entry.parts).filter((part) => part.text).map((part) => part.text).join("\n")
      : isImage ? init.body.get("prompt") : request.input.flatMap((entry) => entry.content).filter((part) => part.text).map((part) => part.text).join("\n");
    const call = { url, init, isImage, isGemini, texts };
    calls.push(call);
    const customResponse = responder ? await responder(call) : undefined;
    if (customResponse) return customResponse;
    const imageFixture = texts.includes("ISOLATED_PHONE_PLATE") ? phoneFixture : fixture;
    if (isImage) return Response.json(isGemini
      ? { candidates: [{ content: { parts: [{ inlineData: { data: imageFixture.toString("base64"), mimeType: "image/png" } }] } }] }
      : { data: [{ b64_json: imageFixture.toString("base64") }] });
    const text = texts.includes("COVER_IDENTITY_REVIEW") ? JSON.stringify({ designMatches: true, cameraMatches: true, fitMatches: true, edgeArtworkMatches: true, compositionMatches: true, issues: [] }) : texts.includes("attachmentConnected") ? allPassing : texts.includes("Return exactly PASS") ? "PASS" : "Preserve the uploaded artwork, camera opening, proportions and complete charm inventory.";
    return Response.json(isGemini ? { candidates: [{ content: { parts: [{ text }] } }] }
      : { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }] });
  };
  try { return await operation(calls); }
  finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function upload(provider, charms = false, view = "all") {
  const form = new FormData();
  form.set("provider", provider);
  form.set("view", view);
  form.set(charms ? "cover" : "image", new File([fixture], "cover.png", { type: "image/png" }));
  if (charms) form.set("charm", new File([fixture], "charm.png", { type: "image/png" }));
  return new Request(`http://localhost/api/${charms ? "generate-charms" : "generate"}`, { method: "POST", body: form });
}

test("both real generation routes use the selected provider for every analysis, image and review", async () => {
  for (const provider of ["gemini", "openai"]) {
    for (const charms of [false, true]) {
      await withProviderMocks(async (calls) => {
        const response = await (charms ? charmRoute : coverRoute).POST(upload(provider, charms));
        const payload = await response.json();
        assert.equal(response.status, 200, payload.error);
        assert.equal(payload.provider, provider);
        assert.equal(payload.images.length, charms ? 3 : 4);
        assert.equal(payload.images[0].templateId, "hand-closeup");
        assert.ok(payload.images.every((image) => image.dataUrl.startsWith("data:image/png;base64,") && image.mimeType === "image/png"));
        assert.equal(calls.filter((call) => call.isImage).length, charms ? 3 : 4);
        assert.ok(calls.every((call) => call.isGemini === (provider === "gemini")));
        assert.ok(calls.every((call) => provider === "gemini"
          ? call.init.headers["x-goog-api-key"] === "gemini-route-test"
          : call.init.headers.Authorization === "Bearer openai-route-test"));
        if (charms) {
          assert.ok(calls.some((call) => call.texts.includes("attachmentConnected")), "attachment checks must use the selected provider too");
          assert.equal(calls.filter((call) => !call.isImage && call.texts.includes("attachmentConnected")).length, 2, "both combined views must be reviewed");
          for (const call of calls.filter((call) => call.isImage)) {
            const references = call.isGemini ? JSON.parse(call.init.body).contents[0].parts.filter((part) => part.inlineData).length : call.init.body.getAll("image[]").length;
            assert.equal(references, call.texts.includes("catalog photograph") ? 1 : 2, "use raw uploads only, never template or generated identity references");
            assert.ok(!call.texts.includes("IMMUTABLE") && !call.texts.includes("IMAGE 4"));
          }
        }
      });
    }
  }
});

test("a selected cover view generates exactly one image with either provider", async () => {
  for (const provider of ["gemini", "openai"]) {
    for (const view of ["hand-closeup", "drop-protection", "model-selfie", "three-cases"]) {
      await withProviderMocks(async (calls) => {
        const response = await coverRoute.POST(upload(provider, false, view));
        const payload = await response.json();
        assert.equal(response.status, 200, payload.error);
        assert.deepEqual(payload.images.map((image) => image.templateId), [view]);
        assert.equal(calls.filter((call) => call.isImage).length, 1);
        assert.equal(calls.filter((call) => !call.isImage).length, 2, "one product analysis and one artwork/camera check");
      });
    }
  }
});

test("both providers replace phones ONLY in the four requested template-folder scenes",async()=>{
  const {COVER_LAYOUTS}=loadSource(join(root,'lib/cover-layouts.mjs'));
  const {prepareCoverTemplate}=loadSource(join(root,'lib/cover-template.mjs'));
  const expected=await Promise.all(COVER_LAYOUTS.map(async layout=>{
    const source=readFileSync(join(process.cwd(),'public',layout.file));
    const {width,height}=await sharp(source).metadata(),size=Math.max(width,height);
    const padded=await sharp(source).rotate().ensureAlpha().extend({left:Math.floor((size-width)/2),right:Math.ceil((size-width)/2),top:Math.floor((size-height)/2),bottom:Math.ceil((size-height)/2),background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
    return {layout,reference:await sharp(padded).resize(1080,1080).toColourspace('srgb').ensureAlpha().raw().toBuffer(),prepared:await prepareCoverTemplate(source,layout.id)};
  }));
  for(const provider of ['gemini','openai'])await withProviderMocks(async calls=>{
    const response=await coverRoute.POST(coverSelections(provider,COVER_LAYOUTS.map(layout=>layout.id),'iphone-13-pro-max'));
    const payload=await response.json();
    assert.equal(response.status,200,payload.error);
    assert.equal(payload.images.length,4);
    for(const {layout,reference,prepared}of expected){
    const image=payload.images.find(image=>image.templateId===layout.id);
    assert.equal(image.renderMode,'template');
    assert.equal(image.referenceLocked,true);
    assert.equal(image.referenceImage,'/'+layout.file);
    const result=await sharp(Buffer.from(image.dataUrl.split(',')[1],'base64')).ensureAlpha().raw().toBuffer();
    let protectedCount=0;
    for(let p=0;p<prepared.editMask.length;p++)if(prepared.editMask[p]===0){
      protectedCount++;
      for(let c=0;c<4;c++)assert.equal(result[p*4+c],reference[p*4+c],layout.id+': route must use the template-folder scene, without an example fallback or AI redraw');
    }
    assert.ok(protectedCount>500_000);
    }
    assert.equal(calls.length,9,'four phone renders + one analysis + four reviews, no automatic retry/upgrade');
    for(const call of calls.filter(call=>call.isImage)){
    assert.match(call.texts,/ISOLATED_PHONE_PLATE/);
    assert.match(call.texts,/exactly 3 rear camera lenses/);
    const references=call.isGemini?JSON.parse(call.init.body).contents[0].parts.filter(part=>part.inlineData).length:call.init.body.getAll('image[]').length;
    assert.equal(references,1,'keep the original portrait local; only raw artwork is sent for phone generation');
    if(provider==='openai'){
      assert.equal(call.init.body.get('model'),'gpt-image-2.5-flare');
      assert.equal(call.init.body.get('quality'),'low');
    }
    }
  });
});

test("invalid cover views make no paid calls; omitting view preserves the full-set contract", async () => {
  await withProviderMocks(async (calls) => {
    assert.equal((await coverRoute.POST(upload("openai", false, "unknown"))).status, 400);
    assert.equal(calls.length, 0);
    const form = new FormData();
    form.set("provider", "openai");
    form.set("image", new File([fixture], "cover.png", { type: "image/png" }));
    const response = await coverRoute.POST(new Request("http://localhost/api/generate", { method: "POST", body: form }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).images.length, 4);
    assert.equal(calls.filter((call) => call.isImage).length, 4);
  });
});

function coverSelections(provider, views, phoneModel) {
  const form = new FormData();
  form.set("provider", provider);
  form.set("views", typeof views === "string" ? views : JSON.stringify(views));
  if (phoneModel !== undefined) form.set("phoneModel", phoneModel);
  form.set("image", new File([fixture], "cover.png", { type: "image/png" }));
  return new Request("http://localhost/api/generate", { method: "POST", body: form });
}

async function withFields(request, fields) {
  const form=await request.formData();
  for (const [name,value] of Object.entries(fields)) {
    form.delete(name);
    for (const entry of Array.isArray(value)?value:[value]) form.append(name,entry);
  }
  return new Request(request.url,{method:"POST",body:form});
}

test("selfie prompts require an installed opaque phone and a see-through shell is kept as a flagged draft", async()=>{
  await withProviderMocks(async(calls)=>{
    const response=await coverRoute.POST(await withFields(coverSelections("openai",["model-selfie"],"iphone-13"),{renderMode:"full-ai"}));
    const payload=await response.json();
    assert.equal(response.status,200);
    const render=calls.find(call=>call.isImage);
    assert.match(render.texts,/PHONE_BODY_REQUIRED/);
    assert.match(render.texts,/OPAQUE phone back filling the entire case interior/);
    assert.match(render.texts,/must NOT be visible through the phone back/);
    assert.equal(render.init.body.get("model"),"gpt-image-2.5-flare");
    assert.equal(render.init.body.get("quality"),"low");
    assert.match(calls.find(call=>call.texts.includes("COVER_IDENTITY_REVIEW")).texts,/EMPTY SEE-THROUGH CASE/);
    assert.equal(payload.images[0].verified,false);
    assert.equal(payload.images[0].review.status,"mismatch");
    assert.equal(calls.filter(call=>call.isImage).length,1,"do not silently pay for a repair");
  },call=>call.texts.includes("COVER_IDENTITY_REVIEW")?Response.json({status:"completed",output:[{content:[{type:"output_text",text:JSON.stringify({designMatches:true,cameraMatches:true,fitMatches:false,edgeArtworkMatches:true,compositionMatches:false,issues:["The room is visible through an empty lower case instead of an installed phone."]})}]}]}):undefined);
});

test("Flare low selfie uses a fitted hardware guide and flags an oversized case without a paid retry", async()=>{
  await withProviderMocks(async(calls)=>{
    const response=await coverRoute.POST(await withFields(coverSelections("openai",["model-selfie"],"iphone-13"),{renderMode:"full-ai"}));
    const payload=await response.json();
    assert.equal(response.status,200);
    const render=calls.find(call=>call.isImage);
    assert.equal(render.init.body.get("model"),"gpt-image-2.5-flare");
    assert.equal(render.init.body.get("quality"),"low");
    assert.match(render.texts,/SNUG_CASE_FIT/);
    assert.match(render.texts,/96%/);
    assert.match(render.texts,/FITTED HARDWARE AND COMPOSITION GUIDE/);
    assert.ok(!render.texts.includes("phone is intentionally blank"));
    const guide=Buffer.from(await render.init.body.getAll("image[]")[1].arrayBuffer());
    const metadata=await sharp(guide).metadata();
    assert.equal(Math.max(metadata.width,metadata.height),512,"do not silently raise Flare scene-input cost");
    const {data,info}=await sharp(guide).removeAlpha().raw().toBuffer({resolveWithObject:true});
    let darkLenses=0;
    // The scene's expected camera island must contain dark fitted hardware,
    // rather than the old entirely pale blank replacement area.
    for(let y=Math.floor(info.height*.05);y<info.height*.15;y++) for(let x=Math.floor(info.width*.32);x<info.width*.42;x++) {
      const p=(y*info.width+x)*3;if(data[p]<70&&data[p+1]<100&&data[p+2]<130)darkLenses++;
    }
    assert.ok(darkLenses>50);
    const review=calls.find(call=>call.texts.includes("COVER_IDENTITY_REVIEW"));
    const body=JSON.parse(review.init.body);
    const refs=body.input[0].content.filter(part=>part.type==="input_image");
    assert.equal(refs.length,3,"raw, whole result and supplemental phone detail in ONE review");
    assert.ok(body.text.format.schema.required.includes("fitMatches"));
    assert.match(review.texts,/Judge completeness\/framing using IMAGE 2 only/);
    assert.equal(payload.images[0].verified,false);
    assert.equal(payload.images[0].review.fitMatches,false);
    assert.equal(payload.images[0].review.status,"mismatch");
    assert.match(payload.images[0].review.issues.join(" "),/size mismatch/);
    assert.equal(calls.filter(call=>call.isImage).length,1);
    assert.equal(calls.length,3,"one analysis, one image, one review; never automatic repair/upgrade");
  },call=>call.texts.includes("COVER_IDENTITY_REVIEW")?Response.json({status:"completed",output:[{content:[{type:"output_text",text:JSON.stringify({designMatches:true,cameraMatches:true,fitMatches:false,edgeArtworkMatches:true,compositionMatches:true,issues:["The opaque handset stops above the case bottom, leaving an empty clear tail."]})}]}]}):undefined);
});

test("raw surface guides reach the bottom and missing edge print stays a draft with both providers",async()=>{
  for(const provider of ["gemini","openai"]) await withProviderMocks(async(calls)=>{
    const response=await coverRoute.POST(await withFields(coverSelections(provider,["model-selfie"],"iphone-13"),{renderMode:"full-ai",image:new File([phoneFixture],"raw-phone.png",{type:"image/png"})}));
    const payload=await response.json();
    assert.equal(response.status,200);
    assert.equal(payload.images[0].artworkGuide,"raw-surface");
    assert.equal(payload.images[0].review.edgeArtworkMatches,false);
    assert.equal(payload.images[0].verified,false);
    assert.equal(payload.images[0].review.status,"mismatch");
    assert.match(payload.images[0].review.issues.join(" "),/white footer/);
    assert.ok(payload.images[0].dataUrl.startsWith("data:image/png;base64,"),"keep the paid draft downloadable");
    const render=calls.find(call=>call.isImage);
    assert.match(render.texts,/FULL_SURFACE_ARTWORK/);
    assert.match(render.texts,/locally projected preview of YOUR raw case artwork/);
    assert.match(render.texts,/bottom-edge pink design/);
    assert.match(render.texts,/PRODUCT_PHOTOGRAPHY/);
    assert.match(render.texts,/CLEAR_CASE_FINISH/);
    assert.match(render.texts,/luminous pearl-white/);
    assert.match(render.texts,/REFERENCE_SCALE_LOCK/);
    assert.match(render.texts,/49-55%/);
    assert.match(render.texts,/normal-width/);
    const refs=render.isGemini?JSON.parse(render.init.body).contents[0].parts.filter(part=>part.inlineData):render.init.body.getAll("image[]");
    assert.equal(refs.length,2,"reuse existing reference count; no extra generation");
    if(!render.isGemini){assert.equal(render.init.body.get("model"),"gpt-image-2.5-flare");assert.equal(render.init.body.get("quality"),"low");}
    const review=calls.find(call=>call.texts.includes("COVER_IDENTITY_REVIEW"));
    assert.match(review.texts,/edgeArtworkMatches/);
    assert.match(review.texts,/genuinely clear area/);
    assert.equal(calls.filter(call=>call.isImage).length,1);
    assert.equal(calls.length,3,"one analysis + one render + one review, without paid repair");
  },call=>{
    if(call.isImage)return;
    const text=call.texts.includes("COVER_IDENTITY_REVIEW")?JSON.stringify({designMatches:true,cameraMatches:true,fitMatches:true,edgeArtworkMatches:false,compositionMatches:true,issues:["The lower printed area is replaced by a white strip."]}):JSON.stringify({designSummary:"Pink case",visibleText:[],productBounds:[60,290,940,710],surfaceQuad:[[299,63],[701,63],[701,937],[299,937]],lowerArtwork:"bottom-edge pink design reaches the bumper",backMaterial:"clear"});
    return Response.json(call.isGemini?{candidates:[{content:{parts:[{text}]}}]}:{status:"completed",output:[{content:[{type:"output_text",text}]}]});
  });
});

test("both providers support explicit high-quality full-scene rendering for every cover layout", async () => {
  for (const provider of ["gemini","openai"]) {
    await withProviderMocks(async(calls)=>{
      const response=await coverRoute.POST(await withFields(coverSelections(provider,["hand-closeup","drop-protection","model-selfie","three-cases"],"iphone-13-pro-max"),{qualityTier:"quality",renderMode:"full-ai"}));
      const payload=await response.json();
      assert.equal(response.status,200,payload.error);
      assert.equal(payload.images.length,4);
      assert.equal(payload.qualityTier,"quality");
      assert.equal(payload.renderMode,"full-ai");
      const expected=provider==="gemini"?"gemini-3-pro-image":"gpt-image-2.5-flare";
      assert.equal(payload.imageModel,expected);
      assert.ok(payload.images.every(image=>image.qualityTier==="quality"&&image.imageModel===expected&&image.renderMode==="full-ai"&&image.verified));
      const renders=calls.filter(call=>call.isImage);
      assert.equal(renders.length,4,"one image per checked view, never automatic redraws");
      assert.equal(calls.length,9,"one shared analysis + four renders + four checks");
      for(const call of renders) {
        assert.match(call.texts,/FULL_AI_SCENE/);
        assert.match(call.texts,/PRODUCT_PHOTOGRAPHY/);
        assert.match(call.texts,/REFERENCE_SCALE_LOCK/);
        assert.match(call.texts,/Do not whiten a genuinely gray, black or colored back/);
        assert.ok(!call.texts.includes("CLEAR_CASE_FINISH"),"unknown material cannot silently become a white clear case");
        assert.ok(!call.texts.includes("ISOLATED_PHONE_PLATE"));
        assert.match(call.texts,/exactly 3 rear camera lenses/);
        if(call.isGemini) {
          assert.match(call.url,/gemini-3-pro-image:generateContent$/);
          const sent=JSON.parse(call.init.body);
          assert.equal(sent.contents[0].parts.filter(part=>part.inlineData).length,2,"raw product first, sanitized scene guide second");
          assert.equal(sent.generationConfig.responseFormat.image.imageSize,"IMAGE_SIZE_TWO_K");
          assert.ok(!sent.generationConfig.responseFormat.image.background);
        } else {
          assert.equal(call.init.body.get("model"),expected);
          assert.equal(call.init.body.get("quality"),"low");
          assert.equal(call.init.body.getAll("image[]").length,2);
          assert.equal(call.init.body.get("background"),call.texts.includes("OUTPUT_VIEW: hand-closeup")?"transparent":"opaque");
        }
      }
      assert.equal(payload.images[0].backgroundReady,true);
    },(call)=>call.isImage&&call.texts.includes("FULL_AI_SCENE")?Response.json(call.isGemini?{candidates:[{content:{parts:[{inlineData:{data:phoneFixture.toString("base64"),mimeType:"image/png"}}]}}]}:{data:[{b64_json:phoneFixture.toString("base64")}]}):undefined);
  }
});

test("full-AI hand without transparency is kept as an explicit draft, not silently masked or billed again", async()=>{
  await withProviderMocks(async(calls)=>{
    const response=await coverRoute.POST(await withFields(upload("gemini",false,"hand-closeup"),{renderMode:"full-ai"}));
    const payload=await response.json();
    assert.equal(response.status,200);
    assert.equal(payload.images.length,1);
    assert.equal(payload.images[0].verified,false);
    assert.equal(payload.images[0].review.status,"needs-review");
    assert.equal(payload.images[0].backgroundReady,false);
    assert.match(payload.images[0].review.issues.join(" "),/backdrop/);
    assert.equal(calls.filter(call=>call.isImage).length,1);
  });
});

test("invalid or duplicate quality/render/provider selections cannot start paid calls",async()=>{
  await withProviderMocks(async(calls)=>{
    for(const fields of [{qualityTier:"max"},{qualityTier:["economy","quality"]},{provider:["gemini","openai"]},{renderMode:"unknown"},{renderMode:["template","full-ai"]}]) {
      const response=await coverRoute.POST(await withFields(upload("gemini",false,"hand-closeup"),fields));
      assert.equal(response.status,400,JSON.stringify(fields));
    }
    assert.equal(calls.length,0);
  });
});

test("shared higher-model selection reaches attached-charm and pack generation with both providers", async()=>{
  for(const provider of ["gemini","openai"]) {
    await withProviderMocks(async(calls)=>{
      const charmResponse=await charmRoute.POST(await withFields(upload(provider,true,"hand-closeup"),{qualityTier:"quality"}));
      assert.equal(charmResponse.status,200,JSON.stringify(await charmResponse.json()));
      const form=new FormData();
      form.set("provider",provider);form.set("qualityTier","quality");form.set("quantity","5");form.set("view","pack-fan");form.set("image",new File([fixture],"pack.png",{type:"image/png"}));
      const packResponse=await packRoute.POST(new Request("http://localhost/api/generate-charm-pack",{method:"POST",body:form}));
      assert.equal(packResponse.status,200,JSON.stringify(await packResponse.json()));
      for(const call of calls.filter(call=>call.isImage)) {
        if(provider==="gemini")assert.match(call.url,/gemini-3-pro-image:generateContent$/);
        else {assert.equal(call.init.body.get("model"),"gpt-image-2.5-flare");assert.equal(call.init.body.get("quality"),"low");}
      }
    },call=>packReviewResponse(call,5));
  }
});

test("checkbox subsets generate only selected references in stable template order for both providers", async () => {
  const templateOrder = ["hand-closeup", "drop-protection", "model-selfie", "three-cases"];
  for (const provider of ["gemini", "openai"]) {
    for (const selected of [
      ["three-cases", "drop-protection"],
      ["three-cases", "hand-closeup", "model-selfie"],
      [...templateOrder].reverse(),
    ]) {
      await withProviderMocks(async (calls) => {
        const response = await coverRoute.POST(coverSelections(provider, selected));
        const payload = await response.json();
        assert.equal(response.status, 200, payload.error);
        assert.deepEqual(payload.images.map((image) => image.templateId), templateOrder.filter((id) => selected.includes(id)));
        assert.equal(calls.filter((call) => call.isImage).length, selected.length, "no unchecked layout may be generated");
        assert.equal(calls.filter((call) => !call.isImage && !call.texts.includes("COVER_IDENTITY_REVIEW")).length, 1, "share one product analysis across checked layouts");
        assert.equal(calls.filter((call) => call.texts.includes("COVER_IDENTITY_REVIEW")).length, selected.length);
        assert.ok(calls.every((call) => call.isGemini === (provider === "gemini")));
      });
    }
  }
});

test("empty, malformed, duplicate and invalid checkbox selections make zero paid calls", async () => {
  await withProviderMocks(async (calls) => {
    for (const invalid of [[], ["unknown"], ["all"], ["hand-closeup", "unknown"], ["hand-closeup", "hand-closeup"], ["hand-closeup", "drop-protection", "model-selfie", "three-cases", "unknown"], [1], [null], null, {}, "", "not-json", '"hand-closeup"']) {
      const response = await coverRoute.POST(coverSelections("openai", invalid));
      assert.equal(response.status, 400, JSON.stringify(invalid));
    }
    const repeated = new FormData();
    repeated.set("provider", "openai");
    repeated.append("views", '["hand-closeup"]');
    repeated.append("views", '["three-cases"]');
    assert.equal((await coverRoute.POST(new Request("http://localhost/api/generate", { method: "POST", body: repeated }))).status, 400);
    assert.equal(calls.length, 0);
  });
});

test("an explicit one-item checkbox selection never falls back to all views", async () => {
  await withProviderMocks(async (calls) => {
    const response = await coverRoute.POST(coverSelections("openai", ["model-selfie"]));
    const payload = await response.json();
    assert.equal(response.status, 200, payload.error);
    assert.deepEqual(payload.images.map((image) => image.templateId), ["model-selfie"]);
    assert.equal(calls.filter((call) => call.isImage).length, 1);
  });
});

test("route validation and a missing selected key make zero provider calls", async () => {
  await withProviderMocks(async (calls) => {
    for (const route of [coverRoute, charmRoute]) {
      const invalid = await route.POST(upload("invalid", route === charmRoute));
      assert.equal(invalid.status, 400);
      delete process.env.OPENAI_API_KEY;
      const missing = await route.POST(upload("openai", route === charmRoute));
      assert.equal(missing.status, 503);
      assert.match((await missing.json()).error, /OPENAI_API_KEY/);
    }
    assert.equal(calls.length, 0);
    const response = await providersRoute.GET();
    const options = (await response.json()).providers;
    assert.equal(options.find((option) => option.id === "gemini").available, true);
    assert.equal(options.find((option) => option.id === "openai").available, false);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.ok(!JSON.stringify(options).includes("gemini-route-test"));
  });
});

test("credential and quota errors during analysis stop before any image generation", async () => {
  for (const status of [401, 429]) {
    for (const charms of [false, true]) {
      await withProviderMocks(async (calls) => {
        const response = await (charms ? charmRoute : coverRoute).POST(upload("openai", charms));
        assert.equal(response.status, status);
        assert.ok(calls.every((call) => !call.isImage));
        assert.ok(!JSON.stringify(await response.json()).includes("openai-route-test"));
      }, () => Response.json({ error: { message: "Invalid credentials or insufficient quota: openai-route-test" } }, { status }));
    }
  }
});

test("an inaccessible image model stops the cover workflow before its next image batch", async () => {
  await withProviderMocks(async (calls) => {
    const response = await coverRoute.POST(upload("openai"));
    assert.equal(response.status, 404);
    assert.equal(calls.filter((call) => call.isImage).length, 2);
  }, (call) => call.isImage
    ? Response.json({ error: { message: "Image model unavailable" } }, { status: 404 })
    : Response.json({ status: "completed", output: [{ content: [{ type: "output_text", text: "Cover identity" }] }] }));
});

test("a failed charm attachment preserves the other views and retry renders only that view", async () => {
  let rejectHand = true;
  await withProviderMocks(async (calls) => {
    const response = await charmRoute.POST(upload("openai", true));
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.complete, false);
    assert.deepEqual(payload.images.map((image) => image.templateId), ["charm-product-flatlay", "charm-only"]);
    assert.equal(payload.failures.length, 1);
    assert.equal(payload.failures[0].viewId, "hand-closeup");
    assert.match(payload.failures[0].message, /attachment repair/);
    assert.ok(!payload.failures[0].message.includes("connectedAtCaseBottom"));
    const before = calls.length;
    rejectHand = false;
    const retry = await charmRoute.POST(upload("openai", true, "hand-closeup"));
    const repaired = await retry.json();
    assert.equal(retry.status, 200);
    assert.equal(repaired.complete, true);
    assert.deepEqual(repaired.images.map((image) => image.templateId), ["hand-closeup"]);
    assert.equal(calls.slice(before).filter((call) => call.isImage).length, 1, "do not regenerate successful flatlay or charm-only views");
  }, (call) => {
    if (rejectHand && !call.isImage && call.texts.includes("attachmentConnected") && call.texts.includes("Hand, cover & charm")) {
      const review = { checks: Object.fromEntries(HAND_REVIEW_CHECKS.map((key) => [key, key !== "attachmentConnected"])), issues: ["Close the visible gap between the actual clasp and case tab."] };
      return Response.json({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(review) }] }] });
    }
  });
});

test("charm-only retry uses one product analysis and one image, with no cover generation", async () => {
  await withProviderMocks(async (calls) => {
    const response = await charmRoute.POST(upload("openai", true, "charm-only"));
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.images.map((image) => image.templateId), ["charm-only"]);
    assert.equal(calls.filter((call) => call.isImage).length, 1);
    assert.equal(calls.filter((call) => !call.isImage).length, 1);
    const before = calls.length;
    const invalid = await charmRoute.POST(upload("openai", true, "invalid-view"));
    assert.equal(invalid.status, 400);
    assert.equal(calls.length, before);
  });
});

function packUpload(provider, quantity = "5", view = "all", file = new File([fixture], "raw.png", { type: "image/png" }), showQuantity) {
  const form = new FormData();
  form.set("provider", provider);
  if (quantity !== null) form.set("quantity", quantity);
  if (showQuantity !== undefined) form.set("showQuantity", String(showQuantity));
  form.set("view", view);
  if (file !== null) form.set("image", file);
  return new Request("http://localhost/api/generate-charm-pack", { method: "POST", body: form });
}

function packReviewResponse(call, count) {
  if (call.isImage || !call.texts.includes("visiblePieceCount")) return;
  const text = JSON.stringify({ visiblePieceCount: count, matchesProduct: true, allPiecesVisible: true, badgeAreaClear: true, issues: [] });
  return Response.json(call.isGemini ? { candidates: [{ content: { parts: [{ text }] } }] }
    : { status: "completed", output: [{ content: [{ type: "output_text", text }] }] });
}

test("pack generation uses one upload, selected provider, requested quantity and two untagged originals", async () => {
  for (const [provider, quantity] of [["gemini", 5], ["openai", 10]]) {
    await withProviderMocks(async (calls) => {
      const response = await packRoute.POST(packUpload(provider, String(quantity)));
      const payload = await response.json();
      assert.equal(response.status, 200, payload.error);
      assert.equal(payload.complete, true);
      assert.equal(payload.quantity, quantity);
      assert.equal(payload.showQuantity, false, "generation always returns clean originals");
      assert.ok(payload.images.every((image) => image.showQuantity === false));
      assert.deepEqual(payload.images.map((image) => image.templateId), ["pack-fan", "pack-palm"]);
      assert.ok(calls.every((call) => call.isGemini === (provider === "gemini")));
      assert.equal(calls.length, 5, "one shared analysis, two renders and two reviews");
      for (const call of calls.filter((item) => item.isImage)) {
        assert.match(call.texts, new RegExp(`EXACTLY ${quantity} identical whole units`));
        assert.match(call.texts, /Silver stays silver/);
      }
      const result = Buffer.from(payload.images[0].dataUrl.split(",")[1], "base64");
      const metadata = await sharp(result).metadata();
      assert.equal(metadata.width, 1080);
      assert.equal(metadata.height, 1080);
      const actual = await sharp(result).removeAlpha().raw().toBuffer();
      const expected = await sharp(await packGeneration.normalizePackImage(fixture)).removeAlpha().raw().toBuffer();
      assert.deepEqual(actual, expected);
      // Both the review and returned image remain untagged.
      const reviewCall = calls.find((call) => call.texts.includes("visiblePieceCount"));
      const body = JSON.parse(reviewCall.init.body);
      const preview = provider === "gemini" ? body.contents[0].parts.at(-1).inlineData.data
        : body.input[0].content.at(-1).image_url.split(",")[1];
      const previewBuffer = Buffer.from(preview, "base64");
      const previewMetadata = await sharp(previewBuffer).metadata();
      assert.ok(previewMetadata.width <= 512 && previewMetadata.height <= 512);
      const sample = await sharp(previewBuffer).extract({ left: Math.floor(previewMetadata.width * .7), top: Math.floor(previewMetadata.height * .15), width: 1, height: 1 }).removeAlpha().raw().toBuffer();
      // Compact JPEG review images may round a color channel by a tiny amount.
      assert.ok([...sample].every((channel, index) => Math.abs(channel - [210, 80, 110][index]) <= 2));
    }, (call) => packReviewResponse(call, quantity));
  }
});

test("both providers support untagged pack images and single-view retries without changing the count", async () => {
  for (const provider of ["gemini", "openai"]) {
    await withProviderMocks(async (calls) => {
      const response = await packRoute.POST(packUpload(provider, "10", "all", undefined, false));
      const payload = await response.json();
      assert.equal(response.status, 200, payload.error);
      assert.equal(payload.showQuantity, false);
      assert.equal(payload.quantity, 10);
      assert.equal(payload.images.length, 2);
      const expected = await sharp(await packGeneration.normalizePackImage(fixture)).removeAlpha().raw().toBuffer();
      for (const image of payload.images) {
        assert.equal(image.showQuantity, false);
        const actual = await sharp(Buffer.from(image.dataUrl.split(",")[1], "base64")).removeAlpha().raw().toBuffer();
        assert.deepEqual(actual, expected, "no badge or lettering is composited onto an untagged image");
      }
      for (const call of calls.filter((item) => item.isImage)) {
        assert.match(call.texts, /EXACTLY 10 identical whole units/);
        assert.match(call.texts, /Return an untagged photograph/);
        assert.match(call.texts, /optionally add a quantity tag AFTER generation/);
      }
      assert.ok(calls.filter((item) => item.texts.includes("visiblePieceCount")).every((call) => call.texts.includes("no products, fingers, badge or label placeholder")));
      const before = calls.length;
      const retry = await packRoute.POST(packUpload(provider, "10", "pack-palm", undefined, false));
      const retried = await retry.json();
      assert.equal(retry.status, 200);
      assert.equal(retried.images[0].showQuantity, false);
      assert.equal(calls.slice(before).filter((call) => call.isImage).length, 1);
    }, (call) => packReviewResponse(call, 10));
  }
});

test("legacy tagged requests still return untagged originals and invalid options make zero AI calls", async () => {
  await withProviderMocks(async (calls) => {
    for (const invalid of ["", "yes", "0", "TRUE"]) {
      assert.equal((await packRoute.POST(packUpload("openai", "5", "all", undefined, invalid))).status, 400);
    }
    assert.equal(calls.length, 0);
    const response = await packRoute.POST(packUpload("openai", "5", "pack-fan", undefined, true));
    const payload = await response.json();
    assert.equal(response.status, 200, payload.error);
    assert.equal(payload.showQuantity, false);
    const result = Buffer.from(payload.images[0].dataUrl.split(",")[1], "base64");
    assert.deepEqual(await sharp(result).raw().toBuffer(), await sharp(await packGeneration.normalizePackImage(fixture)).raw().toBuffer());
  }, (call) => packReviewResponse(call, 5));
});

test("invalid pack inputs are rejected before contacting a provider", async () => {
  await withProviderMocks(async (calls) => {
    for (const quantity of [null, "", "0", "21", "-1", "5.5", "1e1", "05", "5 Pcs"]) {
      assert.equal((await packRoute.POST(packUpload("openai", quantity))).status, 400, String(quantity));
    }
    assert.equal((await packRoute.POST(packUpload("openai", "5", "unknown"))).status, 400);
    assert.equal((await packRoute.POST(packUpload("openai", "5", "all", null))).status, 400);
    assert.equal((await packRoute.POST(packUpload("openai", "5", "all", new File(["bad"], "a.png", { type: "image/png" })))).status, 415);
    assert.equal((await packRoute.POST(packUpload("openai", "5", "all", new File([fixture], "a.gif", { type: "image/gif" })))).status, 415);
    assert.equal((await packRoute.POST(packUpload("openai", "5", "all", new File([new Uint8Array(10 * 1024 * 1024 + 1)], "a.png", { type: "image/png" })))).status, 413);
    assert.equal(calls.length, 0);
    assert.equal(packOptions.parsePackQuantity("20"), 20);
    assert.equal(packOptions.packQuantityLabel(1), "1 Pc");
  });
});

test("wrong pack count triggers one reviewed repair and never silently passes", async () => {
  let count = 4;
  await withProviderMocks(async (calls) => {
    const failed = await packRoute.POST(packUpload("openai", "5", "pack-fan"));
    const payload = await failed.json();
    assert.equal(failed.status, 502);
    assert.deepEqual(payload.images, []);
    assert.equal(payload.failures[0].viewId, "pack-fan");
    assert.match(payload.error, /exactly 5/);
    assert.equal(calls.filter((call) => call.isImage).length, 2);
    assert.equal(calls.filter((call) => call.texts.includes("visiblePieceCount")).length, 2);
    const before = calls.length;
    count = 5;
    const retry = await packRoute.POST(packUpload("openai", "5", "pack-fan"));
    assert.equal(retry.status, 200);
    assert.deepEqual((await retry.json()).images.map((image) => image.templateId), ["pack-fan"]);
    assert.equal(calls.slice(before).filter((call) => call.isImage).length, 1);
  }, (call) => packReviewResponse(call, count));
});

test("pack partial failures preserve the successful view", async () => {
  let rendered = 0;
  await withProviderMocks(async () => {
    const response = await packRoute.POST(packUpload("gemini", "10"));
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.complete, false);
    assert.equal(payload.images.length, 1);
    assert.equal(payload.failures.length, 1);
  }, (call) => {
    if (call.isImage && ++rendered === 1) return Response.json({ error: { message: "Service unavailable" } }, { status: 503 });
    return packReviewResponse(call, 10);
  });
});

test("pack reviews reject unknown count, incorrect identity, hidden items and obscured badge area", async () => {
  const passing = { visiblePieceCount: 5, matchesProduct: true, allPiecesVisible: true, badgeAreaClear: true, issues: [] };
  for (const bad of [{ visiblePieceCount: -1 }, { matchesProduct: false }, { allPiecesVisible: false }, { badgeAreaClear: false }]) {
    let renders = 0;
    await assert.rejects(packGeneration.generateReviewedPack({ quantity: 5, render: async () => ++renders,
      review: async () => ({ ...passing, ...bad }) }), /clearer 5-piece/);
    assert.equal(renders, 2);
  }
  assert.throws(() => packGeneration.parsePackReview('{"visiblePieceCount":5}'), /incomplete/);
  assert.throws(() => packGeneration.parsePackReview('PASS'), /could not be read/);
});

test("browser tags draw legible quantity text at full image resolution with no server fonts", () => {
  for (const quantity of [1, 5, 10, 20]) {
    const calls = [];
    const context = Object.fromEntries(["save", "restore", "scale", "beginPath", "roundRect", "fill", "fillText"].map((name) => [name, (...args) => calls.push([name, ...args])]));
    packTag.drawPackQuantityTag(context, 1080, 1080, quantity);
    assert.ok(calls.some((call) => call[0] === "fillText" && call[1] === packOptions.packQuantityLabel(quantity)));
    assert.equal(context.font, `700 ${quantity < 10 ? 100 : 88}px Arial, Helvetica, sans-serif`);
    assert.equal(context.fillStyle, "#f00000");
    assert.deepEqual(calls.find((call) => call[0] === "roundRect"), ["roundRect", 596, 98, 388, 186, 34]);
    assert.deepEqual(calls.at(-1), ["restore"]);
  }
  assert.throws(() => packTag.drawPackQuantityTag({}, 1080, 1080, 0), /Invalid pack quantity/);
  assert.throws(() => packTag.drawPackQuantityTag({}, 0, 1080, 5), /Invalid image size/);
});

test("local tag composition retains the original and produces a downloadable PNG without fetch", async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const draws = [];
  const context = Object.fromEntries(["save", "restore", "scale", "beginPath", "roundRect", "fill", "fillText"].map((name) => [name, (...args) => draws.push([name, ...args])]));
  context.drawImage = (...args) => draws.push(["drawImage", ...args]);
  const canvas = { width: 0, height: 0, getContext: () => context, toDataURL: (mime) => { assert.equal(mime, "image/png"); return "data:image/png;base64,tagged"; } };
  class TestImage {
    naturalWidth = 1080;
    naturalHeight = 1080;
    set src(value) { this.source = value; queueMicrotask(() => this.onload()); }
  }
  globalThis.window = { Image: TestImage };
  globalThis.document = { createElement: (name) => { assert.equal(name, "canvas"); return canvas; } };
  globalThis.fetch = () => { throw new Error("Tagging must never make network requests"); };
  try {
    const original = `data:image/png;base64,${fixture.toString("base64")}`;
    assert.equal(await packTag.createTaggedPackImage(original, 10), "data:image/png;base64,tagged");
    assert.equal(draws[0][0], "drawImage");
    assert.equal(draws[0][1].source, original);
    assert.equal(canvas.width, 1080);
    assert.equal(canvas.height, 1080);
    await assert.rejects(packTag.createTaggedPackImage("https://example.com/image.png", 5), /original PNG/);
    canvas.getContext = () => null;
    await assert.rejects(packTag.createTaggedPackImage(original, 5), /browser could not create/);
  } finally {
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  }
});

test("selected iPhone hardware overrides every cover template with either provider", async () => {
  for (const provider of ["gemini", "openai"]) {
    await withProviderMocks(async (calls) => {
      const response = await coverRoute.POST(coverSelections(provider, ["hand-closeup", "drop-protection", "model-selfie", "three-cases"], "iphone-13-pro-max"));
      const payload = await response.json();
      assert.equal(response.status, 200, payload.error);
      assert.equal(payload.complete, true);
      assert.equal(payload.phoneModel.rearCameras, 3);
      assert.ok(payload.images.every(image => image.phoneModelId === "iphone-13-pro-max" && image.rearCameras === 3 && image.verified === true));
      assert.equal(calls.filter(call => call.isImage).length, 4);
      assert.equal(calls.filter(call => call.texts.includes("COVER_IDENTITY_REVIEW")).length, 4);
      for (const call of calls.filter(call => call.isImage)) {
        assert.match(call.texts, /exactly 3 rear camera lenses on EVERY phone/);
        assert.match(call.texts, /ISOLATED_PHONE_PLATE/);
        assert.match(call.texts, /NO HANDS/);
        const refs = call.isGemini ? JSON.parse(call.init.body).contents[0].parts.filter(part=>part.inlineData).length : call.init.body.getAll("image[]").length;
        assert.equal(refs,1,"scene templates must stay local; AI must not redraw their hands");
        assert.match(call.texts, /sole source|ONLY source|SOLE PRODUCT IDENTITY/);
        assert.ok(!call.texts.includes("camera hardware, gray") && !call.texts.includes("camera module, lenses, flash, highlights, shadows, and reflections unchanged"));
      }
    });
  }
});

test("unknown model IDs and unreadable cover files are rejected without spending credits", async () => {
  await withProviderMocks(async (calls) => {
    for (const invalid of ["", "unknown", "iPhone 13 Pro Max", new Blob(["bad"])]) assert.equal((await coverRoute.POST(coverSelections("openai", ["hand-closeup"], invalid))).status,400);
    const form=new FormData();form.set("provider","openai");form.set("phoneModel","iphone-13-pro-max");form.set("views",'["hand-closeup"]');form.set("image",new File(["bad"],"raw.png",{type:"image/png"}));
    assert.equal((await coverRoute.POST(new Request("http://localhost/api/generate",{method:"POST",body:form}))).status,415);
    form.append("phoneModel","iphone-13");
    assert.equal((await coverRoute.POST(new Request("http://localhost/api/generate",{method:"POST",body:form}))).status,400);
    assert.equal(calls.length,0);
  });
});

test("mixed artwork is kept as a flagged draft, good views survive and only the chosen view is retried", async () => {
  let rejectHand=true;
  await withProviderMocks(async(calls)=>{
    const response=await coverRoute.POST(coverSelections("gemini",["hand-closeup","drop-protection"],"iphone-13-pro-max"));
    const payload=await response.json();
    assert.equal(response.status,200);
    assert.equal(payload.complete,true);
    assert.equal(payload.allVerified,false);
    assert.equal(payload.reviewRequired,1);
    assert.deepEqual(payload.images.map(image=>image.templateId),["hand-closeup","drop-protection"]);
    assert.deepEqual(payload.images.map(image=>image.verified),[false,true]);
    assert.equal(payload.images[0].review.status,"mismatch");
    assert.deepEqual(payload.failures,[]);
    assert.equal(calls.filter(call=>call.isImage).length,2,"no automatic paid redraw");
    rejectHand=false;
    const before=calls.length;
    const retry=await coverRoute.POST(coverSelections("gemini",["hand-closeup"],"iphone-13-pro-max"));
    assert.equal(retry.status,200);
    assert.equal((await retry.json()).complete,true);
    assert.equal(calls.slice(before).filter(call=>call.isImage).length,1);
  },call=>{
    if(!call.isImage && call.texts.includes("COVER_IDENTITY_REVIEW") && call.texts.includes("finished Hand close-up") && rejectHand) return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({designMatches:false,cameraMatches:true,fitMatches:true,edgeArtworkMatches:true,compositionMatches:true,issues:["Unwanted template flowers remain"]})}]}}]});
  });
});

test("wrong camera counts and unreadable reviews keep drafts; real render errors show their cause without another paid image", async () => {
  for(const failure of ["wrong-cameras","ambiguous","service-error"]) {
    await withProviderMocks(async(calls)=>{
      const response=await coverRoute.POST(coverSelections("openai",["hand-closeup"],"iphone-13-pro-max"));
      const payload=await response.json();
      if (failure === "service-error") {
        assert.equal(response.status,502);
        assert.deepEqual(payload.images,[]);
        assert.equal(payload.failures[0].viewId,"hand-closeup");
        assert.match(payload.error,/Temporary provider error/);
        assert.ok(!payload.error.includes("No selected view passed"));
      } else {
        assert.equal(response.status,200);
        assert.equal(payload.error,undefined);
        assert.equal(payload.images.length,1);
        assert.equal(payload.images[0].verified,false);
        assert.equal(payload.images[0].review.status,failure === "ambiguous" ? "unavailable" : "mismatch");
        assert.deepEqual(payload.failures,[]);
      }
      assert.equal(calls.filter(call=>call.isImage).length,1);
    },call=>{
      if(failure==="service-error" && call.isImage) return Response.json({error:{message:"Temporary provider error"}},{status:503});
      if(!call.isImage && call.texts.includes("COVER_IDENTITY_REVIEW")) return Response.json({status:"completed",output:[{content:[{type:"output_text",text:failure==="ambiguous"?"PASS":JSON.stringify({designMatches:true,cameraMatches:false,fitMatches:true,edgeArtworkMatches:true,compositionMatches:true,issues:["Two lenses shown instead of three"]})}]}]});
    });
  }
});

test("Gemini uncertainty, token exhaustion and review outages never lose the generated image", async () => {
  for (const scenario of ["uncertain","token-limit","review-quota","bad-json"]) {
    await withProviderMocks(async(calls)=>{
      const response=await coverRoute.POST(coverSelections("gemini",["model-selfie"],"iphone-13-pro-max"));
      const payload=await response.json();
      assert.equal(response.status,200);
      assert.equal(payload.images.length,1);
      assert.equal(payload.images[0].verified,false);
      assert.equal(payload.images[0].review.status,scenario === "uncertain" ? "needs-review" : "unavailable");
      assert.equal(payload.reviewRequired,1);
      assert.equal(payload.allVerified,false);
      assert.equal(payload.error,undefined);
      assert.deepEqual(payload.failures,[]);
      assert.equal(calls.filter(call=>call.isImage).length,1);
      assert.equal(calls.length,3,"one analysis, one render, one check; no implicit retry");
    },call=>{
      if (call.isImage || !call.texts.includes("COVER_IDENTITY_REVIEW")) return;
      if (scenario === "review-quota") return Response.json({error:{message:"Review quota exceeded"}},{status:429});
      return Response.json({candidates:[{finishReason:scenario === "token-limit" ? "MAX_TOKENS" : "STOP",content:{parts:[{text:scenario === "bad-json" ? "not JSON" : JSON.stringify({designMatches:true,cameraMatches:null,fitMatches:true,edgeArtworkMatches:true,compositionMatches:true,issues:["Camera island too small to count reliably"]})}]}}]});
    });
  }
});

test("a blocked image request keeps completed siblings and skips later billable renders", async () => {
  await withProviderMocks(async(calls)=>{
    const response=await coverRoute.POST(coverSelections("gemini",["hand-closeup","drop-protection","model-selfie","three-cases"],"iphone-13-pro-max"));
    const payload=await response.json();
    assert.equal(response.status,200);
    assert.deepEqual(payload.images.map(image=>image.templateId),["hand-closeup"]);
    assert.equal(payload.images[0].verified,true);
    assert.deepEqual(payload.failures.map(failure=>failure.viewId),["drop-protection","model-selfie","three-cases"]);
    assert.match(payload.failures[0].message,/quota/);
    assert.match(payload.failures[1].message,/Not generated/);
    assert.equal(calls.filter(call=>call.isImage).length,2);
  },call=>{
    if (call.isImage && call.texts.includes("OUTPUT_VIEW: drop-protection")) return Response.json({error:{message:"Image quota exceeded"}},{status:429});
  });
});

test("cover reviews use structured JSON and the full raw upload, not the analysis crop", async () => {
  for (const provider of ["gemini","openai"]) {
    await withProviderMocks(async(calls)=>{
      const response=await coverRoute.POST(coverSelections(provider,["hand-closeup"],"iphone-13-pro-max"));
      assert.equal(response.status,200);
      for (const call of calls.filter(call=>!call.isImage)) {
        const request=JSON.parse(call.init.body);
        const schema=call.isGemini ? request.generationConfig.responseFormat.text.schema : request.text.format.schema;
        assert.equal(schema.type,"object");
        if (call.texts.includes("COVER_IDENTITY_REVIEW")) {
          assert.deepEqual(schema.properties.cameraMatches.type,["boolean","null"]);
          const rawPart=call.isGemini ? request.contents[0].parts.find(part=>part.inlineData).inlineData.data : request.input[0].content.find(part=>part.type==="input_image").image_url.split(",")[1];
          const metadata=await sharp(Buffer.from(rawPart,"base64")).metadata();
          assert.equal(metadata.width,128);assert.equal(metadata.height,128);
        }
      }
      const render=calls.find(call=>call.isImage);
      const firstRaw=render.isGemini?Buffer.from(JSON.parse(render.init.body).contents[0].parts.find(part=>part.inlineData).inlineData.data,"base64"):Buffer.from(await render.init.body.getAll("image[]")[0].arrayBuffer());
      const rawMetadata=await sharp(firstRaw).metadata();
      assert.deepEqual([rawMetadata.width,rawMetadata.height],[128,128],"unreliable AI bounds must NEVER crop the generation identity reference");
    },call=>{
      if (!call.isImage && !call.texts.includes("COVER_IDENTITY_REVIEW")) {
        const text=JSON.stringify({designSummary:"Pink case",visibleText:[],productBounds:[100,200,900,800]});
        return Response.json(call.isGemini ? {candidates:[{content:{parts:[{text}]}}]} : {status:"completed",output:[{content:[{type:"output_text",text}]}]});
      }
    });
  }
});
