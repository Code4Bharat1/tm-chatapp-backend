import multer from "multer";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand, // Added
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { fileURLToPath } from "url";
import path from "path";
import jwt from "jsonwebtoken";
import cookie from "cookie";
import { getDB } from "../services/db.js";
import { ObjectId } from "mongodb";
import dotenv from "dotenv";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize S3 Client
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }, // 6MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf|doc|docx/;
    const extname = allowedTypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(
        new Error("Only images, PDFs, and Word documents are allowed!"),
        false
      );
    }
  },
});

export const uploadMiddleware = (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      console.error("❌ [Multer Error]:", err.message, err.code);
      if (err.code === "LIMIT_FILE_SIZE") {
        return res
          .status(400)
          .json({ error: "File too large. Maximum size is 6MB." });
      }
      return res.status(400).json({ error: `Multer error: ${err.message}` });
    } else if (err) {
      console.error("❌ [Upload Error]:", err.message);
      return res.status(400).json({ error: err.message });
    }
    next();
  });
};

export const uploadFile = async (req, res) => {
  try {
    console.log("AWS_ACCESS_KEY_ID:", process.env.AWS_ACCESS_KEY_ID);
    console.log("AWS_SECRET_ACCESS_KEY:", process.env.AWS_SECRET_ACCESS_KEY);
    console.log("AWS_REGION:", process.env.AWS_REGION);
    console.log("AWS_BUCKET_NAME:", process.env.AWS_BUCKET_NAME);

    if (
      !process.env.AWS_ACCESS_KEY_ID ||
      !process.env.AWS_SECRET_ACCESS_KEY ||
      !process.env.AWS_REGION ||
      !process.env.AWS_BUCKET_NAME
    ) {
      console.error("❌ Missing AWS environment variables");
      return res
        .status(500)
        .json({ error: "Server configuration error: Missing AWS credentials" });
    }

    console.log("📥 [Upload Request] Headers:", req.headers);
    console.log("📥 [Upload Request] Body:", req.body);
    console.log("📥 [Upload Request] File:", req.file);

    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) {
      console.log("❌ No cookies sent");
      return res.status(401).json({ error: "No cookies sent" });
    }

    const cookies = cookie.parse(cookieHeader);
    const token = cookies.token;
    if (!token) {
      console.log("❌ Token missing");
      return res.status(401).json({ error: "Token missing" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded) {
      console.log("❌ Invalid token");
      return res.status(401).json({ error: "Invalid token" });
    }

    const allowedRoles = [
      "Employee",
      "CEO",
      "Manager",
      "HR",
      "Client",
      "TeamLeader",
    ];
    if (!allowedRoles.includes(decoded.position)) {
      console.log("❌ Insufficient permissions:", decoded.position);
      return res
        .status(403)
        .json({ error: "Insufficient position permissions" });
    }

    if (!req.file) {
      console.log("❌ No file uploaded");
      return res.status(400).json({ error: "No file uploaded" });
    }

    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const filename = `${req.file.fieldname}-${uniqueSuffix}${path.extname(
      req.file.originalname
    )}`;

    const uploadParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: `uploads/${filename}`,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };
    console.log("Uploading to S3 with params:", uploadParams);
    await s3.send(new PutObjectCommand(uploadParams));
    console.log("✅ S3 Upload Successful");

    const db = getDB();
    const messageCollection = db.collection("messages");
    const roomId = req.body.roomId || `company_${decoded.companyId}`;
    console.log("📤 [Uploading to room]:", roomId);
    const roomCollection = db.collection("rooms");
    if (roomId.startsWith("room_")) {
      const room = await roomCollection.findOne({ roomId });
      if (!room || !room.users.includes(decoded.userId)) {
        console.log("❌ Not authorized for room:", roomId);
        return res
          .status(403)
          .json({ error: "Not authorized to upload to this room" });
      }
    }

    const fileMetadata = {
      _id: new ObjectId(),
      message: "File uploaded",
      userId: decoded.userId,
      username: decoded.firstName || "Anonymous",
      roomId,
      companyId: new ObjectId(decoded.companyId),
      timestamp: new Date(),
      file: {
        filename: filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        s3Key: `uploads/${filename}`,
        bucket: process.env.AWS_BUCKET_NAME,
      },
    };

    await messageCollection.insertOne(fileMetadata);

    const presignedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: `uploads/${filename}`,
      }),
      { expiresIn: 3600 }
    );

    const io = req.app.get("io");
    io.to(roomId).emit("newFile", {
      _id: fileMetadata._id.toString(),
      message: fileMetadata.message,
      userId: fileMetadata.userId,
      username: fileMetadata.username,
      roomId: fileMetadata.roomId,
      timestamp: fileMetadata.timestamp.toISOString(),
      file: {
        filename: fileMetadata.file.filename,
        originalName: fileMetadata.file.originalName,
        mimeType: fileMetadata.file.mimeType,
        size: fileMetadata.file.size,
        url: presignedUrl,
      },
    });

    res.status(200).json({
      message: "File uploaded successfully",
      file: { ...fileMetadata.file, url: presignedUrl },
    });
  } catch (error) {
    console.error("❌ [Upload Error]:", error.message, error.stack, error);
    res.status(500).json({
      error: `An unexpected error occurred while uploading file: ${error.message}`,
    });
  }
};

export const downloadFile = async (req, res) => {
  try {
    console.log("📥 [Download Request] Headers:", req.headers);
    console.log("📥 [Download Request] Params:", req.params);

    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) {
      console.log("❌ No cookies sent");
      return res.status(401).json({ error: "No cookies sent" });
    }

    const cookies = cookie.parse(cookieHeader);
    const token = cookies.token;
    if (!token) {
      console.log("❌ Token missing");
      return res.status(401).json({ error: "Token missing" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded) {
      console.log("❌ Invalid token");
      return res.status(401).json({ error: "Invalid token" });
    }

    const allowedRoles = [
      "Employee",
      "CEO",
      "Manager",
      "HR",
      "Client",
      "TeamLeader",
    ];
    if (!allowedRoles.includes(decoded.position)) {
      console.log("❌ Insufficient permissions:", decoded.position);
      return res
        .status(403)
        .json({ error: "Insufficient position permissions" });
    }

    const { fileID } = req.params;
    if (!fileID) {
      console.log("❌ No filename provided");
      return res.status(400).json({ error: "fileId is required" });
    }

    const db = getDB();
    const messageCollection = db.collection("messages");
    const fileMetadata = await messageCollection.findOne({
      $or: [
        { _id: fileID }, // If voiceId is the message _id
        { "file.filename": fileID }, // If voiceId is the voice filename
      ],
    });

    if (!fileMetadata) {
      console.log("❌ File not found in database:", fileID);
      return res.status(404).json({ error: "File not found" });
    }

    const roomId = fileMetadata.roomId;
    const roomCollection = db.collection("rooms");
    if (roomId.startsWith("room_")) {
      const room = await roomCollection.findOne({ roomId });
      if (!room || !room.users.includes(decoded.userId)) {
        console.log("❌ Not authorized for room:", roomId);
        return res
          .status(403)
          .json({ error: "Not authorized to access this file" });
      }
    } else if (
      roomId.startsWith("company_") &&
      roomId !== `company_${decoded.companyId}`
    ) {
      console.log("❌ Not authorized for company room:", roomId);
      return res
        .status(403)
        .json({ error: "Not authorized to access this file" });
    }

    const getObjectParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: fileMetadata.file.s3Key,
    };
    const command = new GetObjectCommand(getObjectParams);
    const { Body, ContentType, ContentLength } = await s3.send(command);

    res.setHeader("Content-Type", ContentType || fileMetadata.file.mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileMetadata.file.originalName}"`
    );
    res.setHeader("Content-Length", ContentLength || fileMetadata.file.size);

    Body.pipe(res);

    console.log(
      `📤 [Downloading file] ${fileID} as ${fileMetadata.file.originalName}`
    );
  } catch (error) {
    console.error("❌ [Download Error]:", error.message, error.stack, error);
    res.status(500).json({
      error: `An unexpected error occurred while downloading file: ${error.message}`,
    });
  }
};

export const deleteFile = async (req, res) => {
  try {
    console.log("🗑️ [Delete Request] Headers:", req.headers);
    console.log("🗑️ [Delete Request] Params:", req.params);

    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) {
      console.log("❌ No cookies sent");
      return res.status(401).json({ error: "No cookies sent" });
    }

    const cookies = cookie.parse(cookieHeader);
    const token = cookies.token;
    if (!token) {
      console.log("❌ Token missing");
      return res.status(401).json({ error: "Token missing" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded) {
      console.log("❌ Invalid token");
      return res.status(401).json({ error: "Invalid token" });
    }

    const allowedRoles = [
      "Employee",
      "CEO",
      "Manager",
      "HR",
      "Client",
      "TeamLeader",
    ];
    if (!allowedRoles.includes(decoded.position)) {
      console.log("❌ Insufficient permissions:", decoded.position);
      return res
        .status(403)
        .json({ error: "Insufficient position permissions" });
    }

    const { fileID } = req.params;
    if (!fileID) {
      console.log("❌ No fileID provided");
      return res.status(400).json({ error: "fileID is required" });
    }

    const db = getDB();
    const messageCollection = db.collection("messages");
    const fileMetadata = await messageCollection.findOne({
      "file.filename": fileID,
      companyId: new ObjectId(decoded.companyId),
    });

    if (!fileMetadata) {
      console.log("❌ File not found in database:", fileID);
      return res.status(404).json({ error: "File not found" });
    }

    const roomId = fileMetadata.roomId;
    const roomCollection = db.collection("rooms");
    if (roomId.startsWith("room_")) {
      const room = await roomCollection.findOne({ roomId });
      if (!room || !room.users.includes(decoded.userId)) {
        console.log("❌ Not authorized for room:", roomId);
        return res
          .status(403)
          .json({ error: "Not authorized to delete this file" });
      }
    } else if (
      roomId.startsWith("company_") &&
      roomId !== `company_${decoded.companyId}`
    ) {
      console.log("❌ Not authorized for company room:", roomId);
      return res
        .status(403)
        .json({ error: "Not authorized to delete this file" });
    }

    const deleteParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: fileMetadata.file.s3Key,
    };
    console.log("Deleting from S3 with params:", deleteParams);
    await s3.send(new DeleteObjectCommand(deleteParams));
    console.log("✅ S3 Delete Successful");

    await messageCollection.deleteOne({
      "file.filename": fileID,
      companyId: new ObjectId(decoded.companyId),
    });

    const io = req.app.get("io");
    io.to(roomId).emit("fileDeleted", {
      fileId: fileID,
      roomId: roomId,
      message: "File deleted",
      timestamp: new Date().toISOString(),
    });

    console.log(`🗑️ [Deleted file] ${fileID}`);
    res.status(200).json({ message: "File deleted successfully" });
  } catch (error) {
    console.error("❌ [Delete Error]:", error.message, error.stack, error);
    res.status(500).json({
      error: `An unexpected error occurred while deleting file: ${error.message}`,
    });
  }
};

export const deleteS3FilesByRoom = async (user, roomId) => {
  try {
    console.log(
      `🗑️ [Delete S3 Files By Room] roomId=${roomId}, userId=${user.userId}`
    );

    // Validate inputs
    if (!user || !user.userId || !user.companyId) {
      throw new Error(
        "User authentication required: missing userId or companyId"
      );
    }
    if (!roomId || typeof roomId !== "string" || roomId.trim() === "") {
      throw new Error("Room ID is required and must be a non-empty string");
    }

    const db = getDB();
    const roomCollection = db.collection("rooms");
    const messageCollection = db.collection("messages");

    // Verify room exists and belongs to user's company
    const room = await roomCollection.findOne({ roomId });
    if (!room) {
      throw new Error(`Room not found: ${roomId}`);
    }
    if (String(room.companyId) !== String(user.companyId)) {
      throw new Error("User not authorized for this room's company");
    }

    // Fetch all messages with files for the room
    const messages = await messageCollection
      .find({
        roomId,
        file: { $exists: true },
      })
      .toArray();

    // Collect S3 keys
    const fileKeys = messages
      .filter((message) => message.file && message.file.s3Key)
      .map((message) => ({ Key: message.file.s3Key }));

    // Delete files from S3
    let deletedCount = 0;
    if (fileKeys.length > 0) {
      const deleteParams = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Delete: {
          Objects: fileKeys,
          Quiet: false,
        },
      };
      console.log("Deleting S3 files for room:", deleteParams);
      await s3.send(new DeleteObjectsCommand(deleteParams));
      deletedCount = fileKeys.length;
      console.log(`✅ Deleted ${deletedCount} S3 files for room ${roomId}`);
    } else {
      console.log(`No S3 files to delete for room ${roomId}`);
    }

    return { success: true, deletedCount };
  } catch (error) {
    console.error(
      `❌ [Delete S3 Files By Room Error]: ${error.message}`,
      error.stack
    );
    throw error;
  }
};

export const getFilesByRoom = async (req, res) => {
  try {
    console.log("📜 [Get Files Request] Headers:", req.headers);
    console.log("📜 [Get Files Request] Params:", req.params);

    // Authenticate user
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) {
      console.log("❌ No cookies sent");
      return res.status(401).json({ success: false, error: "No cookies sent" });
    }

    const cookies = cookie.parse(cookieHeader);
    const token = cookies.token;
    if (!token) {
      console.log("❌ Token missing");
      return res.status(401).json({ success: false, error: "Token missing" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded) {
      console.log("❌ Invalid token");
      return res.status(401).json({ success: false, error: "Invalid token" });
    }

    const allowedRoles = [
      "Employee",
      "CEO",
      "Manager",
      "HR",
      "Client",
      "TeamLeader",
    ];
    if (!allowedRoles.includes(decoded.position)) {
      console.log("❌ Insufficient permissions:", decoded.position);
      return res
        .status(403)
        .json({ success: false, error: "Insufficient position permissions" });
    }

    // Get roomId from URL parameter
    const { roomId } = req.params;
    if (!roomId) {
      console.log("❌ No roomId provided");
      return res
        .status(400)
        .json({ success: false, error: "roomId is required" });
    }

    // Verify room access
    const db = getDB();
    const roomCollection = db.collection("rooms");
    if (roomId.startsWith("room_")) {
      const room = await roomCollection.findOne({ roomId });
      if (!room || !room.users.includes(decoded.userId)) {
        console.log("❌ Not authorized for room:", roomId);
        return res
          .status(403)
          .json({
            success: false,
            error: "Not authorized to access this room",
          });
      }
    } else if (
      roomId.startsWith("company_") &&
      roomId !== `company_${decoded.companyId}`
    ) {
      console.log("❌ Not authorized for company room:", roomId);
      return res
        .status(403)
        .json({ success: false, error: "Not authorized to access this room" });
    }

    // Fetch file messages from MongoDB
    const messageCollection = db.collection("messages");
    const messages = await messageCollection
      .find({
        roomId,
        companyId: new ObjectId(decoded.companyId),
      })
      .sort({ timestamp: -1 })
      .toArray();

    // Validate files in S3 and generate presigned URLs
    const messagesWithUrls = await Promise.all(
      messages.map(async (message) => {
        try {
          let fileData = null;
          if (message.file && message.file.s3Key) {
            // Validate file existence in S3
            const headParams = {
              Bucket: process.env.AWS_BUCKET_NAME,
              Key: message.file.s3Key,
            };
            await s3.send(new HeadObjectCommand(headParams));
            console.log(`✅ S3 File Exists: ${message.file.s3Key}`);

            // Generate presigned URL
            const presignedUrl = await getSignedUrl(
              s3,
              new GetObjectCommand({
                Bucket: process.env.AWS_BUCKET_NAME,
                Key: message.file.s3Key,
              }),
              { expiresIn: 3600 } // 1-hour expiry
            );

            fileData = {
              filename: message.file.filename,
              originalName: message.file.originalName,
              mimeType: message.file.mimeType,
              size: message.file.size,
              url: presignedUrl,
            };
          }

          const messageData = {
            _id: message._id.toString(),
            message: message.message || (fileData ? "File uploaded" : ""),
            userId: message.userId,
            username: message.username || "Anonymous",
            roomId: message.roomId,
            timestamp: message.timestamp.toISOString(),
            updatedAt: message.updatedAt ? message.updatedAt.toISOString() : undefined,
          };

          if (fileData) {
            messageData.file = fileData;
          }

          console.log(`📤 [Processed Message]:`, JSON.stringify(messageData));
          return messageData;
        } catch (s3Error) {
          console.error(
            `❌ [S3 Error] Message ID: ${message._id}, File: ${message.file?.s3Key || "N/A"}`,
            s3Error.message
          );
          // Include text messages even if file validation fails
          if (!message.file) {
            return {
              _id: message._id.toString(),
              message: message.message || "",
              userId: message.userId,
              username: message.username || "Anonymous",
              roomId: message.roomId,
              timestamp: message.timestamp.toISOString(),
              updatedAt: message.updatedAt ? message.updatedAt.toISOString() : undefined,
            };
          }
          return null; // Skip invalid file messages
        }
      })
    );

    // Filter out null entries
    const validMessages = messagesWithUrls.filter((msg) => msg !== null);

    console.log(
      `📜 [Fetched ${validMessages.length} messages] for room: ${roomId}`
    );
    res.status(200).json({
      success: true,
      message: "Messages retrieved successfully",
      data: validMessages,
    });
  } catch (error) {
    console.error("❌ [Get Files Error]:", error.message, error.stack);
    res.status(500).json({
      success: false,
      error: `An unexpected error occurred while retrieving messages: ${error.message}`,
    });
  }
};
