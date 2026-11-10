import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validMeeshoTarget } from "./meesho-upload-contract.mjs";
const ROOT = resolve(process.cwd(), ".local", "margyn-listing-staging");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
let pending = Promise.resolve();
export function localListingOrigin(value) { return ["http://localhost:3000", "http://127.0.0.1:3000"].includes(value); }
export async function prepareMeeshoImage(input, root = ROOT) {
    const previous = pending;
    let release;
    pending = new Promise(r => { release = r; });
    await previous;
    try {
        if (!UUID.test(input?.jobId || "") || !validMeeshoTarget(input.target))
            throw new Error("Invalid image destination.");
        const f = input.file;
        if (!f || !["image/png", "image/jpeg"].includes(f.type) || typeof f.base64 !== "string" || f.base64.length > 5592408 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64))
            throw new Error("Choose a PNG or JPG up to 4 MB.");
        const bytes = Buffer.from(f.base64, "base64");
        const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const jpg = bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        if (!bytes.length || bytes.length > 4194304 || !(f.type === "image/png" ? png : jpg))
            throw new Error("The selected image contents do not match its format.");
        await mkdir(root, { recursive: true });
        const folders = (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory() && UUID.test(d.name));
        let total = 0;
        for (const d of folders) {
            try {
                total += JSON.parse(await readFile(join(root, d.name, "metadata.json"), "utf8")).bytes;
            }
            catch { /* Incomplete staging directories still count toward the file limit. */ }
        }
        if (folders.length >= 250 || total + bytes.length > 100 * 1024 * 1024)
            throw new Error("Local upload storage is full (250 images / 100 MB).");
        const token = randomBytes(32).toString("hex"), filename = `browser-ai-meesho-test-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${input.jobId.slice(0, 8)}.${png ? "png" : "jpg"}`;
        const metadata = { id: input.jobId, filename, originalName: String(f.name || "image").replace(/[\x00-\x1f\\/]/g, "_").slice(0, 150), type: f.type,
            bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), target: input.target, tokenHash: createHash("sha256").update(token).digest("hex") };
        const folder = join(root, input.jobId);
        await mkdir(folder); // An operation ID can never be reused with different bytes.
        await writeFile(join(folder, filename), bytes, { flag: "wx", mode: 0o600 });
        await writeFile(join(folder, "metadata.json"), JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
        const { tokenHash: _private, ...descriptor } = metadata;
        void _private;
        return { ...descriptor, token };
    }
    finally {
        release();
    }
}
export async function resolveMeeshoImage(input, root = ROOT) {
    if (!UUID.test(input?.jobId || "") || !/^[a-f0-9]{64}$/.test(input.token || ""))
        throw new Error("Invalid staged-image authorization.");
    const meta = JSON.parse(await readFile(join(root, input.jobId, "metadata.json"), "utf8"));
    const hash = createHash("sha256").update(input.token).digest();
    if (!timingSafeEqual(hash, Buffer.from(meta.tokenHash, "hex")))
        throw new Error("Staged-image authorization failed.");
    const path = join(root, input.jobId, meta.filename), bytes = await readFile(path);
    if (bytes.length !== meta.bytes || createHash("sha256").update(bytes).digest("hex") !== meta.sha256)
        throw new Error("The staged image changed. Choose it again.");
    return { path, filename: meta.filename, type: meta.type, bytes: meta.bytes, sha256: meta.sha256, target: meta.target };
}
