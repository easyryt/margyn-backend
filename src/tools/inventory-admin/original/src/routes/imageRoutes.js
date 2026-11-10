const express = require("express");
const multer = require("multer");
const ImageKit = require("@imagekit/nodejs");
const imagekit = require("../config/imagekit");

const router = express.Router();

const { toFile } = ImageKit;

/*
|--------------------------------------------------------------------------
| Multer
|--------------------------------------------------------------------------
*/

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    files: 20,
    fileSize: 25 * 1024 * 1024,
  },

  fileFilter: (req, file, cb) => {
    console.log("File received:", {
      name: file.originalname,
      type: file.mimetype,
      size: file.size,
    });

    if (file.mimetype && file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

/*
|--------------------------------------------------------------------------
| Fixed ImageKit folder
|--------------------------------------------------------------------------
*/

const IMAGE_FOLDER = "/product-designs";

/*
|--------------------------------------------------------------------------
| POST /api/images/upload
|--------------------------------------------------------------------------
| Upload multiple images
|--------------------------------------------------------------------------
*/

router.post("/upload", upload.array("images", 20), async (req, res) => {
  try {
    console.log("----------------------------------");
    console.log("UPLOAD REQUEST");

    console.log("Files:", req.files?.length || 0);

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No images received",
      });
    }

    const uploadedImages = [];

    for (const file of req.files) {
      try {
        console.log("----------------------------------");
        console.log("Starting upload:", file.originalname);
        console.log("MIME:", file.mimetype);
        console.log("Size:", file.size);
        console.log("Folder:", IMAGE_FOLDER);

        const imageFile = await toFile(
          file.buffer,
          file.originalname
        );

        console.log("Buffer converted successfully");
        console.log("Calling ImageKit...");

        const result = await imagekit.files.upload({
          file: imageFile,
          fileName: file.originalname,
          folder: IMAGE_FOLDER,
          useUniqueFileName: true,
        });

        console.log("ImageKit upload successful");

        uploadedImages.push({
          fileId: result.fileId,
          name: result.name,
          url: result.url,
          thumbnailUrl: result.thumbnailUrl,
          filePath: result.filePath,
          width: result.width,
          height: result.height,
          size: result.size,
        });
      } catch (uploadError) {
        console.error(
          "IMAGEKIT UPLOAD FAILED:",
          uploadError
        );

        console.error("Name:", uploadError.name);
        console.error("Message:", uploadError.message);
        console.error("Status:", uploadError.status);

        throw uploadError;
      }
    }

    return res.status(201).json({
      success: true,
      message: `${uploadedImages.length} image(s) uploaded successfully`,
      count: uploadedImages.length,
      folder: IMAGE_FOLDER,
      images: uploadedImages,
    });
  } catch (error) {
    console.error("----------------------------------");
    console.error("FINAL IMAGE UPLOAD ERROR");
    console.error(error);
    console.error("----------------------------------");

    return res.status(500).json({
      success: false,
      message: "Image upload failed",
      error: error.message,
      name: error.name,
      status: error.status || null,
    });
  }
});

/*
|--------------------------------------------------------------------------
| GET /api/images
|--------------------------------------------------------------------------
| Get images from /product-designs
|--------------------------------------------------------------------------
*/

router.get("/", async (req, res) => {
  try {
    console.log("Fetching images from:", IMAGE_FOLDER);

    const page = Math.max(
      parseInt(req.query.page, 10) || 1,
      1
    );

    const limit = Math.min(
      Math.max(
        parseInt(req.query.limit, 10) || 50,
        1
      ),
      1000
    );

    const skip = (page - 1) * limit;

    const images = await imagekit.assets.list({
      searchQuery: `path="${IMAGE_FOLDER}" AND type="file"`,
      fileType: "image",
      skip,
      limit,
      sort: "DESC_CREATED",
    });

    return res.json({
      success: true,
      folder: IMAGE_FOLDER,
      page,
      limit,
      count: images.length,

      images: images.map((image) => ({
        fileId: image.fileId,
        name: image.name,
        url: image.url,
        thumbnailUrl: image.thumbnailUrl,
        filePath: image.filePath,
        width: image.width,
        height: image.height,
        size: image.size,
        createdAt: image.createdAt,
        updatedAt: image.updatedAt,
      })),
    });
  } catch (error) {
    console.error("GET IMAGE ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch images",
      error: error.message,
      name: error.name,
      status: error.status || null,
    });
  }
});

/*
|--------------------------------------------------------------------------
| DELETE /api/images/:fileId
|--------------------------------------------------------------------------
| Delete one image from ImageKit
|--------------------------------------------------------------------------
*/

router.delete("/:fileId", async (req, res) => {
  try {
    const { fileId } = req.params;

    if (!fileId) {
      return res.status(400).json({
        success: false,
        message: "fileId is required",
      });
    }

    console.log("----------------------------------");
    console.log("DELETE IMAGE");
    console.log("File ID:", fileId);

    await imagekit.files.delete(fileId);

    console.log("Image deleted successfully");

    return res.status(200).json({
      success: true,
      message: "Image deleted successfully",
      fileId,
    });
  } catch (error) {
    console.error("DELETE IMAGE ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete image",
      error: error.message,
      name: error.name,
      status: error.status || null,
    });
  }
});

module.exports = router;