import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import {
  handleSendMessage,
  handleDeleteMessage,
  handleEditMessage,
  handleLeaveRoom,
  handleDeleteRoom,
} from "../controller/message.controller.js";
import { getDB } from "./db.js";
import { ObjectId } from "mongodb";

dotenv.config();

// In-memory store for rooms (supplemented by database in production)
const rooms = new Map(); // Map<roomId, { roomName: string, users: string[], creator: string }>
const onlineUsersByRoom = new Map(); // Map<roomId, Map<userId, { userId: string, username: string }>>

export const initializeSocket = (server, allowedOrigins) => {
  const io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST", "PUT", "DELETE"],
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      // Validate environment variable
      if (!process.env.JWT_SECRET) {
        console.error(`[Socket ${socket.id}] JWT_SECRET not set`);
        return next(new Error("Server configuration error"));
      }

      // Check for Authorization header
      const authHeader = socket.handshake.headers.authorization;
      // console.log(`[Socket ${socket.id}] Authorization header:`, authHeader);
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        console.error(`[Socket ${socket.id}] No valid Authorization header found`);
        return next(new Error("No token provided in Authorization header"));
      }

      // Extract token
      const token = authHeader.split(' ')[1];

      // console.log(token)

      // Verify token
      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
      } catch (error) {
        console.error(`[Socket ${socket.id}] Token verification error: ${error.message}`);
        return next(new Error(
          error.name === "TokenExpiredError"
            ? "Token expired"
            : "Invalid token"
        ));
      }

      // Extract and validate ID
      const idKey = decoded.id || decoded.userId || decoded.clientId || decoded.adminId;
      if (!idKey) {
        console.error(`[Socket ${socket.id}] Invalid token structure`, decoded);
        return next(new Error("Invalid token structure, ID not found"));
      }

      let userId;
      try {
        userId = new ObjectId(idKey);
      } catch (err) {
        console.error(`[Socket ${socket.id}] Invalid ObjectId: ${idKey}`);
        return next(new Error("Invalid user ID format"));
      }

      // Map position to role
      let role = decoded.position;
      const position = decoded.position?.toLowerCase();
      if (["employee", "manager", "hr"].includes(position)) {
        role = "user";
      } else if (position === "admin") {
        role = "admin";
      }

      // Validate role
      if (!['user', 'admin', 'Client'].includes(role)) {
        console.error(`[Socket ${socket.id}] Invalid role in token payload: ${role}`);
        return next(new Error("Invalid role in token, authorization denied"));
      }

      // Access database
      const db = getDB();
      const collectionMap = {
        user: db.collection("users"),
        admin: db.collection("admins"),
        Client: db.collection("clients"),
      };

      const collection = collectionMap[role];
      if (!collection) {
        console.error(`[Socket ${socket.id}] Invalid role: ${role}`);
        return next(new Error("Invalid role, authorization denied"));
      }

      // Fetch user
      const projection = {
        position: 1,
        firstName: 1,
        fullName: 1,
        name: 1,
        companyId: 1,
        email: 1,
      };

      const user = await collection.findOne({ _id: userId }, { projection });
      if (!user) {
        console.warn(
          `[Socket ${socket.id}] User not found: ID=${userId}, Role=${role}`
        );
        return next(new Error("User not found, authorization denied"));
      }

      // Validate position
      const normalizedPosition = (
        user.position || decoded.position
      )?.toLowerCase();
      const allowedRoles = [
        "employee",
        "ceo",
        "manager",
        "hr",
        "client",
        "teamleader",
        "admin",
      ];
      if (!normalizedPosition || !allowedRoles.includes(normalizedPosition)) {
        console.error(
          `[Socket ${socket.id}] Invalid position: ${normalizedPosition}`
        );
        return next(
          new Error("Authorization error: Invalid or unauthorized role")
        );
      }

      // Initialize socket.user
      socket.user = {
        userId: idKey.toString(),
        email: user.email || decoded.email || null,
        companyId: user.companyId?.toString() || decoded.companyId || null,
        position: normalizedPosition,
        firstName:
          user.firstName ||
          user.name ||
          user.fullName ||
          decoded.firstName ||
          null,
        companyName: decoded.companyName || null,
        role,
      };

      // Normalize IDs
      if (role === "admin") socket.user.adminId = idKey.toString();
      if (role === "client") socket.user.clientId = idKey.toString();

      console.log(
        `[Socket ${socket.id}] Authenticated: Role=${role}, ID=${idKey}, Position=${normalizedPosition}`
      );
      next();
    } catch (error) {
      console.error(
        `[Socket ${socket.id}] Authentication Error: ${error.name} - ${error.message}`
      );
      next(new Error(`Authentication error: ${error.message}`));
    }
  });

  io.on("connection", (socket) => {
    // console.log(`[DEBUG] New socket connection: id=${socket.id}, user=`, socket.user);
    const db = getDB();
    const roomCollection = db.collection("rooms");
    const userCollection = db.collection("users");
    const employeeCollection = db.collection("admins");
    const clientCollection = db.collection("clients");
    const messageCollection = db.collection("messages");
    const companyCollection = db.collection("companies");

    let userId = null;
    if (socket.user.role === "user") {
      userId = socket.user.userId;
    } else if (socket.user.role === "admin") {
      userId = socket.user.adminId;
    } else if (socket.user.role === "client") {
      userId = socket.user.clientId;
    } else {
      console.log("Null");
    }
    const companyId = socket.user.companyId;

    // Join user's personal room for direct notifications
    socket.join(userId);
    console.log(`✅ [Socket Connected] User ID: ${userId}`);

    // Emit existing rooms to the connected user, excluding any default company chat
    roomCollection
      .find({ users: userId })
      .toArray()
      .then((userRooms) => {
        console.log(`[DEBUG] Fetched rooms for user ${userId}:`, userRooms.map(r => ({ roomId: r.roomId, roomName: r.roomName })));
        userRooms.forEach((room) => {
          // Skip rooms that resemble a default company chat
          if (room.roomName === `Company ${companyId} Chat`) {
            console.warn(`[Socket ${socket.id}] Skipping default room: ${room.roomName}`);
            return;
          }
          rooms.set(room.roomId, {
            roomName: room.roomName,
            users: room.users,
            creator: room.creator,
          });
          socket.join(room.roomId);
          socket.emit("roomCreated", {
            roomId: room.roomId,
            roomName: room.roomName,
            users: socket.user.role === "client" ? [] : room.users,
            creator: room.creator,
          });
          console.log(`📤 [Room Emitted] ${room.roomId} for ${userId}`);
        });
      })
      .catch((err) => {
        console.error("❌ [Fetch Rooms Error]:", err.message);
        socket.emit("errorMessage", "Failed to load rooms.");
      });

    function getActiveRoom() {
      const userRooms = [...socket.rooms].filter((r) => r.startsWith("room_"));
      if (userRooms.length === 0) {
        console.warn(`[Socket ${socket.id}] No active rooms found for user ${userId}`);
        return null;
      }
      return userRooms[0];
    }

    function isUserInRoom(roomId) {
      return rooms.get(roomId)?.users.includes(userId);
    }

    async function validateCompanyUsers(userIds) {
      console.log("Validating user IDs:", userIds, "for companyId:", companyId);
      const validObjectIds = userIds
        .filter((id) => typeof id === "string" && ObjectId.isValid(id))
        .map((id) => new ObjectId(id));

      if (validObjectIds.length !== userIds.length) {
        console.error("Some user IDs are invalid:", {
          invalidUserIds: userIds.filter(
            (id) => !ObjectId.isValid(id) || typeof id !== "string"
          ),
        });
        return [];
      }

      const validUsers = await userCollection
        .find({
          _id: { $in: validObjectIds },
          companyId: new ObjectId(companyId),
        })
        .toArray();
      console.log(
        "Valid users from database:",
        validUsers.map((u) => u._id.toString())
      );

      const validEmployees = await employeeCollection
        .find({
          _id: { $in: validObjectIds },
          companyId: new ObjectId(companyId),
        })
        .toArray();
      console.log(
        "Valid employees from database:",
        validEmployees.map((u) => u._id.toString())
      );

      const validClients = await clientCollection
        .find({
          _id: { $in: validObjectIds },
          companyId: new ObjectId(companyId),
        })
        .toArray();
      console.log(
        "Valid clients from database:",
        validClients.map((u) => u._id.toString())
      );

      const validUserIds = [
        ...validUsers,
        ...validEmployees,
        ...validClients,
      ].map((u) => u._id.toString());

      console.log("All valid user IDs:", validUserIds);
      return validUserIds;
    }

    socket.on("createRoom", async ({ roomName, userIds }) => {
      // console.log(`[DEBUG] createRoom event: userId=${userId}, roomName=${roomName}, userIds=`, userIds);
      if (
        !roomName?.trim() ||
        !Array.isArray(userIds) ||
        userIds.length === 0
      ) {
        console.error("Invalid room name or users:", { roomName, userIds });
        return socket.emit("errorMessage", "Invalid room name or users.");
      }

      // Prevent creation of rooms with default company chat name
      if (roomName.trim() === `Company ${companyId} Chat`) {
        console.error(`[Socket ${socket.id}] Attempt to create restricted room name: ${roomName}`);
        return socket.emit("errorMessage", "Room name is reserved and cannot be used.");
      }

      const validUserIds = await validateCompanyUsers(userIds);
      console.log("Validation result:", {
        inputUserIds: userIds,
        validUserIds,
      });

      const invalidUserIds = userIds.filter((id) => !validUserIds.includes(id));
      if (invalidUserIds.length > 0) {
        console.error(
          "Validation failed: Some users do not belong to company",
          { invalidUserIds }
        );
        return socket.emit(
          "errorMessage",
          "Some users do not belong to your company."
        );
      }

      const roomId = `room_${Date.now()}_${Math.random()
        .toString(36)
        .substr(2, 9)}`;
      const allUserIds = [...new Set([userId, ...userIds])];

      await roomCollection.insertOne({
        roomId,
        roomName: roomName.trim(),
        users: allUserIds,
        creator: userId,
        companyId,
        createdAt: new Date(),
      });

      rooms.set(roomId, {
        roomName: roomName.trim(),
        users: allUserIds,
        creator: userId,
      });
      socket.join(roomId);

      allUserIds.forEach((uid) => {
        const targetSocket = Array.from(io.sockets.sockets.values()).find(
          (s) => s.user?.userId === uid
        );
        if (targetSocket) {
          io.to(targetSocket.id).emit("roomCreated", {
            roomId,
            roomName,
            users: targetSocket.user.role === "client" ? [] : allUserIds,
            creator: userId,
          });
          console.log(
            `📤 [roomCreated Emitted] to user ${uid} (role=${targetSocket.user.role})`
          );
        }
      });

      for (const [socketId, client] of io.sockets.sockets) {
        if (allUserIds.includes(client.user?.userId)) {
          client.join(roomId);
        }
      }

      const systemMsg = {
        _id: new ObjectId().toString(),
        message: `Room "${roomName}" has been created!`,
        userId: "system",
        username: "System",
        companyName: "System",
        roomId,
        companyId,
        timestamp: new Date().toISOString(),
      };

      await messageCollection.insertOne({
        ...systemMsg,
        companyId: new ObjectId(companyId),
        timestamp: new Date(systemMsg.timestamp),
      });
      io.to(roomId).emit("newMessage", systemMsg);

      console.log(`Room Created: roomId=${roomId}, users=`, allUserIds);
    });

    socket.on("sendMessage", async (message, currentRoom) => {
      // console.log(`[DEBUG] sendMessage event: userId=${userId}, currentRoom=${currentRoom}, message=`, message);
      if (!currentRoom) {
        console.error(`[Socket ${socket.id}] No room specified for message`);
        return socket.emit("errorMessage", "No room specified.");
      }

      if (!isUserInRoom(currentRoom)) {
        console.error(
          `Unauthorized room access: userId=${userId}, roomId=${currentRoom}`
        );
        return socket.emit("errorMessage", "Unauthorized room access.");
      }

      try {
        const savedMessage = await handleSendMessage(socket, message, currentRoom);
        if (!savedMessage) {
          throw new Error("handleSendMessage returned no message");
        }

        const baseMessage = {
          _id: savedMessage._id,
          userId: savedMessage.userId,
          username: savedMessage.username,
          message: savedMessage.message,
          roomId: savedMessage.roomId,
          companyId: savedMessage.companyId.toString(),
          timestamp: savedMessage.timestamp,
          companyName: savedMessage.companyName,
        };
        const clientMessage = {
          ...baseMessage,
          username:
            socket.user.role === "client"
              ? savedMessage.username
              : savedMessage.companyName,
        };

        console.log(
          `Emitting newMessage for roomId=${currentRoom}, sender userId=${userId}, role=${socket.user.role}`
        );
        for (const socketId of io.sockets.adapter.rooms.get(currentRoom) || []) {
          const client = io.sockets.sockets.get(socketId);
          if (client) {
            const messageToEmit =
              client.user.role === "client" ? clientMessage : baseMessage;
            client.emit("newMessage", messageToEmit);
            console.log(
              `Emitted newMessage to socket ${socketId} (role=${client.user.role}): username=${messageToEmit.username}`
            );
          }
        }
      } catch (err) {
        console.error("❌ [sendMessage Error]:", err.message);
        socket.emit("errorMessage", "Error sending message.");
      }
    });

    socket.on("editMessage", async ({ messageId, newMessage, currentRoom }) => {
      // console.log(`[DEBUG] editMessage event: userId=${userId}, messageId=${messageId}, newMessage=${newMessage}, currentRoom=${currentRoom}`);
      if (!currentRoom) {
        console.error(`[Socket ${socket.id}] No room specified for edit`);
        return socket.emit("errorMessage", "No room specified.");
      }

      if (!isUserInRoom(currentRoom)) {
        console.error(
          `Unauthorized edit attempt: userId=${userId}, roomId=${currentRoom}`
        );
        return socket.emit("errorMessage", "Unauthorized edit attempt.");
      }
      try {
        await handleEditMessage(socket, { messageId, newMessage }, currentRoom);
      } catch (err) {
        console.error("❌ [editMessage Error]:", err.message);
        socket.emit("errorMessage", "Error editing message.");
      }
    });

    socket.on("deleteMessage", async (messageId, currentRoom) => {
      // console.log(`[DEBUG] deleteMessage event: userId=${userId}, messageId=${messageId}, currentRoom=${currentRoom}`);
      if (!currentRoom) {
        console.error(`[Socket ${socket.id}] No room specified for delete`);
        return socket.emit("errorMessage", "No room specified.");
      }

      if (!isUserInRoom(currentRoom)) {
        console.error(
          `Unauthorized delete attempt: userId=${userId}, roomId=${currentRoom}`
        );
        return socket.emit("errorMessage", "Unauthorized delete attempt.");
      }
      try {
        await handleDeleteMessage(socket, messageId, currentRoom);
      } catch (err) {
        console.error("❌ [deleteMessage Error]:", err.message);
        socket.emit("errorMessage", "Error deleting message.");
      }
    });

    socket.on("typing", ({ roomId, userId }) => {
      // console.log(`[DEBUG] typing event: userId=${userId}, roomId=${roomId}`);
      if (!socket.user || socket.user.userId !== userId) {
        console.warn(
          `Unauthorized typing attempt: userId=${userId}, socket.user=`,
          socket.user
        );
        return;
      }

      if (!roomId || !isUserInRoom(roomId)) {
        console.warn(
          `Invalid or unauthorized room: roomId=${roomId}, userId=${userId}`
        );
        return;
      }

      for (const socketId of io.sockets.adapter.rooms.get(roomId) || []) {
        if (socketId !== socket.id) {
          const client = io.sockets.sockets.get(socketId);
          if (client && client.user.role !== "client") {
            client.emit("userTyping", {
              userId: socket.user.userId,
              username: socket.user.firstName || "Anonymous",
              roomId,
            });
          }
        }
      }
    });

    socket.on("stopTyping", ({ roomId, userId }) => {
      // console.log(`[DEBUG] stopTyping event: userId=${userId}, roomId=${roomId}`);
      if (!socket.user || socket.user.userId !== userId) {
        console.warn(
          `Unauthorized stopTyping attempt: userId=${userId}, socket.user=`,
          socket.user
        );
        return;
      }

      if (!roomId || !isUserInRoom(roomId)) {
        console.warn(
          `Invalid or unauthorized room: roomId=${roomId}, userId=${userId}`
        );
        return;
      }

      socket.to(roomId).emit("userStoppedTyping", {
        userId: socket.user.userId,
        roomId,
      });
      console.log(
        `📤 [userStoppedTyping Emitted] to room ${roomId}, userId=${userId}`
      );
    });

    socket.on("joinRoom", (roomId) => {
      // console.log(`[DEBUG] joinRoom event: userId=${userId}, roomId=${roomId}`);
      const room = rooms.get(roomId);
      if (!room || !room.users.includes(userId)) {
        console.error(
          `Join Room Failed: userId=${userId}, roomId=${roomId}, roomUsers=`,
          room?.users
        );
        return socket.emit(
          "errorMessage",
          "Unauthorized or non-existent room."
        );
      }

      socket.join(roomId);
      if (!onlineUsersByRoom.has(roomId)) {
        onlineUsersByRoom.set(roomId, new Map());
      }

      onlineUsersByRoom.get(roomId).set(userId, {
        userId,
        username: socket.user.firstName || "Anonymous",
      });

      const onlineUsers = [...onlineUsersByRoom.get(roomId).values()];
      socket.emit("joinConfirmation", {
        room: roomId,
        roomName: room.roomName,
        users: socket.user.role === "client" ? [] : onlineUsers,
      });

      for (const socketId of io.sockets.adapter.rooms.get(roomId) || []) {
        const client = io.sockets.sockets.get(socketId);
        if (
          client &&
          client.user.role !== "client" &&
          client.user.userId !== userId
        ) {
          client.emit("userJoined", {
            user: { userId, username: socket.user.firstName || "Anonymous" },
            roomId: roomId,
          });
          console.log(
            `📤 [userJoined Emitted] to socket ${socketId} (role=${client.user.role})`
          );
        }
      }

      for (const socketId of io.sockets.adapter.rooms.get(roomId) || []) {
        const client = io.sockets.sockets.get(socketId);
        if (client) {
          if (client.user.role === "client") {
            client.emit("onlineUsersUpdate", {
              userCount: onlineUsers.length,
              roomId,
            });
          } else {
            client.emit("onlineUsersUpdate", {
              users: onlineUsers,
              roomId,
            });
          }
        }
      }
    });

    socket.on("leaveRoom", async (roomId) => {
      // console.log(`[DEBUG] leaveRoom event: userId=${userId}, roomId=${roomId}`);
      await handleLeaveRoom(socket, roomId);
      const room = await roomCollection.findOne({ roomId });
      if (room) {
        rooms.set(roomId, {
          roomName: room.roomName,
          users: room.users,
          creator: room.creator,
        });
      } else {
        rooms.delete(roomId);
        onlineUsersByRoom.delete(roomId);
      }

      if (onlineUsersByRoom.has(roomId)) {
        onlineUsersByRoom.get(roomId).delete(userId);
        const onlineUsers = [...onlineUsersByRoom.get(roomId).values()];
        for (const socketId of io.sockets.adapter.rooms.get(roomId) || []) {
          const client = io.sockets.sockets.get(socketId);
          if (client) {
            if (client.user.role === "client") {
              client.emit("onlineUsersUpdate", {
                userCount: onlineUsers.length,
                roomId,
              });
            } else {
              client.emit("onlineUsersUpdate", {
                users: onlineUsers,
                roomId,
              });
            }
          }
        }
      }
    });

    socket.on("deleteRoom", (data) => {
      // console.log(`[DEBUG] deleteRoom event: userId=${userId}, data=`, data);
      handleDeleteRoom(socket, data);
      onlineUsersByRoom.delete(data.roomId);
    });

    socket.on("disconnect", () => {
      // console.log(`[DEBUG] disconnect event: userId=${userId}, socketId=${socket.id}`);
      console.log(`❌ [Disconnected] ${userId}`);
      onlineUsersByRoom.forEach((users, roomId) => {
        if (users.has(userId)) {
          users.delete(userId);
          const onlineUsers = [...users.values()];
          for (const socketId of io.sockets.adapter.rooms.get(roomId) || []) {
            const client = io.sockets.sockets.get(socketId);
            if (client) {
              if (client.user.role === "client") {
                client.emit("onlineUsersUpdate", {
                  userCount: onlineUsers.length,
                  roomId,
                });
              } else {
                client.emit("onlineUsersUpdate", {
                  users: onlineUsers,
                  roomId,
                });
              }
            }
          }
        }
      });
    });
  });

  return io;
};