// Reused from the supplied image-generator project. See provenance.json.
const families = [
    ["iphone-se-3", "iPhone SE (3rd generation)", 1, "single"],
    ["iphone-12-mini", "iPhone 12 mini", 2, "dual-vertical"],
    ["iphone-12", "iPhone 12", 2, "dual-vertical"],
    ["iphone-12-pro", "iPhone 12 Pro", 3, "triple"],
    ["iphone-12-pro-max", "iPhone 12 Pro Max", 3, "triple"],
    ["iphone-13-mini", "iPhone 13 mini", 2, "dual-diagonal"],
    ["iphone-13", "iPhone 13", 2, "dual-diagonal"],
    ["iphone-13-pro", "iPhone 13 Pro", 3, "triple"],
    ["iphone-13-pro-max", "iPhone 13 Pro Max", 3, "triple"],
    ["iphone-14", "iPhone 14", 2, "dual-diagonal"],
    ["iphone-14-plus", "iPhone 14 Plus", 2, "dual-diagonal"],
    ["iphone-14-pro", "iPhone 14 Pro", 3, "triple"],
    ["iphone-14-pro-max", "iPhone 14 Pro Max", 3, "triple"],
    ["iphone-15", "iPhone 15", 2, "dual-diagonal"],
    ["iphone-15-plus", "iPhone 15 Plus", 2, "dual-diagonal"],
    ["iphone-15-pro", "iPhone 15 Pro", 3, "triple"],
    ["iphone-15-pro-max", "iPhone 15 Pro Max", 3, "triple"],
    ["iphone-16", "iPhone 16", 2, "dual-vertical"],
    ["iphone-16-plus", "iPhone 16 Plus", 2, "dual-vertical"],
    ["iphone-16-pro", "iPhone 16 Pro", 3, "triple"],
    ["iphone-16-pro-max", "iPhone 16 Pro Max", 3, "triple"],
    ["iphone-16e", "iPhone 16e", 1, "single"],
];
export const PHONE_MODELS = families.map(([id, label, rearCameras, cameraLayout]) => ({ id, label, rearCameras, cameraLayout }));
export const DEFAULT_PHONE_MODEL = "iphone-13";
export function getPhoneModel(value) {
    return PHONE_MODELS.find((model) => model.id === (value ?? DEFAULT_PHONE_MODEL)) ?? null;
}
export function phoneModelInstruction(model) {
    const layout = model.cameraLayout === "triple"
        ? "THREE large rear lenses in the model's triangular Pro camera cluster, with the correct flash and LiDAR sensor. The flash and LiDAR are not additional camera lenses"
        : model.cameraLayout === "single" ? "ONE rear camera lens with its flash; do not add a second or third lens"
            : model.cameraLayout === "dual-diagonal" ? "TWO rear camera lenses arranged diagonally inside the camera island, with the flash"
                : "TWO rear camera lenses arranged vertically, with the flash in the correct position";
    return `PHONE HARDWARE OVERRIDE — ${model.label}: show exactly ${model.rearCameras} rear camera ${model.rearCameras === 1 ? "lens" : "lenses"} on EVERY phone. Use ${layout}. Render this model's believable body proportions, camera island, lens sizes, buttons and case opening, not the template's phone hardware. Adapt the camera cutout only as needed for the selected model; retain the uploaded case artwork everywhere else. Keep the scene's phone position, perspective, outer framing and natural hand grip. Never stretch the phone. An empty opening in the raw cover does not specify a lens count. The selected model controls hardware; the raw image controls artwork. A mockup is not proof of physical case compatibility.`;
}
