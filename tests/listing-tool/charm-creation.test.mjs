import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCharmCreationDefaults,
  DEFAULT_CHARM_RETURN_DISCOUNT,
} from "../../src/tools/listing-tool/original/src/services/charm-creation.mjs";

test("new charms default to a return discount of 2 instead of the source value", () => {
  const data = applyCharmCreationDefaults({
    productName: "Source product",
    wrongDefectiveReturnsPrice: 1,
  });

  assert.equal(DEFAULT_CHARM_RETURN_DISCOUNT, 2);
  assert.equal(data.wrongDefectiveReturnsPrice, 2);
});

test("an explicit charm draft edit overrides the default", () => {
  const data = applyCharmCreationDefaults(
    { wrongDefectiveReturnsPrice: 1 },
    { wrongDefectiveReturnsPrice: 5 },
  );

  assert.equal(data.wrongDefectiveReturnsPrice, 5);
});

test("an explicit zero discount is preserved", () => {
  const data = applyCharmCreationDefaults(
    { wrongDefectiveReturnsPrice: 1 },
    { wrongDefectiveReturnsPrice: 0 },
  );

  assert.equal(data.wrongDefectiveReturnsPrice, 0);
});
