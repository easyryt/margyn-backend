// Reused from the supplied image-generator project. See provenance.json.
import { getProviderOptions } from "../../../lib/ai-provider.mjs";
export async function GET() {
    return Response.json({ providers: getProviderOptions() }, { headers: { "Cache-Control": "no-store" } });
}
