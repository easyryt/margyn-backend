import { localListingOrigin, prepareMeeshoImage, resolveMeeshoImage } from "../../../lib/meesho-staging.mjs";
export const runtime = "nodejs";
const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/;
function headers(request) {
    const origin = request.headers.get("origin") || "";
    return { "Cache-Control": "no-store", ...(extensionOrigin.test(origin) ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}) };
}
export async function OPTIONS(request) {
    if (!localListingOrigin(new URL(request.url).origin) || !extensionOrigin.test(request.headers.get("origin") || ""))
        return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: { ...headers(request), "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type, X-Listing-Extension" } });
}
export async function POST(request) {
    const responseHeaders = headers(request);
    try {
        const origin = new URL(request.url).origin, sender = request.headers.get("origin") || "";
        if (!localListingOrigin(origin))
            throw new Error("Native Meesho upload currently requires the listing tool running locally in Chrome.");
        if (request.headers.get("content-type") !== "application/json")
            throw new Error("JSON is required.");
        const reader = request.body?.getReader();
        if (!reader)
            throw new Error("Image request is empty.");
        const chunks = [];
        let length = 0;
        while (true) {
            const part = await reader.read();
            if (part.done)
                break;
            length += part.value.length;
            if (length > 5650000) {
                await reader.cancel();
                return Response.json({ error: "Image exceeds the 4 MB limit." }, { status: 413, headers: responseHeaders });
            }
            chunks.push(part.value);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (input.action === "prepare") {
            if (sender !== origin || request.headers.get("sec-fetch-site") === "cross-site")
                throw new Error("Choose the image in the local listing tool.");
            return Response.json(await prepareMeeshoImage(input), { headers: responseHeaders });
        }
        const id = request.headers.get("x-listing-extension") || "";
        if (input.action !== "resolve" || !/^[a-p]{32}$/.test(id) || (sender && sender !== `chrome-extension://${id}`))
            throw new Error("Only the connected extension may resolve this image.");
        return Response.json(await resolveMeeshoImage(input), { headers: responseHeaders });
    }
    catch (error) {
        const message = error instanceof Error && !/ENOENT|EEXIST/.test(error.message) ? error.message : "This upload operation is unavailable. Choose the image again.";
        return Response.json({ error: message }, { status: 400, headers: responseHeaders });
    }
}
