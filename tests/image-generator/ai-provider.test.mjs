import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { AiRequestError, createAiClient, getParts, getProviderOptions, parseProvider, parseQualityTier, createAiClientFromForm } from "../../src/tools/image-generator/lib/ai-provider.mjs";
import { initialProvider } from "../../src/tools/image-generator/lib/ai-provider-options.mjs";

const env = { GEMINI_API_KEY: "gemini-test-secret", OPENAI_API_KEY: "openai-test-secret" };
const template = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 90, g: 130, b: 170, alpha: .5 } } }).png().toBuffer();
const product = await sharp({ create: { width: 24, height: 12, channels: 3, background: "pink" } }).jpeg().toBuffer();
const body = {
  contents: [{ role: "user", parts: [
    { text: "IMAGE 1 — template. Keep its geometry." },
    { inlineData: { mimeType: "image/png", data: template.toString("base64") } },
    { text: "IMAGE 2 — raw product. Copy this design." },
    { inlineData: { mimeType: "image/jpeg", data: product.toString("base64") } },
  ] }],
  generationConfig: { responseModalities: ["IMAGE"], responseFormat: { image: { aspectRatio: "ASPECT_RATIO_ONE_BY_ONE", imageSize: "IMAGE_SIZE_TWO_K" } } },
};
const answer = (payload, status = 200) => new Response(JSON.stringify(payload), { status });

test("quality presets disclose fixed stronger models while economy retains env overrides", () => {
  const options = getProviderOptions({ ...env, OPENAI_IMAGE_MODEL: "custom-economy", GEMINI_IMAGE_SIZE: "1K" });
  assert.equal(options[0].qualityOptions[1].imageModel, "gemini-3-pro-image");
  assert.equal(options[1].qualityOptions[1].imageModel, "gpt-image-2.5-flare");
  assert.equal(options[1].imageModel, "gpt-image-2.5-flare");
  assert.equal(options[1].defaultQualityTier, "quality");
  assert.equal(options[0].defaultQualityTier, "economy");
  assert.equal(options[1].qualityOptions[0].imageModel, "custom-economy");
  assert.match(options[0].qualityOptions[1].settingsLabel, /2K.*higher cost/);
  assert.match(options[1].qualityOptions[1].settingsLabel, /low quality.*compact inputs/);
  assert.equal(parseQualityTier(null), "economy");
  for (const invalid of ["", "max", "gpt-image-2.5-sunburst", new Blob()]) assert.throws(() => parseQualityTier(invalid), (error) => error.status === 400);
  for (const field of ["provider", "qualityTier"]) {
    const form = new FormData(); form.append(field, "economy"); form.append(field, "quality");
    assert.throws(() => createAiClientFromForm(form), (error) => error.status === 400);
  }
});

test("explicit higher presets use model-specific image settings without upgrading text calls", async () => {
  for (const provider of ["gemini", "openai"]) {
    const seen=[];
    const ai = createAiClient(provider, { ...env, OPENAI_IMAGE_MODEL: "custom-economy", GEMINI_IMAGE_MODEL: "custom-economy" }, async (url, init) => {
      seen.push(url);
      if (init.body instanceof FormData) {
        assert.equal(init.body.get("model"), "gpt-image-2.5-flare");
        assert.equal(init.body.get("quality"), "low");
        assert.equal(init.body.get("input_fidelity"), null);
        assert.equal(init.body.get("background"), "transparent");
        assert.equal(init.body.get("n"), "1");
        return answer({ data: [{ b64_json: "generated" }] });
      }
      const sent=JSON.parse(init.body);
      if (sent.generationConfig?.responseModalities?.includes("IMAGE")) {
        assert.match(String(url), /\/gemini-3-pro-image:generateContent$/);
        assert.equal(sent.generationConfig.responseFormat.image.imageSize, "IMAGE_SIZE_TWO_K");
        assert.ok(!("background" in sent.generationConfig.responseFormat.image), "OpenAI-only background must not leak to Gemini");
        assert.ok(!("thinkingConfig" in sent.generationConfig), "do not apply Lite thinking settings to Pro");
        return answer({ candidates: [{ content: { parts: [{ inlineData: { data: "generated" } }] } }] });
      }
      assert.ok(!String(url).includes("pro-image"));
      assert.equal(provider === "gemini" ? sent.generationConfig.maxOutputTokens : sent.max_output_tokens, 300);
      if (provider === "openai") assert.equal(sent.model, "gpt-6-luna");
      return answer(provider === "gemini" ? { candidates: [{content:{parts:[{text:"OK"}]}}] } : {status:"completed",output:[{content:[{type:"output_text",text:"OK"}]}]});
    }, "quality");
    assert.equal(ai.qualityTier, "quality");
    await ai.request("image", {...body, generationConfig:{responseModalities:["IMAGE"],responseFormat:{image:{background:"transparent"}}}});
    await ai.request("text", {...body,generationConfig:{maxOutputTokens:300}});
    assert.equal(seen.length,2);
  }
});

test("higher image presets retain larger product and scene detail without inflating text review budgets", async () => {
  const large = await sharp({create:{width:1800,height:1200,channels:3,background:"pink"}}).jpeg().toBuffer();
  const refs = {contents:[{role:"user",parts:[{referenceRole:"product",inlineData:{mimeType:"image/jpeg",data:large.toString("base64")}},{inlineData:{mimeType:"image/jpeg",data:large.toString("base64")}}]}]};
  const dims=[];
  const ai=createAiClient("gemini",env,async(_url,init)=>{
    const sent=JSON.parse(init.body);
    dims.push(await Promise.all(sent.contents[0].parts.map(async(part)=>(await sharp(Buffer.from(part.inlineData.data,"base64")).metadata()).width)));
    return answer({candidates:[{content:{parts:[{text:"OK"}]}}]});
  },"quality");
  await ai.request("image",refs); await ai.request("text",refs);
  assert.deepEqual(dims,[[1536,1024],[1024,512]]);
});

test("OpenAI defaults to Flare low with compact inputs, even with old premium env overrides", async () => {
  const large = await sharp({create:{width:1800,height:1200,channels:3,background:"pink"}}).jpeg().toBuffer();
  const references={contents:[{role:"user",parts:[{referenceRole:"product",inlineData:{mimeType:"image/jpeg",data:large.toString("base64")}},{inlineData:{mimeType:"image/jpeg",data:large.toString("base64")}}]}]};
  for (const tier of [undefined,"quality"]) {
    let calls=0;
    const ai=createAiClient("openai",{...env,OPENAI_IMAGE_MODEL:"gpt-image-2.5-sunburst",OPENAI_IMAGE_QUALITY:"high"},async(_url,init)=>{
      calls++;
      assert.equal(init.body.get("model"),"gpt-image-2.5-flare");
      assert.equal(init.body.get("quality"),"low");
      assert.equal(init.body.get("size"),"1024x1024");
      assert.equal(init.body.get("input_fidelity"),null,"Flare must omit legacy fidelity settings");
      const widths=await Promise.all(init.body.getAll("image[]").map(async(file)=>(await sharp(Buffer.from(await file.arrayBuffer())).metadata()).width));
      assert.deepEqual(widths,[1024,512]);
      return answer({data:[{b64_json:"generated"}]});
    },tier);
    assert.equal(ai.imageModel,"gpt-image-2.5-flare");
    await ai.request("image",references);
    assert.equal(calls,1,"no automatic paid upgrade or extra render");
  }
});

test("provider validation and missing keys never silently switch services", () => {
  assert.equal(parseProvider(null), "gemini");
  assert.equal(parseProvider("openai"), "openai");
  for (const value of ["", "claude", "OPENAI", new Blob()]) assert.throws(() => parseProvider(value), (error) => error.status === 400);
  assert.throws(() => createAiClient("openai", { GEMINI_API_KEY: "present" }), /OPENAI_API_KEY/);
  assert.throws(() => createAiClient("gemini", { OPENAI_API_KEY: "present" }), /GEMINI_API_KEY/);
  assert.equal(getProviderOptions({ OPENAI_API_KEY: "   " })[1].available, false);
});

test("public options do not expose keys and respect existing model overrides", () => {
  const options = getProviderOptions({ ...env, GEMINI_IMAGE_MODEL: "custom-image", OPENAI_CONTENT_MODEL: "custom-text" });
  assert.equal(options[0].imageModel, "custom-image");
  assert.equal(options[1].contentModel, "custom-text");
  assert.ok(options.every((option) => option.available));
  assert.ok(!JSON.stringify(options).includes("test-secret"));
  assert.ok(!JSON.stringify(options).includes("apiKey"));
});

test("a saved provider stays selected when its key is missing; only a new user gets a configured default", () => {
  const geminiOnly = getProviderOptions({ GEMINI_API_KEY: "present" });
  assert.equal(initialProvider(geminiOnly, "openai"), "openai");
  assert.equal(initialProvider(geminiOnly, null), "gemini");
  const openaiOnly = getProviderOptions({ OPENAI_API_KEY: "present" });
  assert.equal(initialProvider(openaiOnly, null), "openai");
  assert.equal(initialProvider(openaiOnly, "gemini"), "gemini");
});

test("OpenAI edits use only the selected key, all images in order, and explicit economical settings", async () => {
  const calls = [];
  const ai = createAiClient("openai", { OPENAI_API_KEY: env.OPENAI_API_KEY }, async (url, init) => {
    calls.push(url);
    assert.equal(url, "https://api.openai.com/v1/images/edits");
    assert.deepEqual(init.headers, { Authorization: `Bearer ${env.OPENAI_API_KEY}` });
    assert.ok(init.body instanceof FormData);
    const form = init.body;
    assert.equal(form.get("model"), "gpt-image-1-mini");
    assert.equal(form.get("input_fidelity"), "low");
    assert.equal(form.get("quality"), "low");
    assert.equal(form.get("n"), "1");
    assert.equal(form.get("size"), "1024x1024");
    assert.equal(form.get("output_format"), "png");
    const references = form.getAll("image[]");
    assert.equal(references.length, 2);
    assert.deepEqual(await Promise.all(references.map(async (file) => Buffer.from(await file.arrayBuffer()))), [template, product]);
    assert.deepEqual(references.map((file) => file.type), ["image/png", "image/jpeg"]);
    assert.match(form.get("prompt"), /IMAGE 1.*\n\n\[Attached image 1\].*\n\nIMAGE 2/s);
    assert.ok(init.signal instanceof AbortSignal);
    return answer({ data: [{ b64_json: "generated" }] });
  }, "economy");
  assert.equal(getParts(await ai.request("image", body))[0].inlineData.data, "generated");
  assert.equal(calls.length, 1);
});

test("OpenAI preserves portrait layout with supported sizes and env quality override", async () => {
  for (const [model, size] of [["gpt-image-2.5-flare", "960x1280"], ["gpt-image-1-mini", "1024x1536"]]) {
    const ai = createAiClient("openai", { ...env, OPENAI_IMAGE_MODEL: model, OPENAI_IMAGE_QUALITY: "medium" }, async (_url, init) => {
      assert.equal(init.body.get("size"), size);
      assert.equal(init.body.get("quality"), "medium");
      return answer({ data: [{ b64_json: "generated" }] });
    }, "economy");
    await ai.request("image", { ...body, generationConfig: { responseFormat: { image: { aspectRatio: "ASPECT_RATIO_THREE_BY_FOUR" } } } });
  }
});

test("OpenAI analysis has multimodal references, a token cap, no stored response and no reasoning budget", async () => {
  const ai = createAiClient("openai", env, async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    const sent = JSON.parse(init.body);
    assert.equal(sent.model, "gpt-6-luna");
    assert.equal(sent.max_output_tokens, 600);
    assert.equal(sent.store, false);
    assert.deepEqual(sent.reasoning, { effort: "none" });
    assert.deepEqual(sent.input[0].content.map((part) => part.type), ["input_text", "input_image", "input_text", "input_image"]);
    assert.match(sent.input[0].content[3].image_url, /^data:image\/jpeg;base64,/);
    return answer({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Checked" }] }] });
  });
  const output = await ai.request("text", { ...body, generationConfig: { maxOutputTokens: 600 } });
  assert.equal(getParts(output)[0].text, "Checked");
});

test("structured text schemas use the documented provider format without leaking internal options", async () => {
  const schema={type:"object",additionalProperties:false,properties:{matches:{type:["boolean","null"]}},required:["matches"]};
  for (const provider of ["gemini","openai"]) {
    let count=0;
    const ai=createAiClient(provider,env,async(_url,init)=>{
      count++;
      const sent=JSON.parse(init.body);
      if (provider === "gemini") {
        assert.equal(sent.generationConfig.responseFormat.text.mimeType,"APPLICATION_JSON");
        assert.deepEqual(sent.generationConfig.responseFormat.text.schema,schema);
        assert.ok(!("jsonSchema" in sent.generationConfig));
        return answer({candidates:[{content:{parts:[{text:'{"matches":null}'}]}}]});
      }
      assert.deepEqual(sent.text.format,{type:"json_schema",name:"test_review",strict:true,schema});
      assert.ok(!("generationConfig" in sent));
      return answer({status:"completed",output:[{content:[{type:"output_text",text:'{"matches":null}'}]}]});
    });
    const payload=await ai.request("text",{contents:[{role:"user",parts:[{text:"Return JSON"}]}],generationConfig:{maxOutputTokens:384,jsonSchema:{name:"test_review",schema}}});
    assert.equal(getParts(payload)[0].text,'{"matches":null}');
    assert.equal(count,1);
  }
});

test("Gemini retains reference format and configured model while reducing default resolution", async () => {
  const ai = createAiClient("gemini", { GEMINI_API_KEY: env.GEMINI_API_KEY, GEMINI_IMAGE_MODEL: "configured-image" }, async (url, init) => {
    assert.match(url, /generativelanguage\.googleapis\.com\/v1\/models\/configured-image:generateContent$/);
    assert.equal(init.headers["x-goog-api-key"], env.GEMINI_API_KEY);
    assert.equal(init.headers.Authorization, undefined);
    const sent = JSON.parse(init.body);
    assert.deepEqual(sent.contents, body.contents);
    assert.equal(sent.generationConfig.responseFormat.image.imageSize, "IMAGE_SIZE_ONE_K");
    return answer({ candidates: [{ content: { parts: [{ inlineData: { data: "generated", mimeType: "image/png" } }] } }] });
  });
  assert.equal(getParts(await ai.request("image", body))[0].inlineData.data, "generated");
});

test("Gemini analysis caps output tokens and rejects truncated answers", async () => {
  const ai = createAiClient("gemini", env, async (_url, init) => {
    assert.equal(JSON.parse(init.body).generationConfig.maxOutputTokens, 600);
    return answer({ candidates: [{ finishReason: "MAX_TOKENS" }] });
  });
  await assert.rejects(ai.request("text", { ...body, generationConfig: { maxOutputTokens: 10000 } }), /token limit/);
});

test("provider errors preserve status but redact credentials; no silent fallback or automatic paid retry", async () => {
  let calls = 0;
  const ai = createAiClient("openai", env, async () => {
    calls += 1;
    return answer({ error: { message: `Invalid key ${env.OPENAI_API_KEY}` } }, 401);
  });
  await assert.rejects(ai.request("image", body), (error) => error instanceof AiRequestError && error.status === 401 && !error.message.includes(env.OPENAI_API_KEY));
  assert.equal(calls, 1);
  const unreachable = createAiClient("openai", env, async () => { throw new Error("fetch failed"); });
  await assert.rejects(unreachable.request("image", body), (error) => error.status === 408);
});

test("incomplete text or missing image results cannot appear successful", async () => {
  const incomplete = createAiClient("openai", env, async () => answer({ status: "incomplete", output: [] }));
  await assert.rejects(incomplete.request("text", body), /incomplete/);
  const missing = createAiClient("openai", env, async () => answer({ data: [] }));
  await assert.rejects(missing.request("image", body), /did not return/);
  assert.throws(() => createAiClient("openai", { ...env, OPENAI_IMAGE_QUALITY: "unlimited" }, fetch, "economy"), /must be/);
  assert.throws(() => createAiClient("gemini", { ...env, GEMINI_IMAGE_SIZE: "8K" }), /must be/);
});

test("Gemini economy defaults use Lite Image, 1K and minimal thinking without capping image output tokens", async () => {
  const ai = createAiClient("gemini", env, async (url, init) => {
    assert.match(url, /models\/gemini-3\.1-flash-lite-image:generateContent$/);
    const sent = JSON.parse(init.body);
    assert.equal(sent.generationConfig.responseFormat.image.imageSize, "IMAGE_SIZE_ONE_K");
    assert.deepEqual(sent.generationConfig.thinkingConfig, { thinkingLevel: "minimal", includeThoughts: false });
    assert.equal(sent.generationConfig.maxOutputTokens, undefined, "a text budget must not truncate an image");
    return answer({ candidates: [{ content: { parts: [{ inlineData: { data: "generated", mimeType: "image/png" } }] } }] });
  });
  await ai.request("image", body);
  for (const size of ["2K", "4K"]) assert.throws(() => createAiClient("gemini", { ...env, GEMINI_IMAGE_SIZE: size }), /supports only 1K/);
});

test("both providers compact image references while preserving aspect ratio, alpha and order", async () => {
  for (const provider of ["gemini", "openai"]) {
    for (const alpha of [false, true]) {
      const large = await sharp({ create: { width: 1600, height: 1200, channels: alpha ? 4 : 3, background: { r: 80, g: 120, b: 160, alpha: alpha ? .5 : 1 } } }).png().toBuffer();
      const ai = createAiClient(provider, env, async (_url, init) => {
        const images = provider === "gemini"
          ? JSON.parse(init.body).contents[0].parts.filter((part) => part.inlineData).map((part) => ({ mime: part.inlineData.mimeType, bytes: Buffer.from(part.inlineData.data, "base64") }))
          : await Promise.all(init.body.getAll("image[]").map(async (file) => ({ mime: file.type, bytes: Buffer.from(await file.arrayBuffer()) })));
        assert.equal(images.length, 2);
        const metadata = await sharp(images[0].bytes).metadata();
        assert.equal(metadata.width, 512);
        assert.equal(metadata.height, 384);
        assert.equal(metadata.hasAlpha, alpha);
        assert.equal(images[0].mime, alpha ? "image/png" : "image/jpeg");
        assert.deepEqual(images[1].bytes, template, "small uploads must not be enlarged or re-encoded");
        return provider === "gemini" ? answer({ candidates: [{ content: { parts: [{ inlineData: { data: "generated", mimeType: "image/png" } }] } }] }) : answer({ data: [{ b64_json: "generated" }] });
      });
      await ai.request("image", { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: large.toString("base64") } }, body.contents[0].parts[1]] }] });
    }
  }
});

test("both providers apply configured analysis size and token caps independently from image budgets", async () => {
  const large = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "pink" } }).jpeg().toBuffer();
  for (const provider of ["gemini", "openai"]) {
    const prefix = provider.toUpperCase();
    const ai = createAiClient(provider, { ...env, [`${prefix}_ANALYSIS_MAX_EDGE`]: "256", [`${prefix}_MAX_OUTPUT_TOKENS`]: "400" }, async (_url, init) => {
      const sent = JSON.parse(init.body);
      const data = provider === "gemini" ? sent.contents[0].parts[0].inlineData.data : sent.input[0].content[0].image_url.split(",")[1];
      const metadata = await sharp(Buffer.from(data, "base64")).metadata();
      assert.equal(metadata.width, 256);
      assert.equal(metadata.height, 192);
      assert.equal(provider === "gemini" ? sent.generationConfig.maxOutputTokens : sent.max_output_tokens, 400);
      if (provider === "gemini") assert.equal(sent.generationConfig.thinkingConfig.thinkingLevel, "minimal");
      return provider === "gemini" ? answer({ candidates: [{ content: { parts: [{ text: "Checked" }] } }] }) : answer({ status: "completed", output: [{ content: [{ type: "output_text", text: "Checked" }] }] });
    });
    await ai.request("text", { contents: [{ role: "user", parts: [{ inlineData: { data: large.toString("base64"), mimeType: "image/jpeg" } }] }], generationConfig: { maxOutputTokens: 1200 } });
    for (const invalid of [{ [`${prefix}_REFERENCE_MAX_EDGE`]: "0" }, { [`${prefix}_ANALYSIS_MAX_EDGE`]: "NaN" }, { [`${prefix}_MAX_OUTPUT_TOKENS`]: "50" }]) assert.throws(() => createAiClient(provider, { ...env, ...invalid }), /must be a whole number/);
    let calls = 0;
    const invalidImage = createAiClient(provider, env, async () => { calls++; return answer({}); });
    await assert.rejects(invalidImage.request("image", { contents: [{ role: "user", parts: [{ inlineData: { data: "not-an-image", mimeType: "image/png" } }] }] }), /could not read/);
    assert.equal(calls, 0);
  }
});

test("product detail retains 1024px without raising scene budgets or leaking internal hints", async () => {
  const large = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "pink" } }).jpeg().toBuffer();
  for (const provider of ["gemini", "openai"]) {
    for (const kind of ["text", "image"]) {
      const ai = createAiClient(provider, env, async (_url, init) => {
        let buffers;
        if (provider === "gemini") {
          const sent = JSON.parse(init.body);
          assert.ok(!JSON.stringify(sent).includes("referenceRole"));
          buffers = sent.contents[0].parts.map((part) => Buffer.from(part.inlineData.data, "base64"));
        } else if (kind === "image") buffers = await Promise.all(init.body.getAll("image[]").map(async (file) => Buffer.from(await file.arrayBuffer())));
        else buffers = JSON.parse(init.body).input[0].content.map((part) => Buffer.from(part.image_url.split(",")[1], "base64"));
        assert.deepEqual(await Promise.all(buffers.map(async (buffer) => { const m = await sharp(buffer).metadata(); return [m.width, m.height]; })), [[512, 384], [1024, 768]]);
        if (kind === "image") return provider === "gemini" ? answer({ candidates: [{ content: { parts: [{ inlineData: { data: "generated", mimeType: "image/png" } }] } }] }) : answer({ data: [{ b64_json: "generated" }] });
        return provider === "gemini" ? answer({ candidates: [{ content: { parts: [{ text: "Checked" }] } }] }) : answer({ status: "completed", output: [{ content: [{ type: "output_text", text: "Checked" }] }] });
      });
      await ai.request(kind, { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: large.toString("base64") } }, { referenceRole: "product", inlineData: { mimeType: "image/jpeg", data: large.toString("base64") } }] }] });
    }
  }
});
