// Reused from the supplied image-generator project. See provenance.json.
export const CHARM_ATTACHMENT_INSTRUCTION = `Attach the uploaded charm to the phone CASE at a suitable bottom-edge anchor using its actual attachment end. Inspect the raw charm first: it may be a wristlet, beaded loop, chain, cord, pendant, keyring, plush charm, clip, lobster clasp, or another accessory. Use its existing clasp, ring, hook or cord. If the case needs an anchor, add only a small, discreet functional lanyard tab, eyelet or short cord loop. Show how that anchor joins the case and how the uploaded attachment joins the anchor. The junction must look physically connected, not like two separate products placed nearby. Never attach it to a finger or sleeve. Do not force a round ring, purple bow, bead loop or any other example design onto the upload.

Compose the entire charm near/below the bottom of the case with its focal pieces and attachment visible. Flexible cords and chains may drape naturally; solid pendants keep their shape. Choose the phone angle, hand pose, scale and arrangement to suit this product. Keep the complete accessory inside the frame and give its outline enough space to read clearly. Natural overlap at the attachment and consistent contact shadows are desirable. Match perspective, light direction, exposure, color and material reflections so the two products belong in one photograph. Preserve the uploaded cover's body proportions and artwork, and the uploaded charm's components, colors and materials. Do not stretch either product to fit the frame.`;
export const HAND_COMPOSITION_INSTRUCTION = `Create a fresh square ecommerce photograph of a hand holding the uploaded phone cover with the uploaded charm attached to it. The uploads describe the PRODUCTS, not a layout to reproduce. Choose a natural grip and composition that clearly presents both products. Keep believable phone-to-hand proportions and make room for the full charm. There is no prescribed phone tilt, canvas percentage, hand identity or charm pose.

${CHARM_ATTACHMENT_INSTRUCTION}

Use polished product lighting, crisp artwork and natural skin. Keep empty canvas perfectly flat pure chroma green (#00FF00), including any open space inside a loop, for background removal. Do not cast shadows onto the green background or add green spill. Output only the photograph.`;
export const FLATLAY_COMPOSITION_INSTRUCTION = `Create a fresh vertical studio product photograph of the uploaded phone cover with the uploaded charm physically attached. Arrange the products attractively on a clean white background with soft contact shadows. The raw uploads are product references only; do not copy their table, backdrop, lighting or arrangement. Choose a new composition suited to this charm. Show the complete cover and complete accessory. Do not add hands, scenery, extra products, labels or decorative props.

${CHARM_ATTACHMENT_INSTRUCTION}

Output only the photograph.`;
export const HAND_REVIEW_CHECKS = [
    "attachmentConnected",
    "charmFullyVisible",
    "designsPreserved",
    "naturalBlend",
];
export const HAND_COMPOSITION_REVIEW_PROMPT = `Review IMAGE 1 (uploaded charm), IMAGE 2 (finished cover with attached charm), and IMAGE 3 (uploaded cover). Evaluate the product photograph, not whether it copies a particular layout. A neutral background in the finished preview is only for viewing transparency.

Return JSON with "checks" and "issues". "checks" contains four booleans:
- attachmentConnected: the accessory has a credible visible physical connection to the CASE near its bottom edge. Accept the appropriate existing clasp, hook, ring, clip or cord and a small functional case tab, eyelet or cord adapter when needed. A clasp need not be a round ring. A clear tab may be subtle or partly overlapped. Fail for a clearly floating/disconnected charm, an attachment to the hand rather than the case, or an impossible connection.
- charmFullyVisible: the accessory and its focal pieces are inside the frame and readable. Natural overlap at the attachment is allowed. Fail if a substantial part is cropped, hidden behind the phone/hand or missing. Do not insist on an open wristlet loop for a pendant, chain, cord, plush charm or another shape.
- designsPreserved: cover artwork and the charm's recognizable components, colors, materials and structure match the uploads. Pose, flexible drape, reflections and viewing angle can differ. Fail for an obvious substituted, duplicated, removed or redesigned product feature. Do not invent exact counts when the raw photograph does not clearly establish them.
- naturalBlend: the phone keeps plausible physical proportions and the products share believable scale, perspective and lighting. Fail for obvious stretching, a gross scale mismatch or conspicuous pasted-on edges. Any natural phone orientation, hand grip, canvas occupancy and charm arrangement is allowed.

Mark a check false only for a visible defect in that criterion; uncertainty about the pose, exact pixel distances or an unclear microscopic bead count is not a defect. Give brief concrete repair instructions for failed checks in "issues", especially how to join the actual attachment end to the case. If all four pass, issues is empty. Return all four booleans and the issues array, with no prose.`;
export function parseHandCompositionReview(text) {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let value;
    try {
        value = JSON.parse(cleaned);
    }
    catch {
        throw new Error("The attachment review could not be read. Please retry this view.");
    }
    if (!value || typeof value !== "object")
        throw new Error("The attachment review was incomplete.");
    const review = value;
    if (!review.checks ||
        HAND_REVIEW_CHECKS.some((key) => typeof review.checks?.[key] !== "boolean") ||
        !Array.isArray(review.issues) ||
        review.issues.some((issue) => typeof issue !== "string"))
        throw new Error("The attachment review was incomplete. Please retry this view.");
    return { checks: review.checks, issues: review.issues };
}
const FAILURE_LABELS = {
    attachmentConnected: "Join the charm's actual attachment end visibly to the case anchor.",
    charmFullyVisible: "Keep the complete charm and its focal pieces visible inside the frame.",
    designsPreserved: "Restore the uploaded cover and charm designs without substitutions.",
    naturalBlend: "Match product scale, perspective and lighting without stretching.",
};
// Review every rendered attempt. A failed service call never approves an image.
export async function generateReviewedHand(options) {
    let correction = "";
    let previous;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const rendered = await options.render(correction, previous);
        const review = await options.review(rendered);
        const failures = HAND_REVIEW_CHECKS.filter((key) => review.checks[key] !== true);
        // General stylistic suggestions do not block an otherwise valid attachment.
        if (!failures.length)
            return rendered;
        correction = [...failures.map((key) => FAILURE_LABELS[key]), ...review.issues].join(" ").slice(0, 1600);
        previous = rendered;
    }
    throw new Error(`This view still needs an attachment repair: ${correction}`);
}
