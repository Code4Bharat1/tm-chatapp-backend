import { getDB } from "../services/db.js";
import { ObjectId } from "mongodb";
import cookie from "cookie";
import jwt from "jsonwebtoken";

export const handleSendMessage = async (socket, message, targetRoom) => {
  const db = getDB();
  const messageCollection = db.collection("messages");

  try {
    const user = socket.user;

    if (!message || typeof message !== "string" || message.trim() === "") {
      console.warn("⚠️ [Validation Failed] Empty or invalid message");
      return socket.emit(
        "errorMessage",
        "Message is required and must be a non-empty string"
      );
    }

    if (!targetRoom || typeof targetRoom !== "string") {
      console.warn("⚠️ [Validation Failed] Invalid or missing target room");
      return socket.emit("errorMessage", "Target room is required");
    }

    const formattedMessage = {
      userId: user.userId,
      username: user.firstName || "Anonymous",
      message: message.trim(),
      timestamp: new Date(),
      companyId: user.companyId,
      roomId: targetRoom, // Store the room ID (company room or specific room)
    };

    const savedMessage = await messageCollection.insertOne(formattedMessage);

    console.log(
      `💾 [Message Saved] ID: ${savedMessage.insertedId}, Room: ${targetRoom}`
    );
    console.log(`📤 [Broadcasting Message] to room: ${targetRoom}`);

    const messageToSend = {
      ...formattedMessage,
      _id: savedMessage.insertedId.toString(),
      timestamp: formattedMessage.timestamp.toISOString(),
    };

    // Send to everyone in the target room, including sender
    socket.to(targetRoom).emit("newMessage", messageToSend);
    socket.emit("newMessage", messageToSend);
  } catch (error) {
    console.error("❌ [handleSendMessage Error]:", error.message);
    socket.emit("errorMessage", "Server error while sending message");
  }
};

export const handleEditMessage = async (socket, data, targetRoom) => {
  const db = getDB();
  const messageCollection = db.collection("messages");

  try {
    const user = socket.user;
    const { messageId, newMessage } = data;

    console.log(
      `📥 [Edit Message Data] Received: messageId=${messageId}, newMessage="${newMessage}", Room: ${targetRoom}`
    );

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

    console.log(`✏️ [Message Updated] ID: ${messageId}, Room: ${targetRoom}`);
    console.log(`📤 [Broadcasting Updated Message] to room: ${targetRoom}`);

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

    console.log(`🗑️ [Message Deleted] ID: ${messageId}, Room: ${targetRoom}`);
    console.log(`📤 [Broadcasting Delete] to room: ${targetRoom}`);

    socket.to(targetRoom).emit("messageDeleted", { messageId });
    socket.emit("messageDeleted", { messageId });
  } catch (error) {
    console.error("❌ [handleDeleteMessage Error]:", error.message);
    socket.emit("errorMessage", "Server error while deleting message");
  }
};

// Express middleware
export const getLogginUser = async (req, res) => {
  const db = getDB();
  const userCollection = db.collection("users");
  const employeeCollection = db.collection("admins");

  try {
    let token = req.header("Authorization")?.replace("Bearer ", "");
    if (!token && req.headers.cookie) {
      const cookies = cookie.parse(req.headers.cookie);
      token = cookies.token;
    }

    if (!token) {
      return res
        .status(401)
        .json({ message: "No token provided, authorization denied" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    let userId;
    try {
      userId = new ObjectId(decoded.userId);
    } catch (error) {
      return res
        .status(401)
        .json({ message: "Invalid user ID format in token" });
    }

    const userFromUsers = await userCollection.findOne(
      { _id: userId },
      { projection: { position: 1, firstName: 1, companyId: 1, email: 1 } }
    );

    const userFromEmployees = await employeeCollection.findOne(
      { _id: userId },
      { projection: { position: 1, firstName: 1, companyId: 1, email: 1 } }
    );

    const user = userFromUsers || userFromEmployees;

    if (!user) {
      return res.status(401).json({
        message: "User not found in either collection, authorization denied",
      });
    }

    if (
      !["Employee", "CEO", "Manager", "HR", "Client", "TeamLeader"].includes(
        user.position
      )
    ) {
      return res.status(403).json({
        message: "Access denied: User is not an employee, head, or manager",
      });
    }

    req.user = {
      userId: decoded.userId,
      email: user.email,
      companyId: user.companyId,
      position: user.position,
      firstName: user.firstName,
    };

    return res.status(200).json(req.user);
  } catch (error) {
    console.error("Authentication error:", error.message);
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ message: "Invalid token" });
    }
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }
    res.status(500).json({ message: "Server error during authentication" });
  }
};

// New controller to get all users by companyId
export const getUsersByCompany = async (req, res) => {
  const db = getDB();
  const userCollection = db.collection("users");
  const employeeCollection = db.collection("admins");

  try {
    let token = req.header("Authorization")?.replace("Bearer ", "");
    if (!token && req.headers.cookie) {
      const cookies = cookie.parse(req.headers.cookie);
      token = cookies.token;
    }

    if (!token) {
      return res
        .status(401)
        .json({ message: "No token provided, authorization denied" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const companyId = new ObjectId(decoded.companyId);

    // Query users collection
    const usersFromUsers = await userCollection
      .find(
        { companyId: companyId },
        { projection: { _id: 1, firstName: 1, email: 1, position: 1 } }
      )
      .toArray();

    // Query admins collection
    const usersFromEmployees = await employeeCollection
      .find(
        { companyId: companyId },
        { projection: { _id: 1, firstName: 1, email: 1, position: 1 } }
      )
      .toArray();

    // Combine and format results
    const allUsers = [...usersFromUsers, ...usersFromEmployees].map((user) => ({
      userId: user._id.toString(),
      firstName: user.firstName || "Anonymous",
      email: user.email,
      position: user.position,
    }));

    console.log("all users : ", allUsers);

    console.log(
      `📋 [Users Fetched] Company ID: ${companyId}, Count: ${allUsers.length}`
    );

    return res.status(200).json({
      success: true,
      data: allUsers,
    });
  } catch (error) {
    console.error("❌ [getUsersByCompany Error]:", error.message);
    return res
      .status(500)
      .json({ message: "Server error while fetching users" });
  }
};

export const getMessagesByRoom = async (req, res) => {
  const db = getDB();
  const messageCollection = db.collection("messages");
  const roomCollection = db.collection("rooms");

  try {
    // Authenticate user
    let token = req.header("Authorization")?.replace("Bearer ", "");
    if (!token && req.headers.cookie) {
      const cookies = cookie.parse(req.headers.cookie);
      token = cookies.token;
    }

    if (!token) {
      console.warn("⚠️ [Validation Failed] No token provided");
      return res
        .status(401)
        .json({ message: "No token provided, authorization denied" });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      console.warn("⚠️ [Validation Failed] Invalid or expired token");
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const userId = decoded.userId;

    // Validate roomId
    const { roomId } = req.query;
    if (!roomId || typeof roomId !== "string" || roomId.trim() === "") {
      console.warn("⚠️ [Validation Failed] Invalid or missing roomId");
      return res
        .status(400)
        .json({
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

    // Fetch messages for the room, sorted by timestamp
    const messages = await messageCollection
      .find({ roomId })
      .sort({ timestamp: 1 })
      .toArray();

    console.log(
      `📋 [Messages Fetched] Room ID: ${roomId}, Count: ${messages.length}`
    );

    // Format messages for frontend
    const formattedMessages = messages.map((msg) => ({
      _id: msg._id.toString(),
      userId: msg.userId ? msg.userId.toString() : "unknown",
      username: msg.username || "Anonymous",
      message: msg.message,
      roomId: msg.roomId,
      companyId: msg.companyId ? msg.companyId.toString() : null,
      timestamp: msg.timestamp.toISOString(),
      updatedAt: msg.updatedAt ? msg.updatedAt.toISOString() : null,
    }));

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
