import assert from "node:assert/strict";
import test from "node:test";
import { generateReviewedHand, HAND_REVIEW_CHECKS, parseHandCompositionReview } from "../../src/tools/image-generator/lib/charm-hand-composition.mjs";

function review(overrides = {}, issues = []) {
  return { checks: { ...Object.fromEntries(HAND_REVIEW_CHECKS.map((key) => [key, true])), ...overrides }, issues };
}

test("a valid structured review is required; errors and ambiguous PASS text cannot approve an image", () => {
  assert.deepEqual(parseHandCompositionReview(JSON.stringify(review())), review());
  assert.deepEqual(parseHandCompositionReview("```json\n" + JSON.stringify(review()) + "\n```"), review());
  for (const response of ["", "PASS but the clasp is hidden", "{}", "null", JSON.stringify({ checks: { attachmentConnected: true }, issues: [] }), JSON.stringify(review({ charmFullyVisible: "true" }))]) {
    assert.throws(() => parseHandCompositionReview(response));
  }
});

test("a connected charm hidden behind the hand is repaired and the repair is checked", async () => {
  const renders = [];
  const reviewed = [];
  const result = await generateReviewedHand({
    render: async (correction, previous) => {
      renders.push({ correction, previous });
      return renders.length === 1 ? "hidden-loop" : "full-loop";
    },
    review: async (image) => {
      reviewed.push(image);
      return image === "hidden-loop"
        ? review({ charmFullyVisible: false }, ["Move the phone higher and the loop below the sleeve."])
        : review();
    },
  });
  assert.equal(result, "full-loop");
  assert.deepEqual(reviewed, ["hidden-loop", "full-loop"]);
  assert.equal(renders[1].previous, "hidden-loop");
  assert.match(renders[1].correction, /Move the phone higher/);
});

test("a disconnected charm is repaired and still cannot be approved if the second attachment fails", async () => {
  let attempts = 0;
  await assert.rejects(generateReviewedHand({
    render: async () => ++attempts,
    review: async () => review({ attachmentConnected: false }),
  }), /attachment repair/);
  assert.equal(attempts, 2);
});

test("cropping, redesigned products and obvious stretching still fail", async () => {
  for (const field of ["charmFullyVisible", "designsPreserved", "naturalBlend"]) {
    await assert.rejects(generateReviewedHand({ render: async () => "image", review: async () => review({ [field]: false }) }), /attachment repair/);
  }
});

test("a valid attachment can use any natural pose and a functional adapter", async () => {
  const valid = review({ phoneUpright: false, charmBelowPhone: false, onlyOriginalHardware: false });
  const result = await generateReviewedHand({ render: async () => "natural-pendant-with-case-tab", review: async () => valid });
  assert.equal(result, "natural-pendant-with-case-tab");
});

test("minor style suggestions do not regenerate a photograph with a valid attachment", async () => {
  let renders = 0;
  await generateReviewedHand({ render: async () => ++renders, review: async () => review({}, ["A different hand pose is also possible."]) });
  assert.equal(renders, 1);
});

test("a failed inspection never returns an unverified image or makes a paid regeneration", async () => {
  let renders = 0;
  await assert.rejects(generateReviewedHand({
    render: async () => ++renders,
    review: async () => { throw new Error("Inspector unavailable"); },
  }), /Inspector unavailable/);
  assert.equal(renders, 1);
});

test("an accepted composition is returned without additional rendering", async () => {
  let renders = 0;
  const result = await generateReviewedHand({ render: async () => ++renders, review: async () => review() });
  assert.equal(result, 1);
  assert.equal(renders, 1);
});
