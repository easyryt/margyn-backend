import { grantAdmin } from "../src/services/auth.mjs";
import { closeDb } from "../src/services/db.mjs";
try {
  const phone = await grantAdmin(process.argv[2]);
  console.log(
    `Administrator access granted to ${phone}. Sign in with this number at /login?next=/admin.`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
