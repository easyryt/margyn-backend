import designs from "./original/src/routes/designs.mjs";
import { meteredFetch } from "../../services/ai-usage.mjs";
import { listingUserId } from "./mongoose-context.mjs";
import { storeUserImage, userImageFolder } from "../../services/storage-allowance.mjs";
import { AppError } from "../../services/errors.mjs";

// The original AI scanner saves generated designs through its original router.
// Dispatch that single internal request without a public endpoint or shared data.
export async function listingFetch(input, options) {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.origin === "https://upload.imagekit.io" && url.pathname === "/api/v1/files/upload") {
    const form = options?.body;
    if (!(form instanceof FormData) || !(form.get("file") instanceof Blob)) throw new AppError("Choose a valid listing image.");
    const userId = listingUserId();
    try {
      const result = await storeUserImage(userId, { file: form.get("file"), fileName: String(form.get("fileName") || "listing.png"),
        folder: userImageFolder(userId) + "/listings", tags: String(form.get("tags") || "ai-listing") });
      return Response.json(result);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return Response.json({ message: error.message, error: { message: error.message } }, { status: error.status });
    }
  }
  if (url.origin !== "http://margyn-listing.internal") return meteredFetch(input, options);
  if (url.pathname !== "/api/designs" || options?.method !== "POST") throw new Error("Unsupported internal listing request.");
  return new Promise((resolve, reject) => {
    const req = { method: "POST", url: "/", body: JSON.parse(options.body), headers: { "content-type": "application/json" } };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve(Response.json(body, { status: this.statusCode })); return this; } };
    designs.handle(req, res, error => error ? reject(error) : resolve(Response.json({ message: "Design action not found." }, { status: 404 })));
  });
}
