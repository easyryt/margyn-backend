import { inventoryUserId } from "./mongoose-context.mjs";
import { AppError } from "../../services/errors.mjs";
import { userImageFolder, withImageLibrary, imageLibraryRequest, storeUserImage } from "../../services/storage-allowance.mjs";
export function inventoryImageFolder() { return userImageFolder(inventoryUserId()); }
function ownedFile(files, id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new AppError("Choose a valid image.");
  const file = files.find(file => file.fileId === id);
  if (!file) throw new AppError("Image not found in your library.", 404);
  return file;
}
export default class InventoryImageKit {
  constructor(_options) { inventoryUserId(); }
  async listFiles(_options = {}) { return withImageLibrary(inventoryUserId(), library => library.files); }
  async getFileDetails(id) { return withImageLibrary(inventoryUserId(), library => ownedFile(library.files, id)); }
  async deleteFile(id) {
    return withImageLibrary(inventoryUserId(), async library => {
      const file = ownedFile(library.files, id);
      await library.checkCapacity(0);
      const result = await imageLibraryRequest("https://api.imagekit.io/v1/files/" + encodeURIComponent(id), { method: "DELETE" });
      await library.saveUsage(Math.max(0, library.usedBytes - file.size));
      return result;
    });
  }
  async upload(options) { return storeUserImage(inventoryUserId(), options); }
}
