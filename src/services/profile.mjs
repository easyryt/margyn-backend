import { randomUUID } from "node:crypto";
import { getDb, transaction } from "./db.mjs";
import { AppError } from "./errors.mjs";
import { text } from "./store.mjs";
import { validateAddress } from "./commerce.mjs";

function profile(row) {
  if (!row) throw new AppError("Please sign in to continue.", 401);
  return {
    id: row._id,
    name: row.name || "",
    phone: row.phone,
    createdAt: row.createdAt,
    addresses: (row.addresses || []).map(
      ({
        id,
        label,
        name,
        phone,
        line1,
        line2,
        city,
        state,
        pincode,
        gstin,
        isDefault,
        createdAt,
        updatedAt,
      }) => ({
        id,
        label,
        name,
        phone,
        line1,
        line2,
        city,
        state,
        pincode,
        gstin,
        isDefault,
        createdAt,
        updatedAt,
      }),
    ),
  };
}
export async function getProfile(userId) {
  return profile(
    await (await getDb()).collection("users").findOne({ _id: userId }),
  );
}
export async function saveProfileName(userId, input) {
  const name = text(input.name, "Full name", 100, 2).replace(/\s+/g, " ");
  const result = await (
    await getDb()
  )
    .collection("users")
    .updateOne({ _id: userId }, { $set: { name, updatedAt: Date.now() } });
  if (!result.matchedCount)
    throw new AppError("Please sign in to continue.", 401);
  return getProfile(userId);
}
export function validateSavedAddress(input) {
  if (input.isDefault !== undefined && typeof input.isDefault !== "boolean")
    throw new AppError("Choose whether this is your default address.");
  return {
    ...validateAddress(input),
    label: text(
      input.label === undefined ? "Home" : input.label,
      "Address label",
      40,
    ),
    isDefault: input.isDefault === true,
  };
}
export async function changeProfileAddress(
  userId,
  operation,
  input = {},
  id = "",
) {
  if (operation !== "add" && !/^[a-f0-9-]{36}$/i.test(id))
    throw new AppError("Address not found.", 404);
  const value = ["add", "edit"].includes(operation)
    ? validateSavedAddress(input)
    : null;
  await transaction(async (db, session) => {
    const row = await db
      .collection("users")
      .findOne({ _id: userId }, { session });
    if (!row) throw new AppError("Please sign in to continue.", 401);
    let addresses = row.addresses || [];
    const now = Date.now();
    if (operation === "add") {
      if (addresses.length >= 10)
        throw new AppError(
          "You can save up to 10 addresses. Edit or remove an existing address first.",
        );
      if (value.isDefault)
        addresses = addresses.map((address) => ({
          ...address,
          isDefault: false,
        }));
      addresses = [
        ...addresses,
        { ...value, id: randomUUID(), createdAt: now, updatedAt: now },
      ];
    } else {
      if (!addresses.some((address) => address.id === id))
        throw new AppError("Address not found.", 404);
      if (operation === "delete")
        addresses = addresses.filter((address) => address.id !== id);
      else if (operation === "default")
        addresses = addresses.map((address) => ({
          ...address,
          isDefault: address.id === id,
          updatedAt: address.id === id ? now : address.updatedAt,
        }));
      else if (operation === "edit")
        addresses = addresses.map((address) =>
          address.id === id
            ? { ...address, ...value, updatedAt: now }
            : value.isDefault
              ? { ...address, isDefault: false }
              : address,
        );
      else throw new AppError("Choose a valid address action.");
    }
    if (addresses.length && !addresses.some((address) => address.isDefault))
      addresses = addresses.map((address, index) => ({
        ...address,
        isDefault: index === 0,
      }));
    await db
      .collection("users")
      .updateOne(
        { _id: userId },
        { $set: { addresses, updatedAt: now } },
        { session },
      );
  });
  return getProfile(userId);
}
