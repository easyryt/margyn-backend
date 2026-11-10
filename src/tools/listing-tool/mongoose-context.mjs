import { createWorkspaceDatabase } from "../workspace-database.mjs";
const workspace = createWorkspaceDatabase({ namespace: "listing", label: "listing" });
export default workspace.mongoose;
export const withListingUser = workspace.run;
export const listingUserId = workspace.userId;
export const closeListingDatabase = workspace.close;
