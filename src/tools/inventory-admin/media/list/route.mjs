import ImageKit from "../../imagekit.mjs";
import { NextResponse } from "../../web-response.mjs";
function getImageKit() {
    const publicKey = process.env.IMAGEKIT_PUBLIC_KEY;
    const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
    const urlEndpoint = process.env.IMAGEKIT_URL_ENDPOINT;
    if (!publicKey || !privateKey || !urlEndpoint) {
        throw new Error("ImageKit environment variables are not configured.");
    }
    return new ImageKit({ publicKey, privateKey, urlEndpoint });
}
export const dynamic = "force-dynamic";
const FOLDER = "product-designs"; // change if needed
export async function GET() {
    try {
        const imagekit = getImageKit();
        const files = await imagekit.listFiles({
            path: FOLDER,
            fileType: "image",
            limit: 1000,
        });
        const images = files.map((file) => ({
            fileId: file.fileId,
            name: file.name,
            url: file.url,
            thumbnail: file.thumbnail,
            height: file.height,
            width: file.width,
            size: file.size,
            createdAt: file.createdAt,
        }));
        return NextResponse.json({ images });
    }
    catch (error) {
        console.error("ImageKit list error:", error);
        return NextResponse.json({ message: "Failed to list images" }, { status: 500 });
    }
}
