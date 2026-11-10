import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { startTestBackend } from "./support/runtime.mjs";
import { makeShippingPdf } from "./support/shipping-fixture.mjs";
import { readPdf } from "../src/tools/shipping-labels/readPdf.mjs";
import { extractOrder } from "../src/tools/shipping-labels/extractOrder.mjs";
import { groupOrders } from "../src/tools/shipping-labels/groupOrders.mjs";
import { reserveShippingSlot } from "../src/services/shipping-labels.mjs";
const origin = "http://shipping.test";

test(
  "authenticated shipping-label processing keeps the original extraction and download outputs",
  { timeout: 120000 },
  async (t) => {
    const runtime = await startTestBackend(origin);
    let cookie = "";
    const request = (path, init = {}) =>
      fetch(runtime.url + "/api" + path, {
        ...init,
        headers: { Origin: origin, Cookie: cookie, ...init.headers },
      });
    const input = await makeShippingPdf();
    const upload = (
      action,
      bytes = input,
      type = "application/pdf",
      filename = "labels.pdf",
      extra = false,
    ) => {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type }), filename);
      if (extra) form.append("unexpected", "value");
      return request("/tools/shipping-labels/" + action, {
        method: "POST",
        body: form,
      });
    };
    try {
      await t.test(
        "all processing actions reject guests before upload",
        async () => {
          for (const action of ["stats", "process", "summary"])
            assert.equal((await upload(action)).status, 401);
        },
      );
      const sent = await request("/auth/request-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "9876543220" }),
      });
      const challenge = await sent.json();
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
        "same source helpers extract three orders into two SKU groups and skip the cover page",
        async () => {
          const pages = await readPdf(input);
          const orders = pages
            .map((page) => extractOrder(page.text, page.pageNumber))
            .filter((order) => order.sku && order.orderNo && order.productName);
          assert.equal(pages.length, 4);
          assert.equal(orders.length, 3);
          const grouped = groupOrders(orders, "sku");
          assert.deepEqual(Object.keys(grouped), [
            "MARGYN-BLUE-001",
            "MARGYN-KRAFT-002",
          ]);
          assert.equal(grouped["MARGYN-BLUE-001"].length, 2);
          const response = await upload("stats");
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), {
            success: true,
            orders: 3,
            products: 2,
            pages: 4,
          });
        },
      );
      await t.test(
        "ZIP includes original label pages by SKU plus the original summary PDF",
        async () => {
          const response = await upload("process");
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("content-type"), "application/zip");
          assert.match(
            response.headers.get("content-disposition"),
            /Sorted-Orders.zip/,
          );
          const zip = await JSZip.loadAsync(await response.arrayBuffer());
          assert.deepEqual(Object.keys(zip.files).sort(), [
            "MARGYN-BLUE-001.pdf",
            "MARGYN-KRAFT-002.pdf",
            "Summary.pdf",
          ]);
          for (const [name, count] of [
            ["MARGYN-BLUE-001.pdf", 2],
            ["MARGYN-KRAFT-002.pdf", 1],
            ["Summary.pdf", 1],
          ]) {
            const bytes = await zip.file(name).async("nodebuffer");
            assert.equal((await PDFDocument.load(bytes)).getPageCount(), count);
            const text = (
              await readPdf(Buffer.from(Uint8Array.from(bytes).buffer))
            )
              .map((page) => page.text)
              .join(" ");
            if (name !== "Summary.pdf") {
              assert.ok(text.includes(name.replace(".pdf", "")));
              assert.ok(!text.includes("Instructions only"));
            } else assert.ok(text.includes("ORDER SUMMARY"));
          }
        },
      );
      await t.test(
        "standalone summary download is a readable PDF",
        async () => {
          const response = await upload("summary");
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("content-type"), "application/pdf");
          assert.match(
            response.headers.get("content-disposition"),
            /Order-Summary.pdf/,
          );
          const bytes = Buffer.from(await response.arrayBuffer());
          assert.ok((await readPdf(bytes))[0].text.includes("MARGYN-BLUE-001"));
        },
      );
      await t.test(
        "invalid files, missing orders and malformed multipart input fail without leaking file paths",
        async () => {
          for (const response of [
            await upload("process", Buffer.from("not a PDF")),
            await upload("process", input, "text/plain", "labels.txt"),
            await upload("process", Buffer.alloc(0)),
            await upload("process", await makeShippingPdf({ orders: false })),
            await upload(
              "process",
              input,
              "application/pdf",
              "labels.pdf",
              true,
            ),
          ]) {
            assert.equal(response.status, 400);
            assert.ok(!(await response.text()).includes(tmpdir()));
          }
          assert.equal(
            (
              await request("/tools/shipping-labels/process", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              })
            ).status,
            415,
          );
          assert.equal((await upload("unknown")).status, 404);
          const form = new FormData();
          form.append(
            "file",
            new Blob([input], { type: "application/pdf" }),
            "labels.pdf",
          );
          assert.equal(
            (
              await request("/tools/shipping-labels/process", {
                method: "POST",
                headers: { Origin: "https://untrusted.invalid" },
                body: form,
              })
            ).status,
            403,
          );
        },
      );
      await t.test(
        "per-user and global worker slots are released, with no leftover PDFs",
        async () => {
          const releaseA = reserveShippingSlot("test-A");
          assert.throws(
            () => reserveShippingSlot("test-A"),
            (error) => error.status === 429,
          );
          const releaseB = reserveShippingSlot("test-B");
          assert.throws(
            () => reserveShippingSlot("test-C"),
            (error) => error.status === 429,
          );
          releaseA();
          releaseB();
          const releaseC = reserveShippingSlot("test-C");
          releaseC();
          const releaseAgain = reserveShippingSlot("test-C");
          releaseC(); // A previous request must not release a newer request's slot.
          assert.throws(
            () => reserveShippingSlot("test-C"),
            (error) => error.status === 429,
          );
          releaseAgain();
          const files = await readdir(
            join(tmpdir(), "margyn-shipping-labels"),
          ).catch(() => []);
          assert.equal(files.length, 0);
          const provenance = JSON.parse(
            await readFile(
              new URL(
                "../src/tools/shipping-labels/provenance.json",
                import.meta.url,
              ),
            ),
          );
          assert.equal(Object.keys(provenance.files).length, 6);
        },
      );
      await request("/auth/logout", { method: "POST" });
      assert.equal((await upload("process")).status, 401);
    } finally {
      await runtime.close();
    }
  },
);
