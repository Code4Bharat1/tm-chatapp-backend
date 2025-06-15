import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";

dotenv.config();

cloudinary.config({
  cloud_name:
    process.env.CLOUDINARY_CLOUD_NAME,
  api_key:
    process.env.CLOUDINARY_API_KEY,
  api_secret:
    process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload File to Cloudinary
 */
const uploadOnCloudinary = async (
  localFilePath
) => {
  try {
    if (!localFilePath) return null;

    const result =
      await cloudinary.uploader.upload(
        localFilePath,
        {
          resource_type: "auto",
        }
      );

    return result;
  } catch (error) {
    console.error(
      "Cloudinary Upload Error: ",
      error.message
    );
    return null;
  }
};

/**
 * Delete File from Cloudinary
 */
const deleteFromCloudinary = async (
  publicId
) => {
  try {
    await cloudinary.uploader.destroy(
      publicId
    );
  } catch (error) {
    console.error(
      "Cloudinary Delete Error: ",
      error.message
    );
  }
};

export {
  uploadOnCloudinary,
  deleteFromCloudinary,
};

export { cloudinary };
