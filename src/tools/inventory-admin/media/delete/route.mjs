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
export async function DELETE(request) {
    try {
        const imagekit = getImageKit();
        const { fileId } = await request.json();
        if (!fileId) {
            return NextResponse.json({ message: "fileId is required" }, { status: 400 });
        }
        await imagekit.deleteFile(fileId);
        return NextResponse.json({ message: "File deleted successfully" });
    }
    catch (error) {
        console.error("ImageKit delete error:", error);
        return NextResponse.json({ message: error.message || "Failed to delete file" }, { status: 500 });
    }
}
