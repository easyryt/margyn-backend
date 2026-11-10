import fs from "node:fs";
import { fileURLToPath } from "node:url";
const file = fileURLToPath(new URL("../.env", import.meta.url));
if (process.env.NODE_ENV !== "test" && fs.existsSync(file))
  process.loadEnvFile(file);
export const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
});
