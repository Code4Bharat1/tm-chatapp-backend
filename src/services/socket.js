import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import cookie from "cookie";
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

  // Socket.IO authentication middleware
  io.use((socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie;
      if (!cookieHeader) {
        console.error("No cookies sent");
        return next(new Error("No cookies sent"));
      }

      const cookies = cookie.parse(cookieHeader);
      const tokens = {
        user: cookies.token,
        admin: cookies.admintoken,
        client: cookies.clientToken,
      };

      let decoded = null;
      let role = null;

      if (tokens.user) {
        decoded = jwt.verify(tokens.user, process.env.JWT_SECRET);
        role = "user";
      } else if (tokens.admin) {
        decoded = jwt.verify(tokens.admin, process.env.JWT_SECRET);
        role = "admin";
      } else if (tokens.client) {
        decoded = jwt.verify(tokens.client, process.env.JWT_SECRET);
        role = "client";
      } else {
        console.error("No valid token found");
        return next(new Error("Authentication token missing"));
      }

      const allowedRoles = [
        "Employee",
        "CEO",
        "Manager",
        "HR",
        "Client",
        "TeamLeader",
      ];

      if (!decoded || !allowedRoles.includes(decoded.position)) {
        console.error("Invalid or unauthorized token");
        return next(
          new Error("Authorization error: Invalid or unauthorized token")
        );
      }

      // Attach decoded payload and role
      socket.user = decoded;
      socket.user.role = role;

      // Assign the proper ID based on role and also normalize to userId for event handlers
      if (role === "admin") {
        const idValue = decoded.adminId || decoded.userId || decoded.id;
        socket.user.adminId = idValue;
        socket.user.userId = idValue; // normalize so downstream code can use userId
      } else if (
        ["Employee", "CEO", "Manager", "HR", "Client", "TeamLeader"].includes(
          decoded.position
        )
      ) {
        const idValue = decoded.userId || decoded.id;
        socket.user.userId = idValue;
      } else if (role === "client") {
        const idValue = decoded.clientId || decoded.userId || decoded.id;
        socket.user.clientId = idValue;
        socket.user.userId = idValue; // normalize so downstream code can use userId
      }

      if (role === "admin") {
        console.log(`👑 [Admin Authenticated] ID: ${socket.user.adminId}`);
      } else if (role === "user") {
        console.log(`✅ [User Authenticated] ID: ${socket.user.userId}`);
      } else if (role === "client") {
        console.log(
          `✅ [Client Authenticated] Role: ${role}, ID: ${socket.user.clientId}`
        );
      } else {
        console.log(
          `⚠️ [Unknown Role] Role: ${role}, ID: ${socket.user.userId}`
        );
      }

      next();
    } catch (error) {
      console.error("❌ [Socket Authentication Error]:", error.message);
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    const db = getDB();
    const roomCollection = db.collection("rooms");
    const userCollection = db.collection("users");
    const employeeCollection = db.collection("admins");
    const clientCollection = db.collection("clients")
    const messageCollection = db.collection("messages");
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
    const companyRoom = `company_${companyId}`;

    socket.join(userId);
    socket.join(companyRoom);
    console.log(`✅ [Socket Connected] User ID: ${userId}`);

    // Emit existing rooms to the connected user
    roomCollection
      .find({ users: userId })
      .toArray()
      .then((userRooms) => {
        userRooms.forEach((room) => {
          rooms.set(room.roomId, {
            roomName: room.roomName,
            users: room.users,
            creator: room.creator,
          });
          socket.join(room.roomId);
          socket.emit("roomCreated", {
            roomId: room.roomId,
            roomName: room.roomName,
            users: room.users,
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
      return (
        [...socket.rooms].find((r) => r.startsWith("room_")) || companyRoom
      );
    }

    function isUserInRoom(roomId) {
      return rooms.get(roomId)?.users.includes(userId);
    }

    async function validateCompanyUsers(userIds) {
      const validUsers = await userCollection
        .find({
          _id: { $in: userIds.map((id) => new ObjectId(id)) },
          companyId: new ObjectId(companyId),
        })
        .toArray();

      const validEmployees = await employeeCollection
        .find({
          _id: { $in: userIds.map((id) => new ObjectId(id)) },
          companyId: new ObjectId(companyId),
        })
        .toArray();
      const validateClient = await clientCollection
        .find({
          _id: { $in: userIds.map((id) => new ObjectId(id)) },
          companyId: new ObjectId(companyId),
        })
        .toArray();

      return [...validUsers, ...validEmployees].map((u) => u._id.toString());
    }

    socket.on("sendMessage", async (message , currentRoom ) => {
      console.log("currentRoom : " , currentRoom)
      const roomId = Array.from(socket.rooms).find((room)=>room.startsWith("room_")) || companyRoom
      console.log("room ID : " , roomId)
      if (roomId !== companyRoom && !isUserInRoom(roomId)) {
        return socket.emit("errorMessage", "Unauthorized room access.");
      }
      try {
        await handleSendMessage(socket, message, currentRoom);
      } catch (err) {
        console.error("❌ [sendMessage Error]:", err.message);
        socket.emit("errorMessage", "Error sending message.");
      }
    });

    socket.on("editMessage", async ({ messageId, newMessage , currentRoom }) => {
      if (roomId !== companyRoom && !isUserInRoom(roomId)) {
        return socket.emit("errorMessage", "Unauthorized edit attempt.");
      }
      try {
        await handleEditMessage(socket, { messageId, newMessage }, currentRoom);
      } catch (err) {
        console.error("❌ [editMessage Error]:", err.message);
        socket.emit("errorMessage", "Error editing message.");
      }
    });

    socket.on("deleteMessage", async (messageId , currentRoom) => {
      const roomId = Array.from(socket.rooms).find((room)=>room.startsWith("room_")) || companyRoom;
      if (roomId !== companyRoom && !isUserInRoom(roomId)) {
        return socket.emit("errorMessage", "Unauthorized delete attempt.");
      }
      try {
        await handleDeleteMessage(socket, messageId, currentRoom);
      } catch (err) {
        console.error("❌ [deleteMessage Error]:", err.message);
        socket.emit("errorMessage", "Error deleting message.");
      }
    });

    socket.on("typing", (currentRoom) => {
      const roomId =currentRoom;
      if (roomId !== companyRoom && !isUserInRoom(roomId)) return;
      socket.to(roomId).emit("userTyping", {
        userId,
        username: socket.user.firstName || "Anonymous",
        roomId,
      });
    });

    socket.on("stopTyping", (currentRoom) => {
      const roomId =currentRoom;
      if (roomId !== companyRoom && !isUserInRoom(roomId)) return;
      socket.to(roomId).emit("userStoppedTyping", {
        userId,
        roomId,
      });
    });

    socket.on("createRoom", async ({ roomName, userIds }) => {
      if (
        !roomName?.trim() ||
        !Array.isArray(userIds) ||
        userIds.length === 0
      ) {
        return socket.emit("errorMessage", "Invalid room name or users.");
      }

      console.log("user IDs : ", userIds)

      const validUserIds = await validateCompanyUsers(userIds);
      if (validUserIds.length !== userIds.length) {
        return socket.emit(
          "errorMessage",
          "Users must belong to your company."
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
        io.to(uid).emit("roomCreated", {
          roomId,
          roomName,
          users: allUserIds,
          creator: userId,
        });
      });

      io.sockets.sockets.forEach((client) => {
        if (allUserIds.includes(client.user?.userId)) client.join(roomId);
      });

      const systemMsg = {
        _id: new ObjectId().toString(),
        message: `Room "${roomName}" has been created!`,
        userId: "system",
        username: "System",
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
    });

    socket.on("joinRoom", (roomId) => {
      const room = rooms.get(roomId);
      if (!room || !room.users.includes(userId)) {
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
        users: onlineUsers,
      });
      socket.to(roomId).emit("userJoined", {
        user: { userId, username: socket.user.firstName || "Anonymous" },
        roomId,
      });
      io.to(roomId).emit("onlineUsersUpdate", { users: onlineUsers, roomId });
    });

    socket.on("leaveRoom", async (roomId) => {
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
        io.to(roomId).emit("onlineUsersUpdate", { users: onlineUsers, roomId });
      }
    });

    socket.on("deleteRoom", (data) => {
      handleDeleteRoom(socket, data);
      onlineUsersByRoom.delete(data.roomId);
    });

    socket.on("disconnect", () => {
      console.log(`❌ [Disconnected] ${userId}`);
      onlineUsersByRoom.forEach((users, roomId) => {
        if (users.has(userId)) {
          users.delete(userId);
          const onlineUsers = [...users.values()];
          io.to(roomId).emit("onlineUsersUpdate", {
            users: onlineUsers,
            roomId,
          });
        }
      });
    });
  });

  return io;
};
