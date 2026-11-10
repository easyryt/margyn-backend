import { HAND_REVIEW_CHECKS } from "../src/tools/image-generator/lib/charm-hand-composition.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { startTestBackend } from "./support/runtime.mjs";
import { getSubscription } from "../src/services/subscriptions.mjs";
const origin = "http://image-studio.test";
const realFetch = globalThis.fetch;
const fixture = await sharp({
  create: {
    width: 128,
    height: 128,
    channels: 4,
    background: { r: 205, g: 80, b: 120, alpha: 1 },
  },
})
  .png()
  .toBuffer();
const phone = await sharp(
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#00ff00"/><rect x="38" y="8" width="52" height="112" rx="5" fill="#cd5078"/></svg>',
  ),
)
  .png()
  .toBuffer();

test(
  "image studio Express integration requires login, preserves multipart settings and keeps credentials private",
  { timeout: 120000 },
  async (t) => {
    const runtime = await startTestBackend(origin);
    let cookie = "";
    let failUpstream = false;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      if (
        !String(url).startsWith("https://generativelanguage.googleapis.com/") &&
        !String(url).startsWith("https://api.openai.com/")
      )
        return realFetch(url, init);
      const gemini = String(url).includes("googleapis");
      const body = init.body instanceof FormData ? null : JSON.parse(init.body);
      const image =
        init.body instanceof FormData ||
        body?.generationConfig?.responseModalities?.includes("IMAGE");
      const texts = gemini
        ? body.contents
            .flatMap((item) => item.parts)
            .map((part) => part.text || "")
            .join(" ")
        : image
          ? init.body.get("prompt")
          : body.input
              .flatMap((item) => item.content)
              .map((part) => part.text || "")
              .join(" ");
      calls.push({ gemini, image });
      if (failUpstream)
        return Response.json(
          { error: { message: "Denied " + process.env.GEMINI_API_KEY } },
          { status: 403 },
        );
      const pixels = texts.includes("ISOLATED_PHONE_PLATE") ? phone : fixture;
      if (image)
        return Response.json(
          gemini
            ? {
                usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          inlineData: {
                            data: pixels.toString("base64"),
                            mimeType: "image/png",
                          },
                        },
                      ],
                    },
                  },
                ],
              }
            : { data: [{ b64_json: pixels.toString("base64") }], usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
        );
      const checks = HAND_REVIEW_CHECKS;
      const text = texts.includes("visiblePieceCount")
        ? JSON.stringify({
            visiblePieceCount: 5,
            matchesProduct: true,
            allPiecesVisible: true,
            badgeAreaClear: true,
            issues: [],
          })
        : texts.includes("COVER_IDENTITY_REVIEW")
          ? JSON.stringify({
              designMatches: true,
              cameraMatches: true,
              fitMatches: true,
              edgeArtworkMatches: true,
              compositionMatches: true,
              issues: [],
            })
          : texts.includes("Return exactly PASS")
            ? "PASS"
            : texts.includes("attachmentConnected")
              ? JSON.stringify({
                  checks: Object.fromEntries(checks.map((key) => [key, true])),
                  issues: [],
                })
              : "Preserve the uploaded product and its complete artwork.";
      return Response.json(
        gemini
          ? { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 } }
          : {
              status: "completed",
              usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
              output: [
                { type: "message", content: [{ type: "output_text", text }] },
              ],
            },
      );
    };
    const request = (path, init = {}) =>
      realFetch(runtime.url + "/api" + path, {
        ...init,
        headers: { Origin: origin, Cookie: cookie, ...init.headers },
      });
    const formFor = (action, provider = "gemini") => {
      const form = new FormData();
      form.set("provider", provider);
      form.set(
        "view",
        action === "generate"
          ? "model-selfie"
          : action === "generate-charms"
            ? "charm-only"
            : "pack-fan",
      );
      form.set("qualityTier", "economy");
      form.set(
        action === "generate-charms" ? "cover" : "image",
        new Blob([fixture], { type: "image/png" }),
        "product.png",
      );
      if (action === "generate-charms")
        form.set(
          "charm",
          new Blob([fixture], { type: "image/png" }),
          "charm.png",
        );
      if (action === "generate-charm-pack") form.set("quantity", "5");
      if (action === "generate") {
        form.set("phoneModel", "iphone-13");
        form.set("renderMode", "template");
      }
      return form;
    };
    try {
      await t.test(
        "all provider and generation endpoints reject guests without upstream calls",
        async () => {
          assert.equal(
            (await request("/tools/image-generator/providers")).status,
            401,
          );
          for (const action of [
            "generate",
            "generate-charms",
            "generate-charm-pack",
          ])
            assert.equal(
              (
                await request("/tools/image-generator/" + action, {
                  method: "POST",
                  body: formFor(action),
                })
              ).status,
              401,
            );
          assert.equal(calls.length, 0);
        },
      );
      const challenge = await (
        await request("/auth/request-otp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: "9876543228" }),
        })
      ).json();
      const verified = await request("/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          code: challenge.developmentCode,
        }),
      });
      assert.equal(verified.status, 200);
      cookie = verified.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      await t.test(
        "provider configuration has choices and defaults but no credentials",
        async () => {
          const response = await request("/tools/image-generator/providers");
          assert.equal(response.status, 200);
          const text = await response.text();
          const data = JSON.parse(text);
          assert.equal(data.providers.length, 2);
          assert.ok(data.providers.every((provider) => provider.available));
          assert.ok(!text.includes("isolated-test"));
          assert.ok(!text.includes("apiKey"));
        },
      );
      await t.test(
        "real copied handlers accept Express uploads and return the selected view with either provider",
        async () => {
          for (const [action, provider] of [
            ["generate", "gemini"],
            ["generate", "openai"],
            ["generate-charms", "gemini"],
            ["generate-charm-pack", "openai"],
          ]) {
            const response = await request("/tools/image-generator/" + action, {
              method: "POST",
              body: formFor(action, provider),
            });
            const payload = await response.json();
            assert.equal(response.status, 200, payload.error);
            assert.equal(payload.images.length, 1);
            assert.ok(
              payload.images[0].dataUrl.startsWith("data:image/png;base64,"),
            );
            if (action === "generate") {
              assert.equal(payload.images[0].phoneModelId, "iphone-13");
              assert.equal(payload.images[0].templateId, "model-selfie");
              assert.equal(payload.images[0].renderMode, "template");
            }
          }
        },
      );
      await t.test(
        "invalid selection, type, size and duplicate provider fields fail before any paid request",
        async () => {
          const before = calls.length;
          const invalid = formFor("generate");
          invalid.set("views", '["model-selfie","model-selfie"]');
          assert.equal(
            (
              await request("/tools/image-generator/generate", {
                method: "POST",
                body: invalid,
              })
            ).status,
            400,
          );
          const duplicate = formFor("generate");
          duplicate.append("provider", "openai");
          assert.equal(
            (
              await request("/tools/image-generator/generate", {
                method: "POST",
                body: duplicate,
              })
            ).status,
            400,
          );
          const wrong = new FormData();
          wrong.set(
            "image",
            new Blob(["bad"], { type: "text/plain" }),
            "bad.txt",
          );
          assert.equal(
            (
              await request("/tools/image-generator/generate", {
                method: "POST",
                body: wrong,
              })
            ).status,
            415,
          );
          const large = new FormData();
          large.set(
            "image",
            new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)], {
              type: "image/png",
            }),
            "large.png",
          );
          assert.equal(
            (
              await request("/tools/image-generator/generate", {
                method: "POST",
                body: large,
              })
            ).status,
            413,
          );
          assert.equal(
            (
              await request("/tools/image-generator/generate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              })
            ).status,
            415,
          );
          assert.equal(
            (
              await request("/tools/image-generator/generate", {
                method: "POST",
                headers: { Origin: "https://untrusted.invalid" },
                body: formFor("generate"),
              })
            ).status,
            403,
          );
          assert.equal(calls.length, before);
        },
      );
      await t.test(
        "upstream errors are redacted without switching services or automatically retrying",
        async () => {
          failUpstream = true;
          const before = calls.length;
          const response = await request("/tools/image-generator/generate", {
            method: "POST",
            body: formFor("generate"),
          });
          const text = await response.text();
          assert.equal(response.status, 403);
          assert.ok(!text.includes(process.env.GEMINI_API_KEY));
          assert.equal(calls.length, before + 1);
        },
      );
      const account = (await (await request("/auth/me")).json()).user;
      const subscription = await getSubscription(account.id);
      assert.equal(subscription.usedTokens, (calls.length - 1) * 150);
      assert.equal(subscription.inputTokens, (calls.length - 1) * 100);
      assert.equal(subscription.outputTokens, (calls.length - 1) * 50);
      assert.equal("usedTokens" in (await (await request("/subscription")).json()).subscription, false);
      await request("/auth/logout", { method: "POST" });
      assert.equal(
        (await request("/tools/image-generator/providers")).status,
        401,
      );
    } finally {
      globalThis.fetch = realFetch;
      await runtime.close();
    }
  },
);
