import { getDB } from "../services/db.js";
import { ObjectId } from "mongodb";
import cookie from "cookie";
import jwt from "jsonwebtoken";
import { deleteS3FilesByRoom } from "./filleController.js";
import { deleteS3VoicesByRoom } from "./voiceController.js";

export const handleSendMessage = async (socket, message, targetRoom) => {
  const db = getDB();
  const messageCollection = db.collection("messages");
  const companyCollection = db.collection("companyregistrations");

  try {
    const user = socket.user;

    if (!message || typeof message !== "string" || message.trim() === "") {
      console.warn("⚠️ [Validation Failed] Empty or invalid message");
      throw new Error("Message is required and must be a non-empty string");
    }

    if (!targetRoom || typeof targetRoom !== "string") {
      console.warn("⚠️ [Validation Failed] Invalid or missing target room");
      throw new Error("Target room is required");
    }

    // Fetch company name from companyInfo.companyName
    const company = await companyCollection.findOne({
      _id: new ObjectId(user.companyId),
    });
    const companyName = company?.companyInfo?.companyName || "Unknown Company";

    const formattedMessage = {
      userId: user.userId,
      username: user.firstName || "Anonymous",
      companyName, // Store company name
      message: message.trim(),
      timestamp: new Date(),
      companyId: new ObjectId(user.companyId),
      roomId: targetRoom,
    };

    const savedMessage = await messageCollection.insertOne(formattedMessage);

    return {
      ...formattedMessage,
      _id: savedMessage.insertedId.toString(),
      timestamp: formattedMessage.timestamp.toISOString(),
    };
  } catch (error) {
    console.error("❌ [handleSendMessage Error]:", error.message);
    socket.emit(
      "errorMessage",
      error.message || "Server error while sending message"
    );
    throw error;
  }
};

export const handleEditMessage = async (socket, data, targetRoom) => {
  const db = getDB();
  const messageCollection = db.collection("messages");

  try {
    const user = socket.user;
    const { messageId, newMessage } = data;

    if (!messageId || !ObjectId.isValid(messageId)) {
      console.warn("⚠️ [Validation Failed] Invalid or missing message ID");
      return socket.emit("errorMessage", "Invalid or missing message ID");
    }
    if (
      !newMessage ||
      typeof newMessage !== "string" ||
      newMessage.trim() === ""
    ) {
      console.warn("⚠️ [Validation Failed] Empty or invalid new message");
      return socket.emit(
        "errorMessage",
        "New message is required and must be a non-empty string"
      );
    }
    if (!targetRoom || typeof targetRoom !== "string") {
      console.warn("⚠️ [Validation Failed] Invalid or missing target room");
      return socket.emit("errorMessage", "Target room is required");
    }

    const message = await messageCollection.findOne({
      _id: new ObjectId(messageId),
      roomId: targetRoom, // Ensure the message belongs to the target room
    });
    if (!message) {
      console.warn(
        `⚠️ [Validation Failed] Message not found for ID: ${messageId} in room: ${targetRoom}`
      );
      return socket.emit("errorMessage", "Message not found in this room");
    }
    if (message.userId !== user.userId) {
      console.warn(
        `⚠️ [Validation Failed] User ${user.userId} not authorized to edit message ${messageId}`
      );
      return socket.emit(
        "errorMessage",
        "You are not authorized to edit this message"
      );
    }

    const updatedMessage = {
      ...message,
      message: newMessage.trim(),
      updatedAt: new Date(),
    };

    const result = await messageCollection.updateOne(
      { _id: new ObjectId(messageId), roomId: targetRoom },
      { $set: { message: newMessage.trim(), updatedAt: new Date() } }
    );

    if (result.modifiedCount === 0) {
      console.warn(
        `⚠️ [Update Failed] Message not updated for ID: ${messageId} in room: ${targetRoom}`
      );
      return socket.emit("errorMessage", "Failed to update message");
    }

    const messageToSend = {
      ...updatedMessage,
      _id: messageId,
      userId: user.userId,
      timestamp: message.timestamp,
      updatedAt: updatedMessage.updatedAt.toISOString(),
    };

    socket.to(targetRoom).emit("messageUpdated", messageToSend);
    socket.emit("messageUpdated", messageToSend);
  } catch (error) {
    console.error(`❌ [handleEditMessage Error]: ${error.message}`);
    socket.emit("errorMessage", "Server error while editing message");
  }
};

export const handleDeleteMessage = async (socket, messageId, targetRoom) => {
  const db = getDB();
  const messageCollection = db.collection("messages");

  try {
    const user = socket.user;

    if (!messageId || !ObjectId.isValid(messageId)) {
      console.warn("⚠️ [Validation Failed] Invalid message ID");
      return socket.emit("errorMessage", "Invalid message ID");
    }
    if (!targetRoom || typeof targetRoom !== "string") {
      console.warn("⚠️ [Validation Failed] Invalid or missing target room");
      return socket.emit("errorMessage", "Target room is required");
    }

    const message = await messageCollection.findOne({
      _id: new ObjectId(messageId),
      roomId: targetRoom,
    });
    if (!message) {
      console.warn(
        `⚠️ [Validation Failed] Message not found for ID: ${messageId} in room: ${targetRoom}`
      );
      return socket.emit("errorMessage", "Message not found in this room");
    }
    if (message.userId !== user.userId) {
      console.warn(
        `⚠️ [Validation Failed] User ${user.userId} not authorized to delete message ${messageId}`
      );
      return socket.emit(
        "errorMessage",
        "You are not authorized to delete this message"
      );
    }

    const result = await messageCollection.deleteOne({
      _id: new ObjectId(messageId),
      roomId: targetRoom,
    });
    if (result.deletedCount === 0) {
      console.warn(
        `⚠️ [Delete Failed] Message not deleted for ID: ${messageId} in room: ${targetRoom}`
      );
      return socket.emit("errorMessage", "Failed to delete message");
    }

    socket.to(targetRoom).emit("messageDeleted", { messageId });
    socket.emit("messageDeleted", { messageId });
  } catch (error) {
    console.error("❌ [handleDeleteMessage Error]:", error.message);
    socket.emit("errorMessage", "Server error while deleting message");
  }
};

export const getLogginUser = async (req, res) => {
  try {
    // Check if req.user is set by authMiddleware
    if (!req.user) {
      console.warn("No authenticated user found in req.user");
      return res
        .status(401)
        .json({ message: "No authenticated user, authorization denied" });
    }

    // Normalize firstName: use firstName, fall back to name for clients, then null
    const normalizedUser = {
      ...req.user,
      firstName: req.user.firstName || req.user.name || null,
    };

    // Return the normalized user data
    return res.status(200).json(normalizedUser);
  } catch (error) {
    console.error("Error in getLogginUser:", error.message, error.stack);
    return res
      .status(500)
      .json({ message: "Server error while fetching user data" });
  }
};

// New controller to get all users by companyId
export const getUsersByCompany = async (req, res) => {
  const db = getDB();
  const userCollection = db.collection("users");
  const employeeCollection = db.collection("admins");
  const clientCollection = db.collection("clients");

  try {
    // Check if req.user is set by authMiddleware
    if (!req.user) {
      console.warn("No authenticated user found in req.user");
      return res
        .status(401)
        .json({ message: "No authenticated user, authorization denied" });
    }

    // Return empty array for client role without error
    if (req.user.role === "Client") {
      return res.status(200).json({
        success: true,
        data: [],
      });
    }

    // Get companyId from req.user
    const companyId = new ObjectId(req.user.companyId);
    if (!companyId) {
      console.warn(`No companyId found for user: ${req.user.userId}`);
      return res
        .status(400)
        .json({ message: "Invalid user data: companyId not found" });
    }

    // Determine the logged-in user's ID based on role
    let loggedInUserId;
    if (req.user.role === "user") {
      loggedInUserId = req.user.userId;
    } else if (req.user.role === "admin") {
      loggedInUserId = req.user.adminId;
    } else if (req.user.role === "Client") {
      loggedInUserId = req.user.clientId;
    }

    // Define projection for user data
    const projection = {
      _id: 1,
      firstName: 1,
      name: 1,
      fullName: 1,
      email: 1,
      position: 1,
    };

    // Query users collection
    const usersFromUsers = await userCollection
      .find({ companyId }, { projection })
      .toArray();

    // Query admins collection
    const usersFromEmployees = await employeeCollection
      .find({ companyId }, { projection })
      .toArray();

    // Query clients collection
    const usersFromClients = await clientCollection
      .find({ companyId }, { projection })
      .toArray();

    // Combine and format results, excluding the logged-in user
    const allUsers = [
      ...usersFromUsers.map((user) => ({ ...user, role: "user" })),
      ...usersFromEmployees.map((user) => ({ ...user, role: "admin" })),
      ...usersFromClients.map((user) => ({ ...user, role: "Client" })),
    ]
      .filter((user) => String(user._id) !== String(loggedInUserId))
      .map((user) => ({
        userId: user._id.toString(),
        firstName: user.firstName || user.name || user.fullName || "Anonymous",
        email: user.email || null,
        position: user.position || user.role || null,
        role: user.role,
      }));

    return res.status(200).json({
      success: true,
      data: allUsers,
    });
  } catch (error) {
    console.error("❌ [getUsersByCompany Error]:", error.message, error.stack);
    return res
      .status(500)
      .json({ message: "Server error while fetching users" });
  }
};

export const getMessagesByRoom = async (req, res) => {
  const db = getDB();
  const messageCollection = db.collection("messages");
  const roomCollection = db.collection("rooms");
  const userCollection = db.collection("users");
  const employeeCollection = db.collection("admins");
  const clientCollection = db.collection("clients");

  try {
    // Authentication is handled by authMiddleware, so req.user should be populated
    const userId = req.user.userId;

    // Validate roomId
    const { roomId } = req.query;
    if (!roomId || typeof roomId !== "string" || roomId.trim() === "") {
      console.warn("⚠️ [Validation Failed] Invalid or missing roomId");
      return res.status(400).json({
        message: "Room ID is required and must be a non-empty string",
      });
    }

    // Check if the room exists and the user is a member
    const room = await roomCollection.findOne({ roomId });
    if (!room) {
      console.warn(`⚠️ [Validation Failed] Room not found: ${roomId}`);
      return res.status(404).json({ message: "Room not found" });
    }

    if (!room.users.includes(userId)) {
      console.warn(
        `⚠️ [Validation Failed] User ${userId} not authorized for room ${roomId}`
      );
      return res
        .status(403)
        .json({ message: "You are not authorized to access this room" });
    }

    // Fetch user role
    let role = null;
    const user = await userCollection.findOne({ _id: new ObjectId(userId) });
    if (user) {
      role = "user";
    } else {
      const employee = await employeeCollection.findOne({
        _id: new ObjectId(userId),
      });
      if (employee) {
        role = "admin";
      } else {
        const client = await clientCollection.findOne({
          _id: new ObjectId(userId),
        });
        if (client) {
          role = "Client";
        }
      }
    }

    if (!role) {
      console.warn(`⚠️ [Validation Failed] User not found: ${userId}`);
      return res.status(404).json({ message: "User not found" });
    }

    // Fetch messages for the room, sorted by timestamp
    const messages = await messageCollection
      .find({ roomId })
      .sort({ timestamp: 1 })
      .toArray();

    // Format messages for frontend
    const formattedMessages = messages.map((msg) => {
      const message = {
        _id: msg._id.toString(),
        userId: msg.userId ? msg.userId.toString() : "unknown",
        username: msg.username || "Anonymous",
        message: msg.message,
        roomId: msg.roomId,
        companyId: msg.companyId ? msg.companyId.toString() : null,
        timestamp: msg.timestamp.toISOString(),
        companyName: msg.companyName || "Unknown Company",
        updatedAt: msg.updatedAt ? msg.updatedAt.toISOString() : null,
      };

      // For clients: Use companyName for admin/user messages, username for client messages
      if (role === "Client") {
        message.username =
          msg.userId === userId ? msg.username : msg.companyName;
      }
      // For admins/users: Always use username (firstName)
      return message;
    });

    return res.status(200).json({
      success: true,
      data: formattedMessages,
    });
  } catch (error) {
    console.error("❌ [getMessagesByRoom Error]:", error.message);
    return res
      .status(500)
      .json({ message: "Server error while fetching messages" });
  }
};

export const handleLeaveRoom = async (socket, roomId) => {
  const db = getDB();
  const roomCollection = db.collection("rooms");

  try {
    const user = socket.user;

    // Validate user
    if (!user || !user.userId) {
      console.warn("⚠️ [Validation Failed] User not authenticated");
      return socket.emit("errorMessage", "Authentication required");
    }

    // Validate roomId
    if (!roomId || typeof roomId !== "string" || roomId.trim() === "") {
      console.warn("⚠️ [Validation Failed] Invalid or missing roomId");
      return socket.emit(
        "errorMessage",
        "Room ID is required and must be a non-empty string"
      );
    }

    // Check if the room exists and matches companyId
    const room = await roomCollection.findOne({ roomId });
    if (!room) {
      console.warn(`⚠️ [Validation Failed] Room not found: ${roomId}`);
      return socket.emit("errorMessage", "Room not found");
    }

    if (room.companyId !== user.companyId) {
      console.warn(
        `⚠️ [Validation Failed] User ${user.userId} not authorized for company ${room.companyId}`
      );
      return socket.emit(
        "errorMessage",
        "You are not authorized to access this room"
      );
    }

    // Check if the user is in the room
    if (!room.users.includes(user.userId)) {
      console.warn(
        `⚠️ [Validation Failed] User ${user.userId} not in room ${roomId}`
      );
      return socket.emit("errorMessage", "You are not a member of this room");
    }

    // Prevent creator from leaving (optional)
    if (room.creator === user.userId) {
      console.warn(
        `⚠️ [Validation Failed] Creator ${user.userId} cannot leave room ${roomId}`
      );
      return socket.emit("errorMessage", "Room creator cannot leave the room");
    }

    // Remove user from room's user list
    const result = await roomCollection.updateOne(
      { roomId },
      { $pull: { users: user.userId } }
    );

    if (result.modifiedCount === 0) {
      console.warn(
        `⚠️ [Update Failed] User ${user.userId} not removed from room ${roomId}`
      );
      return socket.emit("errorMessage", "Failed to leave room");
    }

    // Check if room is empty and delete if necessary (optional)
    const updatedRoom = await roomCollection.findOne({ roomId });
    if (updatedRoom.users.length === 0) {
      await roomCollection.deleteOne({ roomId });
    }

    // Leave the socket room
    socket.leave(roomId);

    // Notify the user and others in the room
    socket.emit("roomLeft", {
      success: true,
      message: "Successfully left the room",
      data: { roomId, userId: user.userId },
    });

    socket.to(roomId).emit("userLeftRoom", {
      userId: user.userId,
      username: user.firstName || "Anonymous",
      roomId,
      roomName: room.roomName,
    });
  } catch (error) {
    console.error("❌ [handleLeaveRoom Error]:", error.message);
    socket.emit("errorMessage", "Server error while leaving room");
  }
};

export const handleDeleteRoom = async (req, res) => {
  try {
    // Check if req.user is set by authMiddleware
    if (!req.user) {
      console.warn("No authenticated user found in req.user");
      return res
        .status(401)
        .json({ error: "No authenticated user, authorization denied" });
    }

    // Restrict to higher privilege roles
    // const allowedRoles = ["CEO", "Manager", "HR"];
    // if (!allowedRoles.includes(req.user.position)) {
    //   console.warn(
    //     `Insufficient permissions for user ${req.user.userId}: ${req.user.position}`
    //   );
    //   return res
    //     .status(403)
    //     .json({ error: "Insufficient position permissions" });
    // }

    // Get roomId from URL parameter
    const { roomId } = req.params;
    if (!roomId) {
      console.warn("No roomId provided");
      return res.status(400).json({ error: "roomId is required" });
    }

    const db = getDB();
    const roomCollection = db.collection("rooms");

    // Verify room exists and user is authorized
    const room = await roomCollection.findOne({ roomId });
    if (!room) {
      console.warn(`Room not found: ${roomId}`);
      return res.status(404).json({ error: "Room not found" });
    }
    if (String(room.companyId) !== String(req.user.companyId)) {
      console.warn(
        `Unauthorized company access for user ${req.user.userId}: ${room.companyId}`
      );
      return res.status(403).json({ error: "Not authorized for this company" });
    }
    // Check if the user is the creator of the room
    if (String(room.creator) !== String(req.user.userId)) {
      console.warn(
        `User ${req.user.userId} is not the creator of room ${roomId}`
      );
      return res
        .status(403)
        .json({ error: "Only the room creator can delete this room" });
    }

    // Delete all S3 voice files for the room
    const voiceDeletionResult = await deleteS3VoicesByRoom({
      user: req.user,
      roomId,
      app: req.app,
    });

    // Delete all S3 files for the room
    const fileDeletionResult = await deleteS3FilesByRoom({
      user: req.user,
      roomId,
      app: req.app,
    });

    // Delete all messages for the room
    const messageCollection = db.collection("messages");
    const messageDeletionResult = await messageCollection.deleteMany({
      roomId,
    });

    // Delete the room from MongoDB
    const deleteResult = await roomCollection.deleteOne({ roomId });
    if (deleteResult.deletedCount === 0) {
      console.warn(`Failed to delete room: ${roomId}`);
      return res
        .status(500)
        .json({ error: "Failed to delete room from rooms collection" });
    }

    // Emit Socket.IO event to notify clients
    const io = req.app.get("io");
    io.to(roomId).emit("roomDeleted", {
      roomId,
      userId: req.user.userId,
      timestamp: new Date().toISOString(),
    });

    res.status(200).json({
      message: `Successfully deleted room ${roomId}, ${voiceDeletionResult.deletedCount} voice files, ${fileDeletionResult.deletedCount} files, and ${messageDeletionResult.deletedCount} messages`,
      deletedRoomCount: deleteResult.deletedCount,
      deletedVoiceCount: voiceDeletionResult.deletedCount,
      deletedFileCount: fileDeletionResult.deletedCount,
      deletedMessageCount: messageDeletionResult.deletedCount,
    });
  } catch (error) {
    console.error("❌ [Delete Room Error]:", error.message, error.stack);
    return res.status(500).json({
      error: `An unexpected error occurred while deleting the room: ${error.message}`,
    });
  }
};

export const getRooms = async (req, res) => {
  try {
    // Check if req.user is set by authMiddleware
    if (!req.user) {
      console.warn("No authenticated user found in req.user");
      return res
        .status(401)
        .json({ error: "No authenticated user, authorization denied" });
    }

    const db = getDB();
    const roomCollection = db.collection("rooms");

    // Query rooms where the user is in the users array and companyId matches
    const rooms = await roomCollection
      .find({
        users: req.user.userId,
        companyId: new ObjectId(req.user.companyId),
      })
      .toArray();

    return res.status(200).json({
      success: true,
      data: rooms.map((room) => ({
        roomId: room.roomId,
        roomName: room.roomName,
        users: room.users,
        creator: room.creator,
      })),
    });
  } catch (error) {
    console.error("❌ [Get Rooms Error]:", error.message, error.stack);
    return res
      .status(500)
      .json({ error: `Failed to fetch rooms: ${error.message}` });
  }
};
