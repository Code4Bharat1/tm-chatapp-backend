import multer from "multer";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { fileURLToPath } from "url";
import path from "path";
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
    // Check AWS environment variables
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
    console.log("📥 [Voice Upload Request] User:", req.user);

    // Use user data from authMiddleware
    const user = req.user;
    const allowedRoles = [
      "Employee",
      "CEO",
      "Manager",
      "HR",
      "Client",
      "TeamLeader",
    ];
    if (!allowedRoles.includes(user.position)) {
      console.log("❌ Insufficient permissions:", user.position);
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
    const companyCollection = db.collection("companyregistrations");
    const roomId = req.body.roomId || `company_${user.companyId}`;
    console.log("📤 [Uploading voice to room]:", roomId);
    
    const roomCollection = db.collection("rooms");
    if (roomId.startsWith("room_")) {
      const room = await roomCollection.findOne({ roomId });
      if (!room || !room.users.includes(user.userId)) {
        console.log("❌ Not authorized for room:", roomId);
        return res
          .status(403)
          .json({ error: "Not authorized to upload to this room" });
      }
    }

    // Fetch company name from companyInfo.companyName (same logic as messageController)
    const company = await companyCollection.findOne({
      _id: new ObjectId(user.companyId),
    });
    const companyName = company?.companyInfo?.companyName || "Unknown Company";
    console.log(
      `Fetched company name: ${companyName} for companyId: ${user.companyId}`
    );

    // Save voice file metadata to MongoDB
    const voiceMetadata = {
      _id: new ObjectId(),
      message: "Voice file uploaded",
      userId: user.userId,
      username: user.firstName || "Anonymous",
      roomId,
      companyName, // Store the fetched company name
      companyId: new ObjectId(user.companyId),
      timestamp: new Date(),
      voice: {
        filename,
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

    // Create the base message object
    const baseMessage = {
      _id: voiceMetadata._id.toString(),
      message: voiceMetadata.message,
      userId: voiceMetadata.userId,
      username: voiceMetadata.username,
      roomId: voiceMetadata.roomId,
      companyName: voiceMetadata.companyName,
      timestamp: voiceMetadata.timestamp.toISOString(),
      voice: {
        filename: voiceMetadata.voice.filename,
        originalName: voiceMetadata.voice.originalName,
        mimeType: voiceMetadata.voice.mimeType,
        size: voiceMetadata.voice.size,
        url: presignedUrl,
      },
    };

    // Get all users in the room to determine their roles and send appropriate messages
    const userCollection = db.collection("users");
    const employeeCollection = db.collection("admins");
    const clientCollection = db.collection("clients");
    
    // Get room details
    const room = await roomCollection.findOne({ roomId });
    if (room && room.users) {
      // Send personalized messages to each user based on their role
      for (const roomUserId of room.users) {
        try {
          // Determine user role
          let userRole = null;
          const roomUser = await userCollection.findOne({ _id: new ObjectId(roomUserId) });
          if (roomUser) {
            userRole = "user";
          } else {
            const employee = await employeeCollection.findOne({ _id: new ObjectId(roomUserId) });
            if (employee) {
              userRole = "admin";
            } else {
              const client = await clientCollection.findOne({ _id: new ObjectId(roomUserId) });
              if (client) {
                userRole = "client";
              }
            }
          }

          // Create message based on recipient's role
          let messageToSend = { ...baseMessage };
          
          // For clients: show company name for other users' messages, show username for their own messages
          if (userRole === "client") {
            messageToSend.username = voiceMetadata.userId === roomUserId 
              ? voiceMetadata.username 
              : voiceMetadata.companyName;
          }
          
          // Send to specific user
          const io = req.app.get("io");
          io.to(roomUserId).emit("newVoice", messageToSend);
        } catch (userError) {
          console.warn(`⚠️ Could not determine role for user ${roomUserId}:`, userError.message);
        }
      }
    } else {
      // Fallback: broadcast to room (original logic)
      const io = req.app.get("io");
      io.to(roomId).emit("newVoice", baseMessage);
    }

    // Return full metadata in response
    res.status(200).json({
      _id: voiceMetadata._id.toString(),
      message: "Voice file uploaded successfully",
      userId: voiceMetadata.userId,
      username: voiceMetadata.username,
      roomId: voiceMetadata.roomId,
      companyName: voiceMetadata.companyName,
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
    console.log("📥 [Voice Download Request] User:", req.user);

    // Use user data from authMiddleware
    const user = req.user;
    const allowedRoles = [
      "Employee",
      "CEO",
      "Manager",
      "HR",
      "Client",
      "TeamLeader",
    ];
    if (!allowedRoles.includes(user.position)) {
      console.log("❌ Insufficient permissions:", user.position);
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

    // Verify room access
    const roomId = voiceMetadata.roomId;
    const roomCollection = db.collection("rooms");
    if (roomId.startsWith("room_")) {
      const room = await roomCollection.findOne({ roomId });
      if (!room || !room.users.includes(user.userId)) {
        console.log("❌ Not authorized for room:", roomId);
        return res
          .status(403)
          .json({ error: "Not authorized to access this voice file" });
      }
    } else if (
      roomId.startsWith("company_") &&
      roomId !== `company_${user.companyId}`
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

export const deleteVoice = async (req, res) => {
  try {
    console.log("🗑️ [Voice Delete Request] Headers:", req.headers);
    console.log("🗑️ [Voice Delete Request] Params:", req.params);
    console.log("🗑️ [Voice Delete Request] User:", req.user);

    // Use user data from authMiddleware
    const user = req.user;
    const allowedRoles = [
      "Employee",
      "CEO",
      "Manager",
      "HR",
      "Client",
      "TeamLeader",
    ];
    if (!allowedRoles.includes(user.position)) {
      console.log("❌ Insufficient permissions:", user.position);
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
      if (!room || !room.users.includes(user.userId)) {
        console.log("❌ Not authorized for room:", roomId);
        return res
          .status(403)
          .json({ error: "Not authorized to delete this voice" });
      }
    } else if (
      roomId.startsWith("company_") &&
      roomId !== `company_${user.companyId}`
    ) {
      console.log("❌ Not authorized for company room:", roomId);
      return res
        .status(403)
        .json({ error: "Not authorized to delete this voice" });
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
      companyId: new ObjectId(user.companyId),
    });

    // Emit socket event
    const io = req.app.get("io");
    io.to(roomId).emit("voiceDeleted", {
      voiceId,
      roomId,
      message: "Voice deleted",
      timestamp: new Date().toISOString(),
    });

    console.log(`🗑️ [Deleted voice] ${voiceId}`);
    res.status(200).json({ message: "Voice deleted successfully" });
  } catch (error) {
    console.error("❌ [Voice Delete Error]:", error.message, error.stack);
    res.status(500).json({
      error: `An unexpected error occurred while deleting voice: ${error.message}`,
    });
  }
};

export const deleteS3VoicesByRoom = async (adata) => {
  try {
    const { user, roomId } = adata;
    console.log("🗑️ [Delete S3 Voices] User:", user);
    console.log("🗑️ [Delete S3 Voices] Room ID:", roomId);

    // Validate inputs
    if (!user || !user.userId || !user.companyId) {
      console.log("❌ Missing user data");
      throw new Error("User authentication required: missing userId or companyId");
    }
    if (!roomId || typeof roomId !== "string" || roomId.trim() === "") {
      console.log("❌ Invalid roomId");
      throw new Error("Room ID is required and must be a non-empty string");
    }

    const db = getDB();
    const messageCollection = db.collection("messages");
    const roomCollection = db.collection("rooms");

    // Verify room access
    const room = await roomCollection.findOne({ roomId });
    if (!room) {
      console.log("❌ Room not found:", roomId);
      throw new Error(`Room not found: ${roomId}`);
    }
    if (String(room.companyId) !== String(user.companyId)) {
      console.log("❌ User not authorized for room:", roomId);
      throw new Error("User not authorized for this room’s company");
    }
    if (roomId.startsWith("room_") && !room.users.includes(user.userId)) {
      console.log("❌ User not authorized for room:", roomId);
      throw new Error("User not authorized for this room");
    }

    // Fetch messages with voice files
    const messages = await messageCollection
      .find({
        roomId,
        voice: { $exists: true },
      })
      .toArray();
    console.log(
      `🔍 Found ${messages.length} messages with voice field for room ${roomId}`
    );

    // Collect S3 keys
    const voiceKeys = messages
      .filter(
        (message) =>
          message.voice &&
          message.voice.s3Key &&
          typeof message.voice.s3Key === "string"
      )
      .map((message) => ({ Key: message.voice.s3Key }));
    console.log(`🔍 Collected ${voiceKeys.length} voice S3 keys`);

    // Delete voice files from S3
    let deletedCount = 0;
    if (voiceKeys.length > 0) {
      const deleteParams = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Delete: {
          Objects: voiceKeys,
          Quiet: false,
        },
      };
      console.log("Deleting S3 voice files:", deleteParams);
      const result = await s3.send(new DeleteObjectsCommand(deleteParams));
      deletedCount = result.Deleted ? result.Deleted.length : voiceKeys.length;
      console.log(
        `✅ Deleted ${deletedCount} S3 voice files for room ${roomId}`
      );
      if (result.Errors && result.Errors.length > 0) {
        console.error("❌ S3 deletion errors:", result.Errors);
      }

      // Delete corresponding messages from MongoDB
      await messageCollection.deleteMany({
        roomId,
        voice: { $exists: true },
      });
    } else {
      console.log(`No valid S3 voice files to delete for room ${roomId}`);
    }

    // Emit socket event
    const io = adata.io || (adata.app && adata.app.get("io")); // Access io from adata
    if (io) {
      io.to(roomId).emit("voicesDeleted", {
        roomId,
        message: `Deleted ${deletedCount} voice files`,
        timestamp: new Date().toISOString(),
      });
    } else {
      console.warn("Socket.io instance not found in adata");
    }

    return { success: true, deletedCount };
  } catch (error) {
    console.error("❌ [Delete S3 Voices Error]:", error.message, error.stack);
    throw new Error(`An unexpected error occurred while deleting voice files: ${error.message}`);
  }
};

export const getAllCompanyVoices = async (req, res) => {
  try {
    // console.log("📥 [Fetch All Voices Request] Headers:", req.headers);
    // console.log("📥 [Fetch All Voices Request] Params:", req.params);
    // console.log("📥 [Fetch All Voices Request] User:", req.user);

    // Use user data from authMiddleware
    const user = req.user;
    const allowedRoles = [
      "Employee",
      "CEO",
      "Manager",
      "HR",
      "Client",
      "TeamLeader",
    ];
    if (!allowedRoles.includes(user.position)) {
      console.log("❌ Insufficient permissions:", user.position);
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

    // Get database collections
    const db = getDB();
    const roomCollection = db.collection("rooms");
    const userCollection = db.collection("users");
    const employeeCollection = db.collection("admins");
    const clientCollection = db.collection("clients");

    // Verify room access
    if (roomId.startsWith("room_")) {
      const room = await roomCollection.findOne({ roomId });
      if (!room) {
        console.log("❌ Room not found:", roomId);
        return res
          .status(404)
          .json({ success: false, error: "Room not found" });
      }
      if (!room.users.includes(user.userId)) {
        console.log("❌ Not authorized for room:", roomId);
        return res
          .status(403)
          .json({ success: false, error: "Not authorized to access this room" });
      }
    } else if (
      roomId.startsWith("company_") &&
      roomId !== `company_${user.companyId}`
    ) {
      console.log("❌ Not authorized for company room:", roomId);
      return res
        .status(403)
        .json({ success: false, error: "Not authorized to access this room" });
    }

    // Fetch user role (same logic as getMessagesByRoom)
    let role = null;
    const userDoc = await userCollection.findOne({ _id: new ObjectId(user.userId) });
    if (userDoc) {
      role = "user";
    } else {
      const employee = await employeeCollection.findOne({
        _id: new ObjectId(user.userId),
      });
      if (employee) {
        role = "admin";
      } else {
        const client = await clientCollection.findOne({
          _id: new ObjectId(user.userId),
        });
        if (client) {
          role = "client";
        }
      }
    }

    if (!role) {
      console.warn(`⚠️ [Validation Failed] User not found: ${user.userId}`);
      return res.status(404).json({ message: "User not found" });
    }

    // Fetch voice messages from MongoDB
    const messageCollection = db.collection("messages");
    const voiceMessages = await messageCollection
      .find({
        roomId,
        companyId: new ObjectId(user.companyId),
        voice: { $exists: true },
      })
      .sort({ timestamp: -1 })
      .toArray();

    console.log(
      `📜 [Found ${voiceMessages.length} voice messages in MongoDB] for room: ${roomId}`
    );

    if (voiceMessages.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No voice messages found",
        data: [],
      });
    }

    // Generate presigned URLs for valid voice messages
    const messagesWithDetails = await Promise.all(
      voiceMessages.map(async (msg) => {
        if (!msg.voice || !msg.voice.s3Key) {
          console.warn(`⚠️ [Invalid Voice Metadata] Message ID: ${msg._id}`);
          return null;
        }

        try {
          // Validate file existence in S3
          const headParams = {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: msg.voice.s3Key,
          };
          await s3.send(new HeadObjectCommand(headParams));
          // console.log(`✅ S3 Voice Exists: ${msg.voice.s3Key}`);

          // Generate presigned URL
          const presignedUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({
              Bucket: process.env.AWS_BUCKET_NAME,
              Key: msg.voice.s3Key,
            }),
            { expiresIn: 3600 }
          );

          // Apply the same username logic as getMessagesByRoom
          let displayUsername = msg.username || "Anonymous";
          
          // For clients: Use companyName for admin/user messages, username for client messages
          if (role === "client") {
            displayUsername = msg.userId === user.userId 
              ? msg.username || "Anonymous"
              : msg.companyName || "Unknown Company";
          }
          // For admins/users: Always use username (firstName)

          const messageData = {
            _id: msg._id.toString(),
            message: msg.message || "Voice message",
            userId: msg.userId ? msg.userId.toString() : "unknown",
            username: displayUsername,
            roomId: msg.roomId,
            companyId: msg.companyId ? msg.companyId.toString() : null,
            timestamp: msg.timestamp.toISOString(),
            companyName: msg.companyName || "Unknown Company",
            updatedAt: msg.updatedAt ? msg.updatedAt.toISOString() : null,
            voice: {
              filename: msg.voice.filename,
              originalName: msg.voice.originalName,
              mimeType: msg.voice.mimeType,
              size: msg.voice.size,
              url: presignedUrl,
            },
          };

          // console.log(`📤 [Processed Voice Message]:`, JSON.stringify(messageData));
          return messageData;
        } catch (s3Error) {
          console.error(
            `❌ [S3 Error] Message ID: ${msg._id}, Voice: ${msg.voice.s3Key}`,
            s3Error.message
          );
          return null;
        }
      })
    );

    // Filter out null entries
    const validMessages = messagesWithDetails.filter((msg) => msg !== null);

    // console.log(
    //   `📥 [Fetched ${validMessages.length} valid voice messages] for room: ${roomId}, User: ${user.userId}, Role: ${role}`
    // );

    res.status(200).json({
      success: true,
      message: "Voice messages retrieved successfully",
      data: validMessages,
    });
  } catch (error) {
    console.error("❌ [Fetch All Voices Error]:", error.message, error.stack);
    res.status(500).json({
      success: false,
      error: `An unexpected error occurred while fetching voice messages: ${error.message}`,
    });
  }
};