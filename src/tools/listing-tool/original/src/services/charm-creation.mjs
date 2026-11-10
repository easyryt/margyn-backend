export const DEFAULT_CHARM_RETURN_DISCOUNT = 2;

export function applyCharmCreationDefaults(sourceData = {}, overrides = {}) {
  return {
    ...sourceData,
    wrongDefectiveReturnsPrice: DEFAULT_CHARM_RETURN_DISCOUNT,
    ...overrides,
  };
}
