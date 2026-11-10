import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { readPdf } from "./readPdf.mjs";
import { extractOrder } from "./extractOrder.mjs";
import { groupOrders } from "./groupOrders.mjs";
import { splitPdfByGroups } from "./splitPdf.mjs";
import { createSummaryPdf } from "./createSummaryPdf.mjs";
import { createZip } from "./createZip.mjs";

try {
  const buffer = await readFile(workerData.filePath);
  if (
    !buffer.length ||
    !buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))
  )
    throw new Error("invalid-pdf");
  const pages = await readPdf(buffer);
  const orders = [];
  for (const page of pages) {
    try {
      const order = extractOrder(page.text, page.pageNumber);
      if (order && order.sku && order.orderNo && order.productName)
        orders.push(order);
    } catch {
      /* Preserve the original process route's per-page skip behavior. */
    }
  }
  const grouped = groupOrders(orders, "sku");
  const stats = {
    orders: orders.length,
    products: Object.keys(grouped).length,
    pages: pages.length,
  };
  if (workerData.action === "stats") {
    parentPort.postMessage({ stats });
  } else if (!orders.length) {
    parentPort.postMessage({
      error:
        "No valid orders were found in this PDF. Upload text-based shipping labels with SKU and order numbers.",
      status: 400,
    });
  } else {
    const summary = await createSummaryPdf(grouped);
    const output =
      workerData.action === "summary"
        ? summary
        : await createZip(summary, await splitPdfByGroups(buffer, grouped));
    const bytes = Uint8Array.from(output);
    parentPort.postMessage({ bytes, stats }, [bytes.buffer]);
  }
} catch {
  parentPort.postMessage({
    error:
      "We couldn’t read this PDF. Choose an unencrypted, text-based shipping-label PDF and try again.",
    status: 400,
  });
}
