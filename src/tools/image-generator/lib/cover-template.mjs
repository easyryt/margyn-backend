// Reused from the supplied image-generator project. See provenance.json.
import sharp from "sharp";
export const COVER_OUTPUT_SIZE = 1080;
// Full, unoccluded phone rectangles: top-left, top-right, bottom-right, bottom-left.
// Coordinates are in each source's normalized frame, before square padding.
const PHONE_QUADS = {
    "hand-closeup": [[[294, 124], [699, 18], [942, 847], [536, 938]]],
    "drop-protection": [[[-16, 212], [334, -9], [824, 747], [472, 979]]],
    "model-selfie": [[[349, 30], [519, 106], [323, 490], [154, 414]]],
    "three-cases": [
        [[2, 352], [320, 198], [605, 835], [278, 965]].map(([x, y]) => [x / 1.08, y / 1.08]),
        [[739, 212], [1069, 319], [859, 987], [531, 882]].map(([x, y]) => [x / 1.08, y / 1.08]),
        [[355, 177], [729, 177], [729, 927], [355, 927]].map(([x, y]) => [x / 1.08, y / 1.08]),
    ],
};
// Phone planes in the supplied, immutable templates, in a normalized 1000² frame.
// These are scene masks, not product artwork. The fan paths use native 1080px
// coordinates to preserve its narrow original rims and overlap seams.
const PHONE_PATHS = {
    "hand-closeup": ["M330 115 L655 32 Q702 17 715 62 L926 800 Q940 844 896 857 L584 925 Q541 936 530 895 L307 176 Q296 132 330 115Z"],
    "drop-protection": ["M31 184 L291 25 Q325 5 351 36 L792 700 Q818 741 782 769 L523 951 Q479 981 452 936 L23 272 Q0 231 31 184Z"],
    "model-selfie": ["M342 51 Q358 37 382 48 L500 101 Q521 111 509 137 L337 458 Q324 480 301 469 L179 413 Q157 402 169 380Z"],
    "three-cases": [
        "M57 336 L274 230 Q310 214 339 247 L601 827 Q612 850 582 863 L329 955 Q301 970 279 936 L38 417 Q21 379 57 336Z",
        "M785 233 L1017 310 Q1054 325 1046 363 L866 939 Q854 980 820 976 L572 893 Q543 881 552 844 L738 268 Q748 230 785 233Z",
        "M416 188 L658 188 Q716 188 717 244 L718 858 Q717 919 659 920 L416 920 Q367 919 367 858 L366 244 Q367 188 416 188Z",
    ],
};
const FAN_FRONT_OUTLINE = "M416 177 L658 177 Q726 177 728 242 L729 858 Q728 926 659 927 L416 927 Q357 925 356 859 L355 242 Q356 178 416 177Z";
function erodeMask(mask, width, height) {
    const output = new Uint8Array(mask.length);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            let value = 255;
            for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++)
                    value = Math.min(value, mask[Math.max(0, Math.min(height - 1, y + dy)) * width + Math.max(0, Math.min(width - 1, x + dx))]);
            output[y * width + x] = value;
        }
    return output;
}
function dilateMask(mask, width, height) {
    const inverted = Uint8Array.from(mask, (value) => 255 - value);
    return Uint8Array.from(erodeMask(inverted, width, height), (value) => 255 - value);
}
function medianMask(mask, width, height) {
    const output = new Uint8Array(mask.length);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            let count = 0;
            for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++)
                    if (mask[Math.max(0, Math.min(height - 1, y + dy)) * width + Math.max(0, Math.min(width - 1, x + dx))] >= 128)
                        count++;
            output[y * width + x] = count >= 5 ? 255 : 0;
        }
    return output;
}
async function featherMask(mask, width, height, sigma = .6) {
    const blurred = await sharp(Buffer.from(mask), { raw: { width, height, channels: 1 } }).blur(sigma).greyscale().raw().toBuffer();
    for (let p = 0; p < blurred.length; p++) {
        // Keep a narrow subpixel transition, with exact opaque/empty interiors.
        const t = Math.max(0, Math.min(1, (blurred[p] / 255 - .04) / .92));
        blurred[p] = Math.round(t * t * (3 - 2 * t) * 255);
    }
    return blurred;
}
function nearestCoreColor(core, width, height, p, radius = 4) {
    const x = p % width, y = Math.floor(p / width);
    let closest = -1, distance = Infinity;
    for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx, yy = y + dy, d = dx * dx + dy * dy;
            if (xx < 0 || xx >= width || yy < 0 || yy >= height || d >= distance)
                continue;
            const q = yy * width + xx;
            if (core[q] < 250)
                continue;
            closest = q;
            distance = d;
        }
    return closest;
}
/** Clean only an existing transparent silhouette; never enlarge or blur its interior. */
export async function refineCutoutEdges(image) {
    const { data: rgba, info } = await sharp(image).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info, count = width * height;
    let transparent = 0;
    const solid = new Uint8Array(count), seen = new Uint8Array(count), queue = new Int32Array(count);
    for (let p = 0; p < count; p++) {
        if (rgba[p * 4 + 3] < 16)
            transparent++;
        solid[p] = rgba[p * 4 + 3] >= 128 ? 255 : 0;
    }
    if (transparent < count * .01)
        return image; // Opaque lifestyle scenes must stay exact.
    const clean = new Uint8Array(count), minimumArea = Math.max(8, Math.min(64, Math.round(count * .00002)));
    for (let start = 0; start < count; start++) {
        if (!solid[start] || seen[start])
            continue;
        let head = 0, tail = 1;
        queue[0] = start;
        seen[start] = 1;
        while (head < tail) {
            const p = queue[head++], x = p % width;
            for (const n of [p - 1, p + 1, p - width, p + width]) {
                if (n < 0 || n >= count || seen[n] || !solid[n] || Math.abs(n % width - x) > 1)
                    continue;
                seen[n] = 1;
                queue[tail++] = n;
            }
        }
        if (tail >= minimumArea)
            for (let i = 0; i < tail; i++)
                clean[queue[i]] = 255;
    }
    // libvips rounds a .55 sigma down to an identity kernel; use an effective
    // subpixel blur so this is genuinely antialiased, not a binary eroded edge.
    const matte = await featherMask(erodeMask(medianMask(clean, width, height), width, height), width, height, .7);
    const core = erodeMask(erodeMask(clean, width, height), width, height), output = Buffer.from(rgba);
    for (let p = 0; p < count; p++) {
        const i = p * 4, alpha = Math.min(rgba[i + 3], matte[p]);
        output[i + 3] = alpha;
        if (!alpha) {
            output[i] = 0;
            output[i + 1] = 0;
            output[i + 2] = 0;
            continue;
        }
        if (alpha >= 250)
            continue;
        const q = nearestCoreColor(core, width, height, p);
        if (q >= 0)
            for (let c = 0; c < 3; c++)
                output[i + c] = rgba[q * 4 + c];
    }
    return sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
// Remove isolated printed colors from the hand detector. Real hand components
// are large; enclosed nail/highlight holes are filled before padding their edges.
function handOcclusions(rgba, width, height, layout, minimumContrast = 23) {
    const count = width * height;
    const skin = new Uint8Array(count), seen = new Uint8Array(count), result = new Uint8Array(count);
    const queue = new Int32Array(count);
    for (let pixel = 0; pixel < count; pixel++) {
        const i = pixel * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        const x = pixel % width / width, y = Math.floor(pixel / width) / height;
        const handRegion = layout === "three-cases" ? x < .61 && y > .61 : layout === "hand-closeup" ? y > .27 && (x < .5 || x > .70) : x < .35 || (x > .4 && y < .22);
        if (!handRegion)
            continue;
        const skinColor = r > 110 && g > 65 && b > 40 && r - g > minimumContrast && r - g < 100 && g - b > 1 && r - b > minimumContrast + 17 && r - b < 150;
        if (rgba[i + 3] > 0 && skinColor)
            skin[pixel] = 1;
    }
    for (let start = 0; start < count; start++) {
        if (!skin[start] || seen[start])
            continue;
        let head = 0, tail = 1;
        queue[0] = start;
        seen[start] = 1;
        while (head < tail) {
            const p = queue[head++], x = p % width;
            for (const n of [p - 1, p + 1, p - width, p + width]) {
                if (n < 0 || n >= count || seen[n] || !skin[n] || Math.abs(n % width - x) > 1)
                    continue;
                seen[n] = 1;
                queue[tail++] = n;
            }
        }
        if (tail > count * .0003)
            for (let i = 0; i < tail; i++)
                result[queue[i]] = 255;
    }
    seen.fill(0);
    let head = 0, tail = 0;
    for (let p = 0; p < count; p++) {
        const x = p % width, y = Math.floor(p / width);
        if ((x === 0 || y === 0 || x === width - 1 || y === height - 1) && !result[p] && !seen[p]) {
            seen[p] = 1;
            queue[tail++] = p;
        }
    }
    while (head < tail) {
        const p = queue[head++], x = p % width;
        for (const n of [p - 1, p + 1, p - width, p + width]) {
            if (n < 0 || n >= count || seen[n] || result[n] || Math.abs(n % width - x) > 1)
                continue;
            seen[n] = 1;
            queue[tail++] = n;
        }
    }
    for (let start = 0; start < count; start++) {
        if (seen[start] || result[start])
            continue;
        head = 0;
        tail = 1;
        queue[0] = start;
        seen[start] = 1;
        while (head < tail) {
            const p = queue[head++], x = p % width;
            for (const n of [p - 1, p + 1, p - width, p + width]) {
                if (n < 0 || n >= count || seen[n] || result[n] || Math.abs(n % width - x) > 1)
                    continue;
                seen[n] = 1;
                queue[tail++] = n;
            }
        }
        if (tail < count * .005)
            for (let i = 0; i < tail; i++)
                result[queue[i]] = 255;
    }
    return result;
}
export async function prepareCoverTemplate(source, layout) {
    const metadata = await sharp(source).metadata();
    const width = metadata.width, height = metadata.height;
    if (!width || !height)
        throw new Error("The layout template has invalid dimensions.");
    const size = Math.max(width, height);
    const padding = { left: Math.floor((size - width) / 2), right: Math.ceil((size - width) / 2), top: Math.floor((size - height) / 2), bottom: Math.ceil((size - height) / 2), background: { r: 0, g: 0, b: 0, alpha: 0 } };
    // Materialize padding first: Sharp otherwise applies resize before extend.
    const padded = await sharp(source).rotate().ensureAlpha().extend(padding).png().toBuffer();
    const originalCanvas = await sharp(padded).resize(COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE).png().toBuffer();
    const viewBoxSize = layout === "three-cases" ? 1080 : 1000;
    const raster = async (d) => {
        const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" preserveAspectRatio="none"><rect width="${viewBoxSize}" height="${viewBoxSize}" fill="black"/><path d="${d}" fill="white"/></svg>`);
        const padded = await sharp(svg).extend(padding).png().toBuffer();
        return sharp(padded).resize(COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE).removeAlpha().greyscale().raw().toBuffer();
    };
    const planeMasks = await Promise.all(PHONE_PATHS[layout].map(raster));
    if (layout === "three-cases") {
        // Back phones cannot paint through the FRONT phone's original clear rim.
        // Subtract its complete silhouette, not merely its smaller editable back.
        const foreground = await raster(FAN_FRONT_OUTLINE);
        for (const back of planeMasks.slice(0, 2))
            for (let p = 0; p < back.length; p++)
                back[p] = Math.round(back[p] * (1 - foreground[p] / 255));
    }
    const mask = Buffer.alloc(COVER_OUTPUT_SIZE ** 2);
    for (const plane of planeMasks)
        for (let p = 0; p < mask.length; p++)
            mask[p] = Math.max(mask[p], plane[p]);
    const rgba = await sharp(originalCanvas).toColourspace("srgb").ensureAlpha().raw().toBuffer();
    const untouched = Buffer.from(rgba);
    if (mask.length !== COVER_OUTPUT_SIZE ** 2 || rgba.length !== COVER_OUTPUT_SIZE ** 2 * 4)
        throw new Error("Unexpected template pixel format.");
    let contactShadow;
    if (layout !== "drop-protection") {
        const detected = handOcclusions(rgba, COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE, layout, layout === "three-cases" ? 23 : 16);
        const nailPaths = layout === "model-selfie"
            ? 'M309 365 C316 361 335 360 343 366 C350 373 343 382 334 385 C324 388 311 387 307 383 C301 378 302 371 309 365Z M325 428 C335 423 349 423 355 429 C361 436 354 444 348 447 C338 451 326 450 322 446 C316 442 315 433 325 428Z'
            : layout === "three-cases" ? 'M481 827 C475 820 477 809 486 799 C500 781 519 764 537 756 C547 750 557 757 560 767 C569 797 553 829 534 851 C521 870 501 868 488 853 C481 846 478 836 481 827Z'
                : layout === "hand-closeup" ? 'M415 419 Q420 411 428 405 L431 423 Q425 445 405 477 Q399 485 393 487 L401 451Z' : "";
        if (nailPaths) {
            const hint = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><path d="${nailPaths}" fill="white" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>`)).ensureAlpha().extractChannel(3).raw().toBuffer();
            for (let p = 0; p < detected.length; p++)
                if (hint[p] >= 128)
                    detected[p] = 255;
        }
        const closed = erodeMask(dilateMask(detected, COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE), COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE);
        const skin = medianMask(closed, COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE);
        const occlusion = await featherMask(skin, COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE, .8);
        const nearby = await sharp(occlusion, { raw: { width: COVER_OUTPUT_SIZE, height: COVER_OUTPUT_SIZE, channels: 1 } }).blur(1.4).greyscale().raw().toBuffer();
        contactShadow = Buffer.alloc(mask.length);
        const core = erodeMask(erodeMask(skin, COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE), COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE), source = Buffer.from(rgba);
        for (let p = 0; p < mask.length; p++) {
            if (!mask[p])
                continue;
            contactShadow[p] = Math.round(Math.max(0, nearby[p] - occlusion[p]) * .22);
            // Source antialias pixels contain a trace of the old case design. Replace
            // only that narrow transition's foreground RGB with clean nearby skin/nail
            // color before blending it over the new phone, once.
            if (occlusion[p] > 0 && occlusion[p] < 255) {
                const q = nearestCoreColor(core, COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE, p);
                if (q >= 0)
                    for (let c = 0; c < 3; c++)
                        rgba[p * 4 + c] = source[q * 4 + c];
            }
            mask[p] = Math.round(mask[p] * (1 - occlusion[p] / 255));
        }
    }
    // Keep the input scene immutable, including its original transparent alpha.
    // Foreground RGB cleanup is a separate phone-edge layer; never bake it into
    // the reference, where it could change protected skin or silhouette pixels.
    const original = await sharp(untouched, { raw: { width: COVER_OUTPUT_SIZE, height: COVER_OUTPUT_SIZE, channels: 4 } }).png().toBuffer();
    const edgeForeground = await sharp(rgba, { raw: { width: COVER_OUTPUT_SIZE, height: COVER_OUTPUT_SIZE, channels: 4 } }).png().toBuffer();
    const plateSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" preserveAspectRatio="none"><rect width="${viewBoxSize}" height="${viewBoxSize}" fill="#f4f4f4"/>${PHONE_PATHS[layout].map((d, index) => `<path d="${d}" fill="${layout === "three-cases" ? ["#eadbdd", "#e7d7d9", "#f3f2ef"][index] : "#f1f0ed"}" stroke="#c4c1bc" stroke-width="1"/>`).join("")}</svg>`);
    const paddedPlate = await sharp(plateSvg).extend(padding).png().toBuffer();
    const plate = await sharp(paddedPlate).resize(COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE).removeAlpha().toColourspace("srgb").raw().toBuffer();
    const neutral = Buffer.from(untouched);
    for (let p = 0; p < mask.length; p++) {
        if (!rgba[p * 4 + 3]) {
            mask[p] = 0;
            continue;
        }
        if (!mask[p])
            continue;
        const weight = mask[p] / 255;
        for (let c = 0; c < 3; c++)
            neutral[p * 4 + c] = Math.round(rgba[p * 4 + c] * (1 - weight) + plate[p * 3 + c] * weight);
    }
    const planes = PHONE_QUADS[layout].map((quad, index) => {
        // Keep geometry and foreground coverage separate. Hand coverage is applied
        // once after every phone plane has been projected, including overlaps.
        return { mask: planeMasks[index], quad: quad.map(([x, y]) => [
                (x * width / 1000 + padding.left) * COVER_OUTPUT_SIZE / size,
                (y * height / 1000 + padding.top) * COVER_OUTPUT_SIZE / size,
            ]) };
    });
    return {
        original,
        edgeForeground,
        conditioning: await sharp(neutral, { raw: { width: COVER_OUTPUT_SIZE, height: COVER_OUTPUT_SIZE, channels: 4 } }).png().toBuffer(),
        editMask: mask,
        contactShadow,
        planes,
    };
}
/** Extract ONE upright product plate. Never reuse a generated hand or scene. */
export async function isolatePhonePlate(image) {
    const { data, info } = await sharp(image, { limitInputPixels: 40_000_000 }).rotate()
        .resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info, count = width * height;
    const background = new Uint8Array(count), seen = new Uint8Array(count), queue = new Int32Array(count);
    let transparentBorder = 0, border = 0;
    for (let p = 0; p < count; p++) {
        const x = p % width, y = Math.floor(p / width);
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
            border++;
            if (data[p * 4 + 3] < 16)
                transparentBorder++;
        }
    }
    const hasCutout = transparentBorder / border > .95;
    const isBackground = (p) => {
        const i = p * 4, r = data[i], g = data[i + 1], b = data[i + 2];
        return data[i + 3] < 16 || (!hasCutout && g > 95 && g - Math.max(r, b) > 50 && g > r * 1.45 && g > b * 1.25);
    };
    let head = 0, tail = 0;
    for (let p = 0; p < count; p++) {
        const x = p % width, y = Math.floor(p / width);
        if ((x === 0 || y === 0 || x === width - 1 || y === height - 1) && isBackground(p)) {
            background[p] = 1;
            queue[tail++] = p;
        }
    }
    while (head < tail) {
        const p = queue[head++], x = p % width;
        for (const n of [p - 1, p + 1, p - width, p + width]) {
            if (n < 0 || n >= count || background[n] || Math.abs(n % width - x) > 1 || !isBackground(n))
                continue;
            background[n] = 1;
            queue[tail++] = n;
        }
    }
    if (tail < count * .15)
        throw new Error("The provider did not return an isolated phone on the requested green/transparent background. No shifted scene was pasted into the template.");
    let largest = [], otherArea = 0;
    for (let start = 0; start < count; start++) {
        if (background[start] || seen[start])
            continue;
        head = 0;
        tail = 1;
        queue[0] = start;
        seen[start] = 1;
        while (head < tail) {
            const p = queue[head++], x = p % width;
            for (const n of [p - 1, p + 1, p - width, p + width]) {
                if (n < 0 || n >= count || seen[n] || background[n] || Math.abs(n % width - x) > 1)
                    continue;
                seen[n] = 1;
                queue[tail++] = n;
            }
        }
        if (tail > largest.length) {
            otherArea += largest.length;
            largest = Array.from(queue.subarray(0, tail));
        }
        else
            otherArea += tail;
    }
    let left = width, right = 0, top = height, bottom = 0;
    for (const p of largest) {
        const x = p % width, y = Math.floor(p / width);
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
    }
    const cropWidth = right - left + 1, cropHeight = bottom - top + 1, ratio = cropWidth / cropHeight;
    if (largest.length < count * .04 || ratio < .38 || ratio > .64 || largest.length / (cropWidth * cropHeight) < .88 || otherArea > largest.length * .015 || left <= 0 || top <= 0 || right >= width - 1 || bottom >= height - 1) {
        throw new Error("The generated product plate is cropped, tilted, includes extra objects or has implausible phone proportions. It was not stretched or overlaid with another hand. Regenerate only this view.");
    }
    const cutout = Buffer.from(data);
    for (let p = 0; p < count; p++)
        if (background[p])
            cutout[p * 4 + 3] = 0;
    // Keying is border-connected: a green printed motif enclosed by the phone is
    // never removed. Rounded source corners flatten to the neutral phone body;
    // the destination mask, not source padding, supplies the final rounded edge.
    const cropped = await sharp(cutout, { raw: { width, height, channels: 4 } })
        .extract({ left, top, width: cropWidth, height: cropHeight }).flatten({ background: "#f1f0ed" }).raw().toBuffer();
    return { data: cropped, width: cropWidth, height: cropHeight };
}
// Solve a projective mapping between four point pairs. Using inverse mapping
// avoids holes; bilinear sampling retains small lettering without source crop.
export function phoneProjection(from, to) {
    const rows = [];
    for (let i = 0; i < 4; i++) {
        const [x, y] = from[i], [u, v] = to[i];
        rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    for (let c = 0; c < 8; c++) {
        let pivot = c;
        for (let r = c + 1; r < 8; r++)
            if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c]))
                pivot = r;
        if (Math.abs(rows[pivot][c]) < 1e-10)
            throw new Error("Invalid phone-plane calibration.");
        [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
        const divisor = rows[c][c];
        for (let j = c; j <= 8; j++)
            rows[c][j] /= divisor;
        for (let r = 0; r < 8; r++) {
            if (r === c)
                continue;
            const factor = rows[r][c];
            for (let j = c; j <= 8; j++)
                rows[r][j] -= factor * rows[c][j];
        }
    }
    const h = rows.map((row) => row[8]);
    return (x, y) => {
        const d = h[6] * x + h[7] * y + 1;
        return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
    };
}
function despillPhoneRim(rgba, template) {
    for (const plane of template.planes) {
        const inverse = phoneProjection(plane.quad, [[0, 0], [1, 0], [1, 1], [0, 1]]);
        for (let p = 0; p < plane.mask.length; p++) {
            if (plane.mask[p] < 128)
                continue;
            if (template.editMask && template.editMask[p] < 128)
                continue;
            const [u, v] = inverse(p % COVER_OUTPUT_SIZE, Math.floor(p / COVER_OUTPUT_SIZE));
            if (Math.min(u, 1 - u, v, 1 - v) > .025)
                continue;
            const i = p * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], excess = g - Math.max(r, b);
            // Only a light, near-neutral cast on the outer rim: preserve dark/saturated
            // green print, all interior artwork, original hand pixels and alpha.
            if (Math.min(r, b) > 130 && excess > 10 && excess < 70)
                rgba[i + 1] = Math.max(r, b) + 2;
        }
    }
}
export async function removePhoneKeySpill(image, template) {
    const { data, info } = await sharp(image).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== COVER_OUTPUT_SIZE || info.height !== COVER_OUTPUT_SIZE)
        throw new Error("Phone-rim cleanup needs the finished scene dimensions.");
    despillPhoneRim(data, template);
    return sharp(data, { raw: { width: COVER_OUTPUT_SIZE, height: COVER_OUTPUT_SIZE, channels: 4 } }).png().toBuffer();
}
/** Project a phone-only plate into the fixed scene. No AI hand pixels are used. */
// Full-AI output owns its silhouette. Never reuse the template's hand/phone mask.
export async function finishFullAiCoverImage(generated, transparent) {
    const normalized = await sharp(generated, { limitInputPixels: 40_000_000 }).rotate().toColourspace("srgb")
        .resize(COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { data, info } = normalized;
    const count = info.width * info.height;
    let hasCutout = false;
    if (transparent) {
        let clear = 0, border = 0, clearBorder = 0;
        for (let p = 0; p < count; p++) {
            const isClear = data[p * 4 + 3] < 32;
            if (isClear)
                clear++;
            const x = p % info.width, y = Math.floor(p / info.width);
            if (!x || !y || x === info.width - 1 || y === info.height - 1) {
                border++;
                if (isClear)
                    clearBorder++;
            }
        }
        hasCutout = clear > count * .02 && clearBorder > border * .15;
        if (!hasCutout) {
            const seen = new Uint8Array(count), queue = new Int32Array(count);
            let head = 0, tail = 0;
            const enqueue = (p) => {
                if (seen[p])
                    return;
                const i = p * 4, dominance = data[i + 1] - Math.max(data[i], data[i + 2]);
                if (data[i + 1] < 110 || dominance < 45)
                    return;
                seen[p] = 1;
                queue[tail++] = p;
            };
            for (let x = 0; x < info.width; x++) {
                enqueue(x);
                enqueue((info.height - 1) * info.width + x);
            }
            for (let y = 0; y < info.height; y++) {
                enqueue(y * info.width);
                enqueue(y * info.width + info.width - 1);
            }
            while (head < tail) {
                const p = queue[head++], x = p % info.width;
                if (x)
                    enqueue(p - 1);
                if (x < info.width - 1)
                    enqueue(p + 1);
                if (p >= info.width)
                    enqueue(p - info.width);
                if (p < count - info.width)
                    enqueue(p + info.width);
            }
            let strong = 0;
            for (let n = 0; n < tail; n++) {
                const i = queue[n] * 4;
                if (data[i + 1] > 180 && data[i + 1] - Math.max(data[i], data[i + 2]) > 140)
                    strong++;
            }
            hasCutout = strong > count * .02;
            if (hasCutout)
                for (let n = 0; n < tail; n++) {
                    const i = queue[n] * 4, dominance = data[i + 1] - Math.max(data[i], data[i + 2]);
                    const alpha = Math.max(0, Math.min(255, Math.round(255 * (1 - dominance / 180))));
                    data[i + 3] = Math.min(data[i + 3], alpha);
                    if (!alpha) {
                        data[i] = 0;
                        data[i + 1] = 0;
                        data[i + 2] = 0;
                    }
                    else
                        data[i + 1] = Math.min(data[i + 1], Math.max(data[i], data[i + 2]) + 2);
                }
        }
    }
    const pixels = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
    const image = await (transparent && hasCutout ? pixels : pixels.flatten({ background: "#f4f2ee" }))
        .resize(COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE, { fit: "contain", background: transparent && hasCutout ? "#00000000" : "#f4f2ee" }).png().toBuffer();
    return { image: transparent && hasCutout ? await refineCutoutEdges(image) : image, backgroundReady: transparent && hasCutout };
}
export async function finishCoverImage(generated, template) {
    const phone = await isolatePhonePlate(generated);
    // Start with the foreground source, not the already-neutralized preview:
    // applying a fractional mask to that preview would attenuate the hand twice.
    const original = await sharp(template.original).toColourspace("srgb").ensureAlpha().raw().toBuffer();
    const foreground = template.edgeForeground ? await sharp(template.edgeForeground).toColourspace("srgb").ensureAlpha().raw().toBuffer() : original;
    const projected = Buffer.alloc(COVER_OUTPUT_SIZE ** 2 * 3), painted = new Uint8Array(COVER_OUTPUT_SIZE ** 2);
    for (const plane of template.planes) {
        const inverse = phoneProjection(plane.quad, [[0, 0], [1, 0], [1, 1], [0, 1]]);
        for (let p = 0; p < plane.mask.length; p++) {
            if (!plane.mask[p])
                continue;
            const [u, v] = inverse(p % COVER_OUTPUT_SIZE, Math.floor(p / COVER_OUTPUT_SIZE));
            // The outer bumper can extend a few pixels beyond the calibrated plane.
            // Clamp to its edge, never crop the plate to the old scene coordinates.
            const x = Math.max(0, Math.min(phone.width - 1, u * (phone.width - 1)));
            const y = Math.max(0, Math.min(phone.height - 1, v * (phone.height - 1)));
            const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, phone.width - 1), y1 = Math.min(y0 + 1, phone.height - 1);
            const dx = x - x0, dy = y - y0, weight = painted[p] ? plane.mask[p] / 255 : 1;
            for (let c = 0; c < 3; c++) {
                const color = phone.data[(y0 * phone.width + x0) * 3 + c] * (1 - dx) * (1 - dy)
                    + phone.data[(y0 * phone.width + x1) * 3 + c] * dx * (1 - dy)
                    + phone.data[(y1 * phone.width + x0) * 3 + c] * (1 - dx) * dy
                    + phone.data[(y1 * phone.width + x1) * 3 + c] * dx * dy;
                projected[p * 3 + c] = Math.round(color * weight + projected[p * 3 + c] * (1 - weight));
            }
            painted[p] = 1;
        }
    }
    for (let p = 0; p < template.editMask.length; p++) {
        if (!painted[p] || !template.editMask[p])
            continue;
        const weight = template.editMask[p] / 255;
        const light = 1 - (template.contactShadow?.[p] ?? 0) / 255;
        for (let c = 0; c < 3; c++)
            original[p * 4 + c] = Math.round(projected[p * 3 + c] * light * weight + foreground[p * 4 + c] * (1 - weight));
    }
    despillPhoneRim(original, template);
    return sharp(original, { raw: { width: COVER_OUTPUT_SIZE, height: COVER_OUTPUT_SIZE, channels: 4 } }).png().toBuffer();
}
/** Conservative local outline detection for a single front-on cover photograph. */
export async function findFrontCoverSurface(image) {
    const input = await sharp(image, { limitInputPixels: 40_000_000 }).rotate().resize(640, 640, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#eeeeee" }).toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    const { width, height } = input.info, count = width * height;
    if (width < 64 || height < 64)
        return null;
    const gray = await sharp(input.data, { raw: { width, height, channels: 3 } }).greyscale().blur(.8).raw().toBuffer();
    const strength = new Float32Array(count), border = [];
    for (let y = 1; y < height - 1; y++)
        for (let x = 1; x < width - 1; x++) {
            const p = y * width + x;
            strength[p] = Math.hypot(gray[p + 1] - gray[p - 1], gray[p + width] - gray[p - width]);
            if (x < width * .06 || x > width * .94 || y < height * .04 || y > height * .96)
                border.push(strength[p]);
        }
    border.sort((a, b) => a - b);
    const threshold = Math.max(8, (border[Math.floor(border.length * .995)] || 0) * 2.5);
    let edges = Uint8Array.from(strength, value => value > threshold ? 255 : 0);
    edges = dilateMask(dilateMask(edges, width, height), width, height);
    const seen = new Uint8Array(count), queue = new Int32Array(count);
    const corner = [0, width - 1, (height - 1) * width, count - 1].map(p => [...input.data.subarray(p * 3, p * 3 + 3)]);
    const background = [0, 1, 2].map(c => corner.map(rgb => rgb[c]).sort((a, b) => a - b)[2]);
    const ink = [];
    for (let p = 0; p < count; p += 2) {
        const i = p * 3, rgb = [input.data[i], input.data[i + 1], input.data[i + 2]];
        if (Math.max(...rgb) - Math.min(...rgb) > 35 && Math.hypot(...rgb.map((v, c) => v - background[c])) > 55)
            ink.push(p);
    }
    let best = null;
    for (let start = 0; start < count; start++) {
        if (!edges[start] || seen[start])
            continue;
        let head = 0, tail = 1, left = width, top = height, right = 0, bottom = 0;
        queue[0] = start;
        seen[start] = 1;
        while (head < tail) {
            const p = queue[head++], x = p % width, y = Math.floor(p / width);
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
            for (const n of [p - 1, p + 1, p - width, p + width])
                if (n >= 0 && n < count && Math.abs(n % width - x) <= 1 && edges[n] && !seen[n]) {
                    seen[n] = 1;
                    queue[tail++] = n;
                }
        }
        const w = right - left + 1, h = bottom - top + 1, ratio = w / h;
        if (left <= 1 || top <= 1 || right >= width - 2 || bottom >= height - 2 || ratio < .38 || ratio > .65 || h < height * .4 || h > height * .96 || w < width * .15 || w > width * .9 || tail < count * .006)
            continue;
        if (ink.length > 100 && ink.filter(p => p % width >= left && p % width <= right && Math.floor(p / width) >= top && Math.floor(p / width) <= bottom).length < ink.length * .96)
            continue;
        if (!best || tail > best.area)
            best = { left, top, right, bottom, area: tail };
    }
    if (!best)
        return null;
    // Remove the two-pixel connectivity expansion, retaining the measured edge.
    const x1 = (best.left + 2) * 1000 / (width - 1), x2 = (best.right - 2) * 1000 / (width - 1);
    const y1 = (best.top + 2) * 1000 / (height - 1), y2 = (best.bottom - 2) * 1000 / (height - 1);
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
}
/** Rectify the actual case surface, not its padded photo, for AI conditioning. */
export async function rectifyCoverArtwork(image, quad) {
    if (!Array.isArray(quad) || quad.length !== 4 || !quad.every((point) => Array.isArray(point) && point.length === 2 && point.every((n) => Number.isFinite(n) && n >= 0 && n <= 1000)))
        return null;
    for (let i = 0; i < 4; i++) {
        const a = quad[i], b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
        if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) < 1000)
            return null;
    }
    const { data, info } = await sharp(image, { limitInputPixels: 40_000_000 }).rotate().resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const points = quad.map(([x, y]) => [x * (info.width - 1) / 1000, y * (info.height - 1) / 1000]);
    const length = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const top = length(points[0], points[1]), bottom = length(points[3], points[2]), left = length(points[0], points[3]), right = length(points[1], points[2]);
    const ratio = (top + bottom) / (left + right);
    // Do not project a square scene, degenerate crop or severe uncertain angle as
    // the product. The hardware-only guide remains a safe fallback in that case.
    if (ratio < .32 || ratio > .75 || top / bottom < .6 || top / bottom > 1.7 || left / right < .6 || left / right > 1.7)
        return null;
    const width = 584, height = 1204;
    const project = phoneProjection([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], points);
    const output = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const [u, v] = project(x, y);
            const sx = Math.max(0, Math.min(info.width - 1, u)), sy = Math.max(0, Math.min(info.height - 1, v));
            const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(x0 + 1, info.width - 1), y1 = Math.min(y0 + 1, info.height - 1);
            const dx = sx - x0, dy = sy - y0, p = (y * width + x) * 4;
            // Premultiply alpha before interpolation: clear PNG border RGB must not
            // introduce a white seam. Flatten only onto the underlying solid phone.
            const samples = [[(y0 * info.width + x0) * 4, (1 - dx) * (1 - dy)], [(y0 * info.width + x1) * 4, dx * (1 - dy)], [(y1 * info.width + x0) * 4, (1 - dx) * dy], [(y1 * info.width + x1) * 4, dx * dy]];
            let alpha = 0;
            for (const [i, weight] of samples)
                alpha += data[i + 3] / 255 * weight;
            for (let c = 0; c < 3; c++) {
                let color = [227, 230, 231][c] * (1 - alpha);
                for (const [i, weight] of samples)
                    color += data[i + c] * data[i + 3] / 255 * weight;
                output[p + c] = Math.round(color);
            }
            output[p + 3] = 255;
        }
    return sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
/** Remove photographic gray backing from a CONFIRMED clear-case guide only. */
export async function relightClearArtworkGuide(surface, material) {
    if (material !== "clear")
        return surface;
    const { data, info } = await sharp(surface, { limitInputPixels: 2_000_000 }).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info, columns = 12, rows = 24;
    const buckets = Array.from({ length: columns * rows }, () => [[], [], []]);
    const all = [[], [], []];
    let brightNeutral = 0;
    for (let y = Math.ceil(height * .04); y < height * .96; y += 3)
        for (let x = Math.ceil(width * .07); x < width * .93; x += 3) {
            if (y < height * .28 && x < width * .58)
                continue; // camera opening/hardware is not the backing
            const p = (y * width + x) * 4, rgb = [data[p], data[p + 1], data[p + 2]], high = Math.max(...rgb), low = Math.min(...rgb);
            if (data[p + 3] < 250 || low < 65 || high - low > Math.max(14, high * .12))
                continue;
            if (high > 240) {
                brightNeutral++;
                continue;
            } // white ink/specular patches must not skew the backing estimate
            const tile = Math.min(rows - 1, Math.floor(y * rows / height)) * columns + Math.min(columns - 1, Math.floor(x * columns / width));
            for (let c = 0; c < 3; c++) {
                buckets[tile][c].push(rgb[c]);
                all[c].push(rgb[c]);
            }
        }
    if (all[0].length < 500 || brightNeutral > all[0].length * 1.5)
        return surface; // too little evidence, or backing is already bright
    const percentile = (values) => { values.sort((a, b) => a - b); return values[Math.floor((values.length - 1) * .85)]; };
    const base = all.map(percentile), tiles = Buffer.alloc(columns * rows * 3);
    for (let tile = 0; tile < buckets.length; tile++)
        for (let c = 0; c < 3; c++)
            tiles[tile * 3 + c] = buckets[tile][c].length >= 12 ? percentile(buckets[tile][c]) : base[c];
    const illumination = await sharp(tiles, { raw: { width: columns, height: rows, channels: 3 } }).resize(width, height, { kernel: "cubic" }).blur(18).raw().toBuffer();
    const output = Buffer.from(data);
    for (let p = 0; p < width * height; p++) {
        if (!data[p * 4 + 3])
            continue;
        for (let c = 0; c < 3; c++) {
            // Multiplicative, low-frequency illumination correction preserves dark
            // ink, dots and relative color contrast. No motif synthesis or geometry
            // change; only the conditioning copy is touched, never the raw upload.
            const gain = Math.max(.92, Math.min(2.6, 250 / Math.max(70, illumination[p * 3 + c])));
            output[p * 4 + c] = Math.min(255, Math.round(data[p * 4 + c] * gain));
        }
    }
    return sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer();
}
/** Correct a narrow selfie guide plane, not the scene or finished photograph. */
export async function fitFullAiGuidePhone(template, layout) {
    if (layout !== "model-selfie" || template.planes.length !== 1)
        return template;
    const plane = template.planes[0], [tl, tr, br, bl] = plane.quad;
    const centerTop = [(tl[0] + tr[0]) / 2, (tl[1] + tr[1]) / 2], centerBottom = [(bl[0] + br[0]) / 2, (bl[1] + br[1]) / 2];
    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const height = distance(centerTop, centerBottom), width = (distance(tl, tr) + distance(bl, br)) / 2;
    const factor = Math.max(1, Math.min(1.18, height * (600 / 1220) / width));
    if (factor < 1.02)
        return template;
    const widen = (point, center) => [center[0] + (point[0] - center[0]) * factor, center[1] + (point[1] - center[1]) * factor];
    const quad = [widen(tl, centerTop), widen(tr, centerTop), widen(br, centerBottom), widen(bl, centerBottom)];
    const inverse = phoneProjection(quad, [[0, 0], [600, 0], [600, 1220], [0, 1220]]);
    const rgba = await sharp(template.original).ensureAlpha().raw().toBuffer();
    const skin = await featherMask(handOcclusions(rgba, COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE, "model-selfie"), COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE, .8);
    const mask = Buffer.alloc(COVER_OUTPUT_SIZE ** 2), editMask = Buffer.alloc(mask.length);
    for (let p = 0; p < mask.length; p++) {
        const [x, y] = inverse(p % COVER_OUTPUT_SIZE, Math.floor(p / COVER_OUTPUT_SIZE));
        const qx = Math.abs(x - 300) - 228, qy = Math.abs(y - 610) - 538;
        const signed = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 72;
        mask[p] = Math.round(Math.max(0, Math.min(1, .5 - signed / 2)) * 255);
        // Preserve the calibrated nail/finger coverage inside the old plane. Skin
        // outside it is protected too; only the added phone width covers the room.
        const foregroundFree = plane.mask[p] ? Math.min(1, template.editMask[p] / plane.mask[p]) : 1 - skin[p] / 255;
        editMask[p] = Math.round(mask[p] * foregroundFree * (rgba[p * 4 + 3] / 255));
    }
    return { ...template, editMask, planes: [{ quad, mask }] };
}
/** Local hardware/artwork conditioning only. Never finish a full-AI scene with it. */
export async function createFittedPhoneGuide(template, cameraLayout, artworkSurface, layout) {
    const lenses = cameraLayout === "single" ? [[190, 175]]
        : cameraLayout === "dual-vertical" ? [[200, 185], [200, 300]]
            : cameraLayout === "dual-diagonal" ? [[195, 185], [300, 290]]
                : [[198, 185], [198, 330], [325, 258]];
    const camera = cameraLayout === "single" ? { width: 225, height: 116, flashX: 280, flashY: 175 }
        : cameraLayout === "triple" ? { width: 288, height: 300, flashX: 325, flashY: 162 }
            : { width: 240, height: 256, flashX: 300, flashY: cameraLayout === "dual-diagonal" ? 182 : 242 };
    // The same closed silhouette defines case AND installed phone. Its opaque
    // interior reaches the bottom; only an 8px bumper separates the two edges.
    // Only the user's rectified raw artwork may replace the plain interior.
    // Its full height is mapped once: no contain/letterboxing or padded footer.
    const artwork = artworkSurface ? `<defs><clipPath id="back"><rect x="108" y="98" width="584" height="1204" rx="65"/></clipPath></defs><image x="108" y="98" width="584" height="1204" preserveAspectRatio="none" clip-path="url(#back)" href="data:image/png;base64,${artworkSurface.toString("base64")}"/>` : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1400">
    <defs><linearGradient id="rim"><stop stop-color="#aeb5b9"/><stop offset=".5" stop-color="#f8fafb"/><stop offset="1" stop-color="#aeb5b9"/></linearGradient></defs>
    <rect x="100" y="90" width="600" height="1220" rx="72" fill="url(#rim)"/>
    <rect x="108" y="98" width="584" height="1204" rx="65" fill="#f7f7f5" stroke="#a4abad" stroke-width="2"/>
    ${artwork}
    <rect x="130" y="120" width="${camera.width}" height="${camera.height}" rx="40" fill="#eeefed" stroke="#bac2c6" stroke-width="4"/>
    ${lenses.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="49" fill="#a3adb3"/><circle cx="${x}" cy="${y}" r="43" fill="#101820"/><circle cx="${x}" cy="${y}" r="22" fill="#203c54"/><circle cx="${x - 8}" cy="${y - 10}" r="7" fill="#6c8ca6"/>`).join("")}
    <circle cx="${camera.flashX}" cy="${camera.flashY}" r="15" fill="#fff2dc" stroke="#bbc1c4" stroke-width="3"/>
    ${cameraLayout === "triple" ? '<circle cx="325" cy="350" r="16" fill="#384047"/>' : ""}
  </svg>`;
    // Projection supplies a complete fitted object behind the protected fingers.
    // Only the AI input uses these scene coordinates; final full-AI output keeps
    // its own pose, geometry and silhouette, with no template-mask compositing.
    const guide = await finishCoverImage(await sharp(Buffer.from(svg)).png().toBuffer(), await fitFullAiGuidePhone(template, layout));
    // A modest whole-scene zoom gives the selfie the reference's foreground
    // product prominence. It does NOT narrow/stretch a phone or alter the final
    // AI output. Top anchoring retains the complete phone/camera and fingers.
    return layout === "model-selfie" ? sharp(guide).extract({ left: 30, top: 0, width: 1020, height: 1020 }).resize(COVER_OUTPUT_SIZE, COVER_OUTPUT_SIZE).png().toBuffer() : guide;
}
