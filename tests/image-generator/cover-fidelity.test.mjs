import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { PHONE_MODELS, getPhoneModel, phoneModelInstruction } from "../../src/tools/image-generator/lib/phone-models.mjs";
import { COVER_LAYOUTS } from "../../src/tools/image-generator/lib/cover-layouts.mjs";
import { assessCoverReview, parseCoverIdentity, parseCoverReview, cropCoverReference } from "../../src/tools/image-generator/lib/cover-identity.mjs";
import { isolatePhonePlate, phoneProjection, prepareCoverTemplate, createFittedPhoneGuide, fitFullAiGuidePhone, findFrontCoverSurface, rectifyCoverArtwork, relightClearArtworkGuide, finishCoverImage, finishFullAiCoverImage, removePhoneKeySpill, refineCutoutEdges } from "../../src/tools/image-generator/lib/cover-template.mjs";

test("full AI finishing preserves its OWN shifted silhouette and enclosed green artwork", async () => {
  for (const background of ["#00ff00", "transparent"]) {
    const generated=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><rect width="1080" height="1080" fill="${background}"/><rect x="50" y="130" width="360" height="760" rx="40" fill="#ee7799"/><rect x="180" y="330" width="30" height="30" fill="#00ff00"/></svg>`)).png().toBuffer();
    const output=await finishFullAiCoverImage(generated,true);
    assert.equal(output.backgroundReady,true);
    const {data,info}=await sharp(output.image).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.deepEqual([info.width,info.height],[1080,1080]);
    assert.equal(data[(200*1080+100)*4+3],255,"left-shifted generated subject must not be cut to the old template's right-side silhouette");
    assert.equal(data[(500*1080+900)*4+3],0,"do not retain the template's old hand/phone");
    assert.deepEqual([...data.subarray((340*1080+190)*4,(340*1080+190)*4+4)],[0,255,0,255]);
  }
});

test("opaque full-AI scenes remain intact; bad hand backdrops are retained without false cutout eligibility", async () => {
  const input=await sharp({create:{width:1080,height:1080,channels:3,background:"#d2506e"}}).png().toBuffer();
  for (const transparent of [false,true]) {
    const output=await finishFullAiCoverImage(input,transparent);
    assert.equal(output.backgroundReady,false);
    const {data}=await sharp(output.image).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.deepEqual([...data.subarray(0,4)],[210,80,110,255]);
    assert.deepEqual([...data.subarray((500*1080+500)*4,(500*1080+500)*4+4)],[210,80,110,255]);
  }
});

test("full-AI non-square outputs fit proportionally without cropping complete products", async () => {
  const input=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="400"><rect width="200" height="400" fill="white"/><rect x="10" y="10" width="180" height="380" fill="red"/></svg>')).png().toBuffer();
  const output=await finishFullAiCoverImage(input,false);
  const {data}=await sharp(output.image).raw().toBuffer({resolveWithObject:true});
  const channels=(await sharp(output.image).metadata()).channels;
  const red=(x,y)=>data[(y*1080+x)*channels]>200&&data[(y*1080+x)*channels+1]<20;
  assert.ok(red(310,45)&&red(765,1035),"both ends remain within the fitted image");
  assert.ok(!red(250,540)&&!red(830,540),"portrait width must not stretch to square");
});

test("iPhone selections have explicit, validated rear-camera layouts", () => {
  assert.equal(new Set(PHONE_MODELS.map(model => model.id)).size, PHONE_MODELS.length);
  assert.equal(getPhoneModel("iphone-13-pro-max").rearCameras, 3);
  assert.equal(getPhoneModel("iphone-13-pro-max").cameraLayout, "triple");
  assert.equal(getPhoneModel("iphone-13").cameraLayout, "dual-diagonal");
  assert.equal(getPhoneModel("iphone-16").cameraLayout, "dual-vertical");
  assert.equal(getPhoneModel("iphone-se-3").rearCameras, 1);
  assert.equal(getPhoneModel(null).id, "iphone-13");
  for (const invalid of ["", "unknown", "iPhone 13 Pro Max", {}, new Blob()]) assert.equal(getPhoneModel(invalid), null);
  assert.match(phoneModelInstruction(getPhoneModel("iphone-13-pro-max")), /exactly 3 rear camera lenses on EVERY phone/);
  assert.match(phoneModelInstruction(getPhoneModel("iphone-13-pro-max")), /triangular/);
  assert.match(phoneModelInstruction(getPhoneModel("iphone-13")), /diagonally/);
});

test("raw identity retains literal spelling and rejects unsafe crop coordinates", async () => {
  const identity = parseCoverIdentity('```json\n{"designSummary":"Red cherries, green stems, fine white dots","visibleText":["Cherry Gurl"],"productBounds":[100,200,900,800]}\n```');
  assert.deepEqual(identity.visibleText, ["Cherry Gurl"]);
  assert.deepEqual(identity.bounds, [100,200,900,800]);
  for (const bounds of [[-1,0,900,900],[0,0,1001,900],[900,0,100,900],[0,0,20,20],[1,2,3]]) assert.equal(parseCoverIdentity(JSON.stringify({productBounds:bounds})).bounds,null);
  assert.deepEqual(parseCoverIdentity("plain identity brief").visibleText,[]);
  const fixture=await sharp({create:{width:1000,height:1000,channels:3,background:"pink"}}).png().toBuffer();
  const cropped=await cropCoverReference(fixture,identity.bounds);
  const metadata=await sharp(cropped).metadata();
  assert.equal(metadata.width,672); assert.equal(metadata.height,896);
  assert.equal(await cropCoverReference(fixture,null),fixture);
});

test("surface analysis preserves the whole bottom and rejects crossed/mirrored/unsafe corners",()=>{
  const quad=[[200,100],[700,100],[700,900],[200,900]];
  const identity=parseCoverIdentity(JSON.stringify({designSummary:"Blossom branches",productBounds:[100,200,750,700],surfaceQuad:quad,lowerArtwork:"Blossoms reach the bottom edge; right lower area is clear."}));
  assert.deepEqual(identity.surfaceQuad,quad);
  assert.deepEqual(identity.bounds,[100,200,900,700],"the crop must include the bottom, not the shorter analysis box");
  assert.match(identity.lowerArtwork,/bottom edge/);
  for(const bad of [[],[[1,2]],[[0,0],[1001,0],[900,900],[0,900]],[[200,100],[700,900],[700,100],[200,900]],[[200,100],[200,900],[700,900],[700,100]],[[200,100],[210,100],[210,110],[200,110]]]) {
    assert.equal(parseCoverIdentity(JSON.stringify({surfaceQuad:bad})).surfaceQuad,null);
  }
  assert.equal(parseCoverIdentity("unstructured description").surfaceQuad,null);
  assert.equal(parseCoverIdentity("{}").lowerArtwork,"");
  assert.equal(parseCoverIdentity("{}").backMaterial,"unknown");
  for(const material of ["clear","opaque"])assert.equal(parseCoverIdentity(JSON.stringify({backMaterial:material})).backMaterial,material);
  for(const material of ["gray",null,{},"CLEAR"])assert.equal(parseCoverIdentity(JSON.stringify({backMaterial:material})).backMaterial,"unknown");
});

test("clear-case lighting cleanup brightens backing without moving print or changing opaque/unknown cases",async()=>{
  const source=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="320"><defs><linearGradient id="shade"><stop stop-color="#8d9694"/><stop offset="1" stop-color="#bdc6c4"/></linearGradient></defs><rect width="160" height="320" fill="url(#shade)"/><rect x="60" y="150" width="25" height="25" fill="#9c1221"/><rect x="40" y="220" width="4" height="4" fill="#282828"/><rect x="55" y="295" width="45" height="25" fill="#9c1221"/><rect x="110" y="180" width="20" height="30" fill="white"/></svg>')).png().toBuffer();
  const snapshot=Buffer.from(source);
  for(const material of ["opaque","unknown"])assert.equal(await relightClearArtworkGuide(source,material),source,"do not whiten intentional dark or uncertain material");
  const cleaned=await relightClearArtworkGuide(source,"clear");
  const {data,info}=await sharp(cleaned).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const before=await sharp(source).ensureAlpha().raw().toBuffer();
  const pixel=(x,y)=>[...data.subarray((y*160+x)*4,(y*160+x)*4+4)];
  assert.deepEqual([info.width,info.height],[160,320]);
  for(const x of [20,135]){
    const rgb=pixel(x,260).slice(0,3);
    assert.ok(Math.min(...rgb)>225,"gray photographic backing should become a luminous neutral base");
    assert.ok(Math.max(...rgb)-Math.min(...rgb)<15,"remove paper color cast rather than intensifying it");
  }
  assert.ok(pixel(70,160)[0]>pixel(70,160)[1]*3,"red motif remains red in the same position");
  assert.ok(pixel(70,310)[0]>pixel(70,310)[1]*3,"bottom print remains present");
  assert.ok(Math.max(...pixel(42,222).slice(0,3))<100,"small dark printed dots are retained");
  assert.deepEqual(pixel(120,190),[255,255,255,255],"do not erase white printed highlights");
  for(let p=3;p<data.length;p+=4)assert.equal(data[p],before[p],"alpha and geometry stay unchanged");
  assert.deepEqual(source,snapshot,"raw source must not be mutated");
});

test("a clear guide without enough neutral backing is not guessed or recolored",async()=>{
  const saturated=await sharp({create:{width:160,height:320,channels:4,background:"#9c1221"}}).png().toBuffer();
  assert.equal(await relightClearArtworkGuide(saturated,"clear"),saturated);
});

test("full-AI selfie guide corrects the narrow plane without changing template geometry or protected nails",async()=>{
  const original=await prepareCoverTemplate(await readFile('public/templates/layout-model-selfie.png'),'model-selfie');
  const maskSnapshot=Buffer.from(original.editMask),quadSnapshot=JSON.stringify(original.planes[0].quad);
  const corrected=await fitFullAiGuidePhone(original,'model-selfie');
  const metrics=quad=>{
    const [tl,tr,br,bl]=quad,top=[(tl[0]+tr[0])/2,(tl[1]+tr[1])/2],bottom=[(bl[0]+br[0])/2,(bl[1]+br[1])/2];
    const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
    return {top,bottom,width:(distance(tl,tr)+distance(bl,br))/2,height:distance(top,bottom)};
  };
  const before=metrics(original.planes[0].quad),after=metrics(corrected.planes[0].quad);
  assert.ok(after.width>before.width*1.1,'phone guide needs normal width, not just a larger narrow phone');
  assert.ok(Math.abs(after.width/after.height-600/1220)<.005);
  for(const key of ['top','bottom'])for(let c=0;c<2;c++)assert.ok(Math.abs(after[key][c]-before[key][c])<1e-8,'centerline is unchanged to floating-point precision');
  let protectedCount=0;
  for(let p=0;p<original.editMask.length;p++)if(original.planes[0].mask[p]===255&&original.editMask[p]===0){protectedCount++;assert.equal(corrected.editMask[p],0,'existing opaque finger/nail coverage must survive');}
  assert.ok(protectedCount>1000);
  assert.deepEqual(original.editMask,maskSnapshot);
  assert.equal(JSON.stringify(original.planes[0].quad),quadSnapshot,'do not recalibrate the deterministic template output');
  assert.equal(await fitFullAiGuidePhone(original,'hand-closeup'),original);
});

test("raw surface projection removes photo padding, keeps bottom print and preserves intended clear space",async()=>{
  const raw=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1400"><rect width="1000" height="1400" fill="#ffea00"/><rect x="200" y="100" width="600" height="1200" fill="#bbc2c8"/><rect x="440" y="1250" width="120" height="50" fill="#da1978"/><rect x="210" y="200" width="70" height="800" fill="#275b80"/></svg>')).png().toBuffer();
  const detected=await findFrontCoverSurface(raw);
  assert.ok(detected,"a complete local front-on outline is detected without AI coordinates");
  assert.ok(detected[0][0]<210&&detected[1][0]>790&&detected[2][1]>920,"all four physical product edges must be included");
  const point=(x,y)=>[x/999*1000,y/1399*1000];
  const quad=[point(200,100),point(799,100),point(799,1299),point(200,1299)];
  const surface=await rectifyCoverArtwork(raw,quad);
  assert.ok(surface);
  const {data,info}=await sharp(surface).raw().toBuffer({resolveWithObject:true});
  assert.deepEqual([info.width,info.height],[584,1204]);
  const pixel=(x,y)=>[...data.subarray((y*info.width+x)*4,(y*info.width+x)*4+4)];
  assert.deepEqual(pixel(292,1195),[218,25,120,255],"bottom artwork must not become a white/padded footer");
  assert.deepEqual(pixel(490,1195),[187,194,200,255],"do not invent extra print in truly clear areas");
  assert.deepEqual(pixel(5,1100),[187,194,200,255],"outside photo background must not be treated as product art");
  assert.equal(await rectifyCoverArtwork(raw,[[0,0],[1000,0],[1000,600],[0,600]]),null,"a scene crop with wrong phone ratio must not become an artwork plate");
  const size=1080,mask=Buffer.alloc(size*size);
  for(let y=100;y<=950;y++)for(let x=300;x<=700;x++)mask[y*size+x]=255;
  const original=await sharp({create:{width:size,height:size,channels:4,background:"#eeeeee"}}).png().toBuffer();
  const template={original,conditioning:original,editMask:mask,planes:[{quad:[[300,100],[700,100],[700,950],[300,950]],mask}]};
  const guided=await createFittedPhoneGuide(template,"dual-diagonal",surface);
  const guide=await sharp(guided).ensureAlpha().raw().toBuffer();
  const bottom=(934*size+500)*4;
  assert.deepEqual([...guide.subarray(bottom,bottom+4)],[218,25,120,255],"the scene guide itself must carry the raw bottom motif through to the fitted bumper");
});

test("ambiguous uniform uploads do not create a guessed raw-artwork guide",async()=>{
  const plain=await sharp({create:{width:200,height:300,channels:3,background:"pink"}}).png().toBuffer();
  assert.equal(await findFrontCoverSurface(plain),null);
});

test("artwork and camera checks fail closed, never accepting ambiguous PASS", () => {
  for (const text of ["PASS", "", "{}", '{"designMatches":true,"issues":[]}', '{"designMatches":"true","cameraMatches":true,"issues":[]}', '{"designMatches":true,"cameraMatches":true,"issues":[1]}']) assert.throws(()=>parseCoverReview(text),/check/);
  assert.throws(()=>parseCoverReview('{"designMatches":true,"cameraMatches":true,"compositionMatches":true,"issues":[]}'),/incomplete/,"missing fit check must never become a pass");
  assert.throws(()=>parseCoverReview('{"designMatches":true,"cameraMatches":true,"fitMatches":true,"compositionMatches":true,"issues":[]}'),/incomplete/,"missing lower-artwork check cannot pass");
  assert.equal(parseCoverReview('{"designMatches":false,"cameraMatches":true,"fitMatches":true,"edgeArtworkMatches":true,"compositionMatches":true,"issues":["Template flowers remain"]}').designMatches,false);
});

test("uncertain and contradictory reviews remain drafts, not passes or generation failures", () => {
  const parse = (value) => assessCoverReview(parseCoverReview(JSON.stringify({compositionMatches:true,fitMatches:true,edgeArtworkMatches:true,...value})));
  assert.equal(parse({designMatches:true,cameraMatches:true,issues:[]}).status,"passed");
  assert.equal(parse({designMatches:true,cameraMatches:false,issues:["Two visible lenses, expected three"]}).status,"mismatch");
  assert.equal(parse({designMatches:false,cameraMatches:true,issues:[]}).status,"mismatch");
  for (const values of [[true,null],[null,true],[null,null]]) {
    const review = parse({designMatches:values[0],cameraMatches:values[1],issues:[]});
    assert.equal(review.status,"needs-review");
    assert.ok(review.issues.length);
  }
  assert.equal(parse({designMatches:true,cameraMatches:true,issues:["Camera too small to judge"]}).status,"needs-review");
  assert.ok(!parseCoverIdentity('{"designSummary":"truncated').brief.includes('designSummary'));
  assert.equal(parse({designMatches:true,cameraMatches:true,compositionMatches:false,issues:["Duplicated fingers"]}).status,"mismatch");
  const badFit=parse({designMatches:true,cameraMatches:true,fitMatches:false,issues:[]});
  assert.equal(badFit.status,"mismatch");
  assert.match(badFit.issues.join(" "),/phone\/case size mismatch/);
  assert.equal(parse({designMatches:true,cameraMatches:true,fitMatches:null,issues:[]}).status,"needs-review");
  const erasedBottom=parse({designMatches:true,cameraMatches:true,edgeArtworkMatches:false,issues:[]});
  assert.equal(erasedBottom.status,"mismatch");
  assert.match(erasedBottom.issues.join(" "),/white footer/);
  assert.equal(parse({designMatches:true,cameraMatches:true,edgeArtworkMatches:null,issues:[]}).status,"needs-review");
});

test("local full-AI guides contain a full-height fitted opaque phone and the selected lens arrangement", async()=>{
  const size=1080;
  const original=await sharp({create:{width:size,height:size,channels:4,background:"#eeeeee"}}).png().toBuffer();
  const mask=Buffer.alloc(size*size);
  for(let y=100;y<=950;y++) for(let x=300;x<=700;x++) mask[y*size+x]=255;
  const quad=[[300,100],[700,100],[700,950],[300,950]];
  const template={original,conditioning:original,editMask:mask,planes:[{quad,mask}]};
  for(const [layout,expected] of [["single",1],["dual-vertical",2],["dual-diagonal",2],["triple",3]]) {
    const guide=await createFittedPhoneGuide(template,layout);
    const data=await sharp(guide).ensureAlpha().raw().toBuffer();
    for(const y of [600,800,920,943]) {
      const p=(y*size+500)*4;
      assert.deepEqual([...data.subarray(p,p+4)],[247,247,245,255],"luminous opaque phone must fill the case, including the bottom interior");
    }
    assert.deepEqual([...data.subarray(0,4)],[238,238,238,255],"outside scene is unchanged");
    const dark=new Set();
    for(let y=110;y<400;y++) for(let x=305;x<560;x++) {
      const p=y*size+x, i=p*4;
      if(data[i]<60&&data[i+1]<110&&data[i+2]<120) dark.add(p);
    }
    const centers=[];
    while(dark.size) {
      const queue=[dark.values().next().value];dark.delete(queue[0]);
      let xTotal=0,yTotal=0;
      for(let q=0;q<queue.length;q++) {
        const p=queue[q];xTotal+=p%size;yTotal+=Math.floor(p/size);
        for(const n of [p-1,p+1,p-size,p+size]) if(dark.delete(n)) queue.push(n);
      }
      if(queue.length>700) centers.push([xTotal/queue.length,yTotal/queue.length]);
    }
    assert.equal(centers.length,expected,`${layout}: large lenses only, not flash or LiDAR`);
    if(layout==="dual-vertical") assert.ok(Math.abs(centers[0][0]-centers[1][0])<2);
    if(layout==="dual-diagonal") assert.ok(Math.abs(centers[0][0]-centers[1][0])>40);
  }
});

test("all supplied scene references remove old phone artwork without changing unrelated pixels", async () => {
  for(const [id,file] of [["hand-closeup","layout-hand-closeup-transparent.png"],["drop-protection","layout-drop-protection.png"],["model-selfie","layout-model-selfie.png"],["three-cases","layout-three-cases.png"]]) {
    const source=await readFile(`public/templates/${file}`);
    const prepared=await prepareCoverTemplate(source,id);
    assert.equal(prepared.editMask.length,1080*1080);
    const metadata=await sharp(prepared.original).metadata();
    assert.equal(metadata.width,1080);assert.equal(metadata.height,1080);
    const original=await sharp(prepared.original).ensureAlpha().raw().toBuffer();
    const neutral=await sharp(prepared.conditioning).ensureAlpha().raw().toBuffer();
    assert.equal(original.length,1080*1080*4);
    let editable=0, protectedPixels=0;
    for(let p=0;p<prepared.editMask.length;p++) {
      assert.equal(original[p*4+3],neutral[p*4+3],"alpha must never change during template conditioning");
      if(prepared.editMask[p]===0) { protectedPixels++;for(let c=0;c<4;c++) assert.equal(neutral[p*4+c],original[p*4+c]); }
      if(prepared.editMask[p]===255) { editable++;const rgb=neutral.subarray(p*4,p*4+3);assert.ok(Math.max(...rgb)-Math.min(...rgb)<30,"neutral phone regions must contain no colored printed motifs"); }
    }
    assert.ok(editable>40000);assert.ok(protectedPixels>100000);
    const generated=await makePlate();
    const finished=await finishCoverImage(generated,prepared);
    const final=await sharp(finished).ensureAlpha().raw().toBuffer();
    let inside=0, blue=0;
    for(let p=0;p<prepared.editMask.length;p+=31) {
      assert.equal(final[p*4+3],original[p*4+3]);
      if(prepared.editMask[p]===0) for(let c=0;c<4;c++) assert.equal(final[p*4+c],original[p*4+c],"scene pixels must remain exact");
      if(prepared.editMask[p]===255) { inside++; if(final[p*4]===10&&final[p*4+1]===60&&final[p*4+2]===210) blue++; }
    }
    assert.ok(blue/inside>.80,"the isolated phone, not a shifted full scene, must fill the phone planes");
    if(id==="hand-closeup") {
      const wrongRatio=await sharp({create:{width:100,height:200,channels:3,background:"pink"}}).png().toBuffer();
      await assert.rejects(finishCoverImage(wrongRatio,prepared),/isolated phone/);
    }
  }
});

async function makePlate(left=38, background="#00ff00", greenMotif=false, bottomLabel=false) {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="${background}"/><rect x="${left}" y="8" width="52" height="112" rx="5" fill="rgb(10,60,210)"/>${greenMotif?`<circle cx="${left+26}" cy="64" r="7" fill="#00ff00"/>`:""}${bottomLabel?`<rect x="${left+6}" y="112" width="40" height="4" fill="#e01020"/>`:""}</svg>`)).png().toBuffer();
}

async function normalizedTemplate(source){
  const {width,height}=await sharp(source).metadata(),size=Math.max(width,height);
  const padded=await sharp(source).rotate().ensureAlpha().extend({left:Math.floor((size-width)/2),right:Math.ceil((size-width)/2),top:Math.floor((size-height)/2),bottom:Math.ceil((size-height)/2),background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
  return sharp(padded).resize(1080,1080).toColourspace('srgb').ensureAlpha().raw().toBuffer();
}

test("the four requested template files are the only active cover scene sources",()=>{
  assert.deepEqual(COVER_LAYOUTS.map(layout=>layout.file),[
    'templates/layout-hand-closeup-transparent.png','templates/layout-drop-protection.png',
    'templates/layout-model-selfie.png','templates/layout-three-cases.png',
  ]);
});

test("all four locked scenes preserve actual input pixels and alpha outside the phone-cover mask",async()=>{
  for(const layout of COVER_LAYOUTS){
    const source=await readFile('public/'+layout.file),reference=await normalizedTemplate(source);
    const prepared=await prepareCoverTemplate(source,layout.id);
    const original=await sharp(prepared.original).ensureAlpha().raw().toBuffer();
    assert.deepEqual(original,reference,layout.id+': no global cutout cleanup, relighting, crop or hand recoloring');
    const result=await sharp(await finishCoverImage(await makePlate(),prepared)).ensureAlpha().raw().toBuffer();
    let protectedCount=0,changed=0;
    for(let p=0;p<prepared.editMask.length;p++){
      assert.equal(result[p*4+3],reference[p*4+3],layout.id+': preserve every original alpha value');
      if(prepared.editMask[p]===0){
        protectedCount++;
        for(let c=0;c<4;c++)assert.equal(result[p*4+c],reference[p*4+c],layout.id+': compare against the INPUT image, not an altered intermediate');
      }
      if(!result.subarray(p*4,p*4+4).equals(reference.subarray(p*4,p*4+4)))changed++;
    }
    assert.ok(protectedCount>500_000);
    assert.ok(changed>70_000&&changed<650_000);
    const landmarks=layout.id==='model-selfie'?[[325,374],[340,437],[600,430],[900,900]]
      :layout.id==='hand-closeup'?[[450,700],[866,530],[800,100]]
      :layout.id==='drop-protection'?[[850,100],[950,400],[950,650],[100,900]]
      :[[362,500],[723,600],[525,810],[860,120]];
    for(const [x,y]of landmarks){const p=y*1080+x;assert.equal(prepared.editMask[p],0,layout.id+`: protect scene/hand/rim at ${x},${y}`);assert.deepEqual(result.subarray(p*4,p*4+4),reference.subarray(p*4,p*4+4));}
  }
});

test("rear fan phones never paint through the foreground phone's preserved border",async()=>{
  const prepared=await prepareCoverTemplate(await readFile('public/templates/layout-three-cases.png'),'three-cases');
  for(const [x,y]of [[362,500],[723,600],[540,923]]){
    const p=y*1080+x;
    assert.equal(prepared.planes[0].mask[p],0);
    assert.equal(prepared.planes[1].mask[p],0);
    assert.equal(prepared.editMask[p],0,'keep the original front-case rim, not a blue-filled merged fan');
  }
});

test("isolated product detection ignores canvas padding and preserves enclosed green artwork",async()=>{
  const first=await isolatePhonePlate(await makePlate(6));
  const shifted=await isolatePhonePlate(await makePlate(69));
  assert.equal(first.width,52);assert.equal(first.height,112);
  assert.deepEqual(first,shifted,"phone extraction is independent of generator canvas position");
  const green=await isolatePhonePlate(await makePlate(38,"#00ff00",true));
  const center=(56*green.width+26)*3;
  assert.deepEqual([...green.data.subarray(center,center+3)],[0,255,0],"genuine green product print must survive keying");
  const alpha=await isolatePhonePlate(await makePlate(38,"transparent"));
  assert.equal(alpha.width,52);assert.equal(alpha.height,112);
  const wide=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#00ff00"/><rect x="8" y="12" width="112" height="104" fill="white"/></svg>')).png().toBuffer();
  await assert.rejects(isolatePhonePlate(wide),/implausible phone proportions/);
});

test("projective phone mapping retains all corners and the bottom label without scene-coordinate cropping",async()=>{
  const quad=[[300,100],[690,20],[940,850],[540,940]],unit=[[0,0],[1,0],[1,1],[0,1]];
  const forward=phoneProjection(unit,quad), inverse=phoneProjection(quad,unit);
  for(let i=0;i<4;i++) {
    const point=forward(...unit[i]);
    assert.ok(Math.abs(point[0]-quad[i][0])<1e-6 && Math.abs(point[1]-quad[i][1])<1e-6);
  }
  const labelPoint=forward(.5,.95), restored=inverse(...labelPoint);
  assert.ok(Math.abs(restored[0]-.5)<1e-6&&Math.abs(restored[1]-.95)<1e-6);
  const prepared=await prepareCoverTemplate(await readFile('public/templates/layout-hand-closeup-transparent.png'),'hand-closeup');
  const a=await finishCoverImage(await makePlate(6),prepared), b=await finishCoverImage(await makePlate(69),prepared);
  assert.deepEqual(a,b,"a shifted generated plate must never create a second phone edge or hand");
  const labelled=await sharp(await finishCoverImage(await makePlate(38,"#00ff00",false,true),prepared)).ensureAlpha().raw().toBuffer();
  const toScene=phoneProjection(unit,prepared.planes[0].quad);
  for(const u of [.15,.5,.85]) {
    const [x,y]=toScene(u,.945),pixel=(Math.round(y)*1080+Math.round(x))*4;
    assert.ok(labelled[pixel]>200 && labelled[pixel+1]<40 && labelled[pixel+2]<50,"both ends and center of a bottom label must survive scene projection");
  }
});

test("rim despill is local, alpha-preserving and does not change genuine green artwork",async()=>{
  const pixels=Buffer.alloc(1080*1080*4);
  for(let p=0;p<pixels.length;p+=4){pixels[p]=180;pixels[p+1]=230;pixels[p+2]=185;pixels[p+3]=p%12?255:100;}
  const motif=(400*1080+4)*4;
  pixels[motif]=0;pixels[motif+1]=255;pixels[motif+2]=0;
  const mask=Buffer.alloc(1080*1080,255);mask[600*1080+4]=0;
  const template={planes:[{quad:[[0,0],[1079,0],[1079,1079],[0,1079]],mask}]};
  const input=await sharp(pixels,{raw:{width:1080,height:1080,channels:4}}).png().toBuffer();
  const copy=Buffer.from(input),out=await sharp(await removePhoneKeySpill(input,template)).ensureAlpha().raw().toBuffer();
  assert.deepEqual(input,copy,"source PNG is never overwritten");
  assert.equal(out[(200*1080+4)*4+1],187,"neutral rim green cast is removed");
  assert.equal(out[(500*1080+500)*4+1],230,"interior print is untouched");
  assert.equal(out[(600*1080+4)*4+1],230,"protected scene/hand pixels are untouched");
  assert.deepEqual([...out.subarray(motif,motif+3)],[0,255,0]);
  for(let i=3;i<out.length;i+=4)assert.equal(out[i],pixels[i]);
});

test("transparent edge refinement removes speckles and white contamination without expanding or blurring the subject",async()=>{
  const width=64,height=64,rgba=Buffer.alloc(width*height*4);
  for(let y=12;y<=51;y++)for(let x=15;x<=49;x++){
    const i=(y*width+x)*4,edge=x===15||x===49||y===12||y===51;
    rgba[i]=edge?255:210;rgba[i+1]=edge?255:150;rgba[i+2]=edge?255:130;rgba[i+3]=255;
  }
  for(const [x,y]of[[4,4],[58,8],[7,53]]){const i=(y*width+x)*4;rgba[i]=255;rgba[i+1]=0;rgba[i+2]=200;rgba[i+3]=255;}
  const png=await sharp(rgba,{raw:{width,height,channels:4}}).png().toBuffer(),copy=Buffer.from(png);
  const cleaned=await refineCutoutEdges(png),{data,info}=await sharp(cleaned).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,width);assert.equal(info.height,height);assert.deepEqual(png,copy);
  for(const [x,y]of[[4,4],[58,8],[7,53]])assert.equal(data[(y*width+x)*4+3],0);
  let partial=0;
  for(let i=0;i<data.length;i+=4){
    assert.ok(data[i+3]<=rgba[i+3],"cleanup cannot enlarge the original silhouette");
    if(data[i+3]===0)assert.deepEqual([...data.subarray(i,i+3)],[0,0,0]);
    if(data[i+3]>0&&data[i+3]<250){partial++;assert.ok(data[i+1]<200,"soft edges must not retain a white matte");}
  }
  assert.ok(partial>20,"the contour needs fractional antialias coverage");
  const center=(30*width+30)*4;assert.deepEqual([...data.subarray(center,center+4)],[210,150,130,255]);
  const opaque=await sharp({create:{width:64,height:64,channels:4,background:'#e6ceb9'}}).png().toBuffer();
  assert.equal(await refineCutoutEdges(opaque),opaque,"opaque lifestyle scenes must not be filtered");
});

test("fractional hand coverage is applied once even where phone planes overlap",async()=>{
  const original=await sharp({create:{width:1080,height:1080,channels:4,background:{r:200,g:100,b:50,alpha:1}}}).png().toBuffer();
  const conditioning=await sharp({create:{width:1080,height:1080,channels:4,background:'white'}}).png().toBuffer();
  const p=540*1080+540,mask=Buffer.alloc(1080*1080),geometry=Buffer.alloc(1080*1080);mask[p]=128;geometry[p]=255;
  const plane={quad:[[0,0],[1079,0],[1079,1079],[0,1079]],mask:geometry};
  const result=await sharp(await finishCoverImage(await makePlate(),{original,conditioning,editMask:mask,planes:[plane,plane,plane]})).ensureAlpha().raw().toBuffer();
  const w=128/255;
  assert.deepEqual([...result.subarray(p*4,p*4+4)],[Math.round(10*w+200*(1-w)),Math.round(60*w+100*(1-w)),Math.round(210*w+50*(1-w)),255]);
  assert.deepEqual([...result.subarray((p+1)*4,(p+1)*4+4)],[200,100,50,255]);
});

test("selfie nail contours protect real nails without preserving the old rectangular case patches",async()=>{
  const source=await readFile('public/templates/layout-model-selfie.png');
  const prepared=await prepareCoverTemplate(source,'model-selfie');
  const rgba=await sharp(prepared.original).ensureAlpha().raw().toBuffer();
  const result=await sharp(await finishCoverImage(await makePlate(),prepared)).ensureAlpha().raw().toBuffer();
  for(const [x,y]of[[325,374],[340,437]]){
    const p=y*1080+x;assert.equal(prepared.editMask[p],0,"nail interiors remain original");
    assert.deepEqual([...result.subarray(p*4,p*4+4)],[...rgba.subarray(p*4,p*4+4)]);
  }
  const oldBoxPatch=357*1080+340;
  assert.ok(prepared.editMask[oldBoxPatch]>240,"old box-only coverage above the nail must be removed");
  let soft=0;for(let y=350;y<455;y++)for(let x=280;x<365;x++){const a=prepared.editMask[y*1080+x];if(a>0&&a<255)soft++;}
  assert.ok(soft>40,"nail/finger contours must have soft, not thresholded, coverage");
  let strongest=0;for(const value of prepared.contactShadow.subarray(350*1080,455*1080))strongest=Math.max(strongest,value);
  assert.ok(strongest<40,"contact shadow must remain subtle");
});
