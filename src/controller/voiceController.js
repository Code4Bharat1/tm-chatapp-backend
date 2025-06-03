import multer from "multer";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
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

// Configure Multer for voice files
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /mp3|wav|ogg|webm/;
    const allowedMimeTypes = [
      "audio/mpeg",
      "audio/wav",
      "audio/ogg",
      "audio/webm",
    ];
    const extname = allowedTypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    const mimetype = allowedMimeTypes.includes(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(
        new Error("Only MP3, WAV, OGG, and WebM voice files are allowed!"),
        false
      );
    }
  },
});

// Multer error handling middleware for voice files
export const voiceUploadMiddleware = (req, res, next) => {
  voiceUpload.single("voice")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      console.error("❌ [Multer Error]:", err.message, err.code);
      if (err.code === "LIMIT_FILE_SIZE") {
        return res
          .status(400)
          .json({ error: "Voice file too large. Maximum size is 10MB." });
      }
      return res.status(400).json({ error: `Multer error: ${err.message}` });
    } else if (err) {
      console.error("❌ [Voice Upload Error]:", err.message);
      return res.status(400).json({ error: err.message });
    }
    next();
  });
};

export const uploadVoice = async (req, res) => {
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

    console.log("📥 [Voice Upload Request] Headers:", req.headers);
    console.log("📥 [Voice Upload Request] Body:", req.body);
    console.log("📥 [Voice Upload Request] File:", req.file);

    // Authenticate user
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

    // Check if a voice file was uploaded
    if (!req.file) {
      console.log("❌ No voice file uploaded");
      return res.status(400).json({ error: "No voice file uploaded" });
    }

    // Generate unique filename
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const filename = `voice-${uniqueSuffix}${path.extname(
      req.file.originalname
    )}`;

    // Upload to S3
    const uploadParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: `voiceUploads/${filename}`,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };
    console.log("Uploading to S3 with params:", uploadParams);
    await s3.send(new PutObjectCommand(uploadParams));
    console.log("✅ S3 Voice Upload Successful");

    const db = getDB();
    const messageCollection = db.collection("messages");
    const roomId = req.body.roomId || `company_${decoded.companyId}`; // Fixed: Use companyId
    console.log("📤 [Uploading voice to room]:", roomId);
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

    // Save voice file metadata to MongoDB
    const voiceMetadata = {
      _id: new ObjectId(),
      message: "Voice file uploaded",
      userId: decoded.userId,
      username: decoded.firstName || "Anonymous",
      roomId: roomId, // Fixed: Use string roomId
      companyId: decoded.companyId, // Store companyId as string
      timestamp: new Date(),
      voice: {
        filename: filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        s3Key: `voiceUploads/${filename}`,
        bucket: process.env.AWS_BUCKET_NAME,
      },
    };

    await messageCollection.insertOne(voiceMetadata);

    // Generate presigned URL for download
    const presignedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: `voiceUploads/${filename}`,
      }),
      { expiresIn: 3600 }
    );

    // Emit Socket.IO event
    const io = req.app.get("io");
    io.to(roomId).emit("newVoice", {
      _id: voiceMetadata._id.toString(),
      message: voiceMetadata.message,
      userId: voiceMetadata.userId,
      username: voiceMetadata.username,
      roomId: voiceMetadata.roomId,
      timestamp: voiceMetadata.timestamp.toISOString(),
      voice: {
        filename: voiceMetadata.voice.filename,
        originalName: voiceMetadata.voice.originalName,
        mimeType: voiceMetadata.voice.mimeType,
        size: voiceMetadata.voice.size,
        url: presignedUrl,
      },
    });

    // Return full metadata in response
    res.status(200).json({
      _id: voiceMetadata._id.toString(),
      message: "Voice file uploaded successfully",
      userId: voiceMetadata.userId,
      username: voiceMetadata.username,
      roomId: voiceMetadata.roomId,
      timestamp: voiceMetadata.timestamp.toISOString(),
      voice: {
        filename: voiceMetadata.voice.filename,
        originalName: voiceMetadata.voice.originalName,
        mimeType: voiceMetadata.voice.mimeType,
        size: voiceMetadata.voice.size,
        url: presignedUrl,
      },
    });
  } catch (error) {
    console.error("❌ [Voice Upload Error]:", error.message, error.stack);
    res.status(500).json({
      error: `An unexpected error occurred while uploading voice file: ${error.message}`,
    });
  }
};

export const downloadVoice = async (req, res) => {
  try {
    console.log("📥 [Voice Download Request] Headers:", req.headers);
    console.log("📥 [Voice Download Request] Params:", req.params);

    // Authenticate user
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

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      console.log("❌ Invalid token:", err.message);
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

    // Get voiceId from URL parameter
    const { voiceId } = req.params;
    if (!voiceId) {
      console.log("❌ No voiceId provided");
      return res.status(400).json({ error: "voiceId is required" });
    }

    // Find voice file metadata in MongoDB
    const db = getDB();
    const messageCollection = db.collection("messages");
    // Try querying by message _id or voice.filename
    const voiceMetadata = await messageCollection.findOne({
      $or: [
        { _id: voiceId }, // If voiceId is the message _id
        { "voice.filename": voiceId }, // If voiceId is the voice filename
      ],
    });

    if (!voiceMetadata) {
      console.log("❌ Voice file not found in database:", voiceId);
      return res.status(404).json({ error: "Voice file not found" });
    }

    // Log the found metadata for debugging
    console.log("📄 [Voice Metadata]:", voiceMetadata);

    // Verify room access
    const roomId = voiceMetadata.roomId;
    const roomCollection = db.collection("rooms");
    if (roomId.startsWith("room_")) {
      const room = await roomCollection.findOne({ roomId });
      if (!room || !room.users.includes(decoded.userId)) {
        console.log("❌ Not authorized for room:", roomId);
        return res
          .status(403)
          .json({ error: "Not authorized to access this voice file" });
      }
    } else if (
      roomId.startsWith("company_") &&
      roomId !== `company_${decoded.companyId}`
    ) {
      console.log("❌ Not authorized for company room:", roomId);
      return res
        .status(403)
        .json({ error: "Not authorized to access this voice file" });
    }

    // Fetch file from S3
    const getObjectParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: voiceMetadata.voice.s3Key,
    };
    const command = new GetObjectCommand(getObjectParams);
    const { Body, ContentType, ContentLength } = await s3.send(command);

    // Set headers for download
    res.setHeader("Content-Type", ContentType || voiceMetadata.voice.mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${voiceMetadata.voice.originalName}"`
    );
    res.setHeader("Content-Length", ContentLength || voiceMetadata.voice.size);

    // Stream the file
    Body.pipe(res);

    console.log(
      `📤 [Downloading voice file] ${voiceId} as ${voiceMetadata.voice.originalName}`
    );
  } catch (error) {
    console.error("❌ [Voice Download Error]:", error.message, error.stack);
    res.status(500).json({
      error: `An unexpected error occurred while downloading voice file: ${error.message}`,
    });
  }
};

// Delete a single voice message by voiceId
export const deleteVoice = async (req, res) => {
  try {
    console.log("🗑️ [Voice Delete Request] Headers:", req.headers);
    console.log("🗑️ [Voice Delete Request] Params:", req.params);

    // Authenticate user
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

    const allowedRoles = ["Employee", "CEO", "Manager", "HR", "Client", "TeamLeader"];
    if (!allowedRoles.includes(decoded.position)) {
      console.log("❌ Insufficient permissions:", decoded.position);
      return res.status(403).json({ error: "Insufficient position permissions" });
    }

    // Get voiceId from URL parameter
    const { voiceId } = req.params;
    if (!voiceId) {
      console.log("❌ No voiceId provided");
      return res.status(400).json({ error: "voiceId is required" });
    }

    // Find voice metadata in MongoDB
    const db = getDB();
    const messageCollection = db.collection("messages");
    const voiceMetadata = await messageCollection.findOne({
      $or: [
        { _id: voiceId }, // If voiceId is the message _id
        { "voice.filename": voiceId }, // If voiceId is the voice filename
      ],
    });

    if (!voiceMetadata) {
      console.log("❌ Voice not found in database:", voiceId);
      return res.status(404).json({ error: "Voice not found" });
    }

    // Verify room access
    const roomId = voiceMetadata.roomId;
    const roomCollection = db.collection("rooms");
    if (roomId.startsWith("room_")) {
      const room = await roomCollection.findOne({ roomId });
      if (!room || !room.users.includes(decoded.userId)) {
        console.log("❌ Not authorized for room:", roomId);
        return res.status(403).json({ error: "Not authorized to delete this voice" });
      }
    } else if (roomId.startsWith("company_") && roomId !== `company_${decoded.companyId}`) {
      console.log("❌ Not authorized for company room:", roomId);
      return res.status(403).json({ error: "Not authorized to delete this voice" });
    }

    // Delete from S3
    if (voiceMetadata.voice && voiceMetadata.voice.s3Key) {
      const deleteParams = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: voiceMetadata.voice.s3Key,
      };
      console.log("Deleting from S3 with params:", deleteParams);
      await s3.send(new DeleteObjectCommand(deleteParams));
      console.log("✅ S3 Delete Successful");
    } else {
      console.log("⚠️ No S3 key found, skipping S3 deletion");
    }

    // Delete from MongoDB
    await messageCollection.deleteOne({
      "voice.filename": voiceId,
      companyId: new ObjectId(decoded.companyId),
    });

    // Emit socket event
    const io = req.app.get("io");
    io.to(roomId).emit("voiceDeleted", {
      voiceId: voiceId,
      roomId: roomId,
      message: "Voice deleted",
      timestamp: new Date().toISOString(),
    });

    console.log(`🗑️ [Deleted voice] ${voiceId}`);
    res.status(200).json({ message: "Voice deleted successfully" });
  } catch (error) {
    console.error("❌ [Voice Delete Error]:", error.message, error.stack, error);
    res.status(500).json({
      error: `An unexpected error occurred while deleting voice: ${error.message}`,
    });
  }
};

// Delete all voice messages for a company
export const deleteS3VoicesByRoom = async (user, roomId) => {
  try {
    console.log(`🗑️ [Delete S3 Voices] roomId=${roomId}, userId=${user.userId}`);

    // Validate inputs
    if (!user || !user.userId || !user.companyId) {
      throw new Error("User authentication required");
    }
    if (!roomId || typeof roomId !== "string" || roomId.trim() === "") {
      throw new Error("Room ID is required and must be a non-empty string");
    }

    const db = getDB();
    const messageCollection = db.collection("messages");
    const roomCollection = db.collection("rooms");

    // Verify room access
    const room = await roomCollection.findOne({ roomId });
    if (!room) {
      throw new Error("Room not found");
    }
    if (String(room.companyId) !== String(user.companyId)) {
      throw new Error("User not authorized for this room’s company");
    }
    if (roomId.startsWith("room_") && !room.users.includes(user.userId)) {
      throw new Error("User not authorized for this room");
    }

    // Fetch messages with voice files
    const messages = await messageCollection
      .find({
        roomId,
        companyId: new ObjectId(user.companyId),
        voice: { $exists: true },
      })
      .toArray();

    // Collect S3 keys
    const voiceKeys = messages
      .filter((message) => message.voice && message.voice.s3Key)
      .map((message) => ({ Key: message.voice.s3Key }));

    // Delete voice files from S3
    if (voiceKeys.length > 0) {
      const deleteParams = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Delete: {
          Objects: voiceKeys,
          Quiet: false,
        },
      };
      console.log("Deleting S3 voice files:", deleteParams);
      await s3.send(new DeleteObjectsCommand(deleteParams));
      console.log(`✅ Deleted ${voiceKeys.length} S3 voice files for room ${roomId}`);
    } else {
      console.log(`No S3 voice files to delete for room ${roomId}`);
    }

    return { success: true, deletedCount: voiceKeys.length };
  } catch (error) {
    console.error("❌ [Delete S3 Voices Error]:", error.message, error.stack);
    throw error;
  }
};

// Fetch all voice messages for a company
export const getAllCompanyVoices = async (req, res) => {
  try {
    console.log("📥 [Fetch All Voices Request] Headers:", req.headers);
    console.log("📥 [Fetch All Voices Request] Params:", req.params);

    // Authenticate user
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

    // Get roomId from URL parameter
    const { roomId } = req.params;
    if (!roomId) {
      console.log("❌ No roomId provided");
      return res.status(400).json({ error: "roomId is required" });
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
          .json({ error: "Not authorized to access this room" });
      }
    } else if (
      roomId.startsWith("company_") &&
      roomId !== `company_${decoded.companyId}`
    ) {
      console.log("❌ Not authorized for company room:", roomId);
      return res
        .status(403)
        .json({ error: "Not authorized to access this room" });
    }

    // Fetch voice messages from MongoDB
    const messageCollection = db.collection("messages");
    const voiceMessages = await messageCollection
      .find({ roomId, voice: { $exists: true } })
      .toArray();

    // Generate presigned URLs for each voice message
    const messagesWithDetails = await Promise.all(
      voiceMessages.map(async (msg) => {
        const presignedUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: msg.voice.s3Key,
          }),
          { expiresIn: 3600 }
        );
        return {
          _id: msg._id.toString(),
          message: msg.message,
          userId: msg.userId,
          username: msg.username,
          roomId: msg.roomId,
          timestamp: msg.timestamp.toISOString(),
          voice: {
            filename: msg.voice.filename,
            originalName: msg.voice.originalName,
            mimeType: msg.voice.mimeType,
            size: msg.voice.size,
            url: presignedUrl,
          },
        };
      })
    );

    console.log(
      `📥 [Fetched ${messagesWithDetails.length} voice messages] for room: ${roomId}`
    );

    res.status(200).json({
      success: true,
      message: "Voice messages retrieved successfully",
      messages: messagesWithDetails, // Changed from 'voices' to 'messages'
    });
  } catch (error) {
    console.error("❌ [Fetch All Voices Error]:", error.message, error.stack);
    res.status(500).json({
      error: `An unexpected error occurred while fetching voice files: ${error.message}`,
    });
  }
};
