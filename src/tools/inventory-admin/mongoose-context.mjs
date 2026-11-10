import { createWorkspaceDatabase } from "../workspace-database.mjs";
const workspace = createWorkspaceDatabase({
  namespace: "inventory",
  label: "inventory",
  normalizeUpdate(name, update) {
    // The source RAW endpoint supplies both an insert default and an explicit
    // threshold. MongoDB rejects that duplicate path; the explicit value wins.
    if (name === "Inventory" && Object.hasOwn(update?.$set || {}, "minThreshold") && Object.hasOwn(update?.$setOnInsert || {}, "minThreshold")) {
      const { minThreshold: _default, ...insert } = update.$setOnInsert;
      return { ...update, $setOnInsert: insert };
    }
    return update;
  },
});
export default workspace.mongoose;
export const withInventoryUser = workspace.run;
export const closeInventoryDatabase = workspace.close;
export const inventoryUserId = workspace.userId;
