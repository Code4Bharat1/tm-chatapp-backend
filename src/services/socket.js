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
      const token = cookies.token;
      if (!token) {
        console.error("Token missing");
        return next(new Error("Token missing"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (!decoded) {
        console.error("Invalid token");
        return next(new Error("Invalid token"));
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
        console.error("Insufficient position permissions");
        return next(
          new Error("Authorization error: Insufficient position permissions")
        );
      }

      socket.user = decoded;
      console.log("Authenticated user:", socket.user);
      next();
    } catch (error) {
      console.error("Socket authentication error:", error.message);
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", (socket) => {
    const companyRoom = `company_${socket.user.companyId}`;
    socket.join(companyRoom);
    console.log(`✅ [Socket Connected] User ID: ${socket.user.userId}`);

    // Fetch and emit rooms the user is part of on connection
    const db = getDB();
    const roomCollection = db.collection("rooms");
    roomCollection
      .find({ users: socket.user.userId })
      .toArray()
      .then((userRooms) => {
        userRooms.forEach((room) => {
          // Update in-memory rooms
          rooms.set(room.roomId, {
            roomName: room.roomName,
            users: room.users,
            creator: room.creator,
          });
          // Emit roomCreated to the user
          socket.emit("roomCreated", {
            roomId: room.roomId,
            roomName: room.roomName,
            users: room.users,
            creator: room.creator,
          });
          console.log(
            `📤 [Room Emitted on Connect] roomId=${room.roomId}, userId=${socket.user.userId}`
          );
        });
      })
      .catch((error) => {
        console.error("❌ [Fetch Rooms Error]:", error.message);
        socket.emit(
          "errorMessage",
          "Failed to load rooms. Please try again later."
        );
      });

    socket.on("sendMessage", async (message) => {
      console.log(
        `📥 [Message Received] From ${socket.user.userId}: "${message}"`
      );
      try {
        const targetRoom =
          Array.from(socket.rooms).find((room) => room.startsWith("room_")) ||
          companyRoom;

        if (
          targetRoom !== companyRoom &&
          !rooms.get(targetRoom)?.users.includes(socket.user.userId)
        ) {
          console.error(
            `User ${socket.user.userId} not authorized to send message to room ${targetRoom}`
          );
          return socket.emit(
            "errorMessage",
            "You are not authorized to send messages to this room."
          );
        }

        await handleSendMessage(socket, message, targetRoom);
      } catch (error) {
        console.error("❌ [sendMessage Error]:", error.message);
        socket.emit(
          "errorMessage",
          "An unexpected error occurred while sending message."
        );
      }
    });

    socket.on("editMessage", async ({ messageId, newMessage }) => {
      console.log(
        `📥 [Edit Request] From ${socket.user.userId}: messageId=${messageId}, newMessage="${newMessage}"`
      );
      try {
        const targetRoom =
          Array.from(socket.rooms).find((room) => room.startsWith("room_")) ||
          companyRoom;

        if (
          targetRoom !== companyRoom &&
          !rooms.get(targetRoom)?.users.includes(socket.user.userId)
        ) {
          console.error(
            `User ${socket.user.userId} not authorized to edit message in room ${targetRoom}`
          );
          return socket.emit(
            "errorMessage",
            "You are not authorized to edit messages in this room."
          );
        }

        await handleEditMessage(socket, { messageId, newMessage }, targetRoom);
      } catch (error) {
        console.error("❌ [Edit Message Error]:", error.message);
        socket.emit(
          "errorMessage",
          "An unexpected error occurred while editing message."
        );
      }
    });

    socket.on("deleteMessage", async (messageId) => {
      console.log(
        `📥 [Delete Request] From ${socket.user.userId}: "${messageId}"`
      );
      try {
        const targetRoom =
          Array.from(socket.rooms).find((room) => room.startsWith("room_")) ||
          companyRoom;

        if (
          targetRoom !== companyRoom &&
          !rooms.get(targetRoom)?.users.includes(socket.user.userId)
        ) {
          console.error(
            `User ${socket.user.userId} not authorized to delete message in room ${targetRoom}`
          );
          return socket.emit(
            "errorMessage",
            "You are not authorized to delete messages in this room."
          );
        }

        await handleDeleteMessage(socket, messageId, targetRoom);
      } catch (error) {
        console.error("❌ [Delete Message Error]:", error.message);
        socket.emit(
          "errorMessage",
          "An unexpected error occurred while deleting message."
        );
      }
    });

    socket.on("typing", () => {
      const targetRoom =
        Array.from(socket.rooms).find((room) => room.startsWith("room_")) ||
        companyRoom;
      console.log(
        `✍️ [Typing] ${socket.user.userId} is typing in ${targetRoom}`
      );
      if (
        targetRoom !== companyRoom &&
        !rooms.get(targetRoom)?.users.includes(socket.user.userId)
      ) {
        console.error(
          `User ${socket.user.userId} not authorized to send typing event to room ${targetRoom}`
        );
        return socket.emit(
          "errorMessage",
          "You are not authorized to send typing events to this room."
        );
      }
      socket.to(targetRoom).emit("userTyping", {
        userId: socket.user.userId,
        username: socket.user.firstName || "Anonymous",
        roomId: targetRoom,
      });
    });

    socket.on("stopTyping", () => {
      const targetRoom =
        Array.from(socket.rooms).find((room) => room.startsWith("room_")) ||
        companyRoom;
      console.log(`✋ [Stopped Typing] ${socket.user.userId} in ${targetRoom}`);
      if (
        targetRoom !== companyRoom &&
        !rooms.get(targetRoom)?.users.includes(socket.user.userId)
      ) {
        console.error(
          `User ${socket.user.userId} not authorized to send stopTyping event to room ${targetRoom}`
        );
        return socket.emit(
          "errorMessage",
          "You are not authorized to send stopTyping events to this room."
        );
      }
      socket.to(targetRoom).emit("userStoppedTyping", {
        userId: socket.user.userId,
        roomId: targetRoom,
      });
    });

    socket.on("createRoom", async ({ roomName, userIds }) => {
      console.log(
        `📥 [Create Room Request] From ${socket.user.userId}: roomName="${roomName}", userIds=${userIds}`
      );
      try {
        // Validate input
        if (!roomName || typeof roomName !== "string" || !roomName.trim()) {
          console.error("Invalid room name");
          return socket.emit(
            "errorMessage",
            "Room name is required and must be a non-empty string."
          );
        }
        if (!Array.isArray(userIds) || userIds.length === 0) {
          console.error("No users provided for room");
          return socket.emit(
            "errorMessage",
            "At least one user must be selected for the room."
          );
        }

        // Validate that all userIds belong to the same company
        const db = getDB();
        const userCollection = db.collection("users");
        const employeeCollection = db.collection("admins");
        const roomCollection = db.collection("rooms");
        const messageCollection = db.collection("messages");
        const validUsers = await userCollection
          .find({
            _id: { $in: userIds.map((id) => new ObjectId(id)) },
            companyId: new ObjectId(socket.user.companyId),
          })
          .toArray();
        const validEmployees = await employeeCollection
          .find({
            _id: { $in: userIds.map((id) => new ObjectId(id)) },
            companyId: new ObjectId(socket.user.companyId),
          })
          .toArray();
        console.log("validated users: ", validUsers);
        const allValidUserIds = [...validUsers, ...validEmployees].map((u) =>
          u._id.toString()
        );
        if (allValidUserIds.length !== userIds.length) {
          console.error("Some users are not in the same company");
          return socket.emit(
            "errorMessage",
            "Some users are not in your company."
          );
        }

        // Generate a unique room ID
        const roomId = `room_${Date.now()}_${Math.random()
          .toString(36)
          .substr(2, 9)}`;

        // Ensure the creator is included in the room
        const allUserIds = [...new Set([socket.user.userId, ...userIds])];

        // Store room details in database
        await roomCollection.insertOne({
          roomId,
          roomName: roomName.trim(),
          users: allUserIds,
          creator: socket.user.userId,
          companyId: socket.user.companyId,
          createdAt: new Date(),
        });

        // Store room details in-memory
        rooms.set(roomId, {
          roomName: roomName.trim(),
          users: allUserIds,
          creator: socket.user.userId,
        });

        // Join the creator to the room
        socket.join(roomId);
        console.log(
          `✅ [Room Created] roomId=${roomId}, name="${roomName}", users=${allUserIds}`
        );

        // Notify all users about the room creation
        allUserIds.forEach((userId) => {
          io.to(userId).emit("roomCreated", {
            roomId,
            roomName,
            users: allUserIds,
            creator: socket.user.userId,
          });
          console.log(
            `📤 [roomCreated Emitted] to userId=${userId}, roomId=${roomId}`
          );
        });

        // Join all online users to the room
        io.sockets.sockets.forEach((client) => {
          if (allUserIds.includes(client.user?.userId)) {
            client.join(roomId);
            console.log(
              `✅ [User Joined Room] userId=${client.user.userId}, roomId=${roomId}`
            );
          }
        });

        // Send a system message to the room
        const systemMessage = {
          _id: new ObjectId().toString(),
          message: `Room "${roomName}" has been created! Join now.`,
          userId: "system",
          username: "System",
          roomId,
          companyId: socket.user.companyId,
          timestamp: new Date().toISOString(),
        };

        // Save the system message to the database
        await messageCollection.insertOne({
          _id: new ObjectId(systemMessage._id),
          message: systemMessage.message,
          userId: systemMessage.userId,
          username: systemMessage.username,
          roomId: systemMessage.roomId,
          companyId: new ObjectId(socket.user.companyId),
          timestamp: new Date(systemMessage.timestamp),
        });

        // Broadcast the system message to the room
        io.to(roomId).emit("newMessage", systemMessage);
        console.log(
          `📤 [System Message Sent] roomId=${roomId}, message="${systemMessage.message}"`
        );
      } catch (error) {
        console.error("❌ [Create Room Error]:", error.message);
        socket.emit(
          "errorMessage",
          "An unexpected error occurred while creating room."
        );
      }
    });

    socket.on("joinRoom", (roomId) => {
      console.log(
        `📥 [Join Room Request] From ${socket.user.userId}: roomId=${roomId}`
      );
      try {
        const room = rooms.get(roomId);
        if (!room) {
          console.error(`Room not found: ${roomId}`);
          return socket.emit("errorMessage", "Room not found.");
        }
        if (!room.users.includes(socket.user.userId)) {
          console.error(
            `User ${socket.user.userId} not authorized to join room ${roomId}`
          );
          return socket.emit(
            "errorMessage",
            "You are not authorized to join this room."
          );
        }
        socket.join(roomId);

        // Initialize onlineUsers for the room if not exists
        if (!onlineUsersByRoom.has(roomId)) {
          onlineUsersByRoom.set(roomId, new Map());
        }

        // Add user to onlineUsers
        onlineUsersByRoom.get(roomId).set(socket.user.userId, {
          userId: socket.user.userId,
          username: socket.user.firstName || "Anonymous",
        });

        // Get unique online users
        const onlineUsers = Array.from(onlineUsersByRoom.get(roomId).values());

        console.log(
          `✅ [User Joined Room] userId=${socket.user.userId}, roomId=${roomId}, onlineUsers=`,
          onlineUsers
        );

        // Emit joinConfirmation to the joining client
        socket.emit("joinConfirmation", {
          room: roomId,
          roomName: room.roomName,
          users: onlineUsers,
        });

        // Emit userJoined to other clients
        socket.to(roomId).emit("userJoined", {
          user: {
            userId: socket.user.userId,
            username: socket.user.firstName || "Anonymous",
          },
          roomId,
        });

        // Emit onlineUsersUpdate to all clients in the room
        io.to(roomId).emit("onlineUsersUpdate", {
          users: onlineUsers,
          roomId,
        });
      } catch (error) {
        console.error("❌ [Join Room Error]:", error.message);
        socket.emit(
          "errorMessage",
          "An unexpected error occurred while joining room."
        );
      }
    });

    socket.on("leaveRoom", async (roomId) => {
      console.log(
        `📥 [Leave Room Request] From ${socket.user.userId}: roomId=${roomId}`
      );
      try {
        await handleLeaveRoom(socket, roomId);

        // Update in-memory rooms Map after successful database update
        const room = await roomCollection.findOne({ roomId });
        if (room) {
          rooms.set(roomId, {
            roomName: room.roomName,
            users: room.users,
            creator: room.creator,
          });
        } else {
          rooms.delete(roomId);
          onlineUsersByRoom.delete(roomId); // Clean up online users
        }

        // Remove user from onlineUsers
        if (onlineUsersByRoom.has(roomId)) {
          onlineUsersByRoom.get(roomId).delete(socket.user.userId);
          const onlineUsers = Array.from(
            onlineUsersByRoom.get(roomId).values()
          );
          io.to(roomId).emit("onlineUsersUpdate", {
            users: onlineUsers,
            roomId,
          });
          console.log(
            `📤 [onlineUsersUpdate after leave] roomId=${roomId}, users=`,
            onlineUsers
          );
        }
      } catch (error) {
        console.error("❌ [Leave Room Error]:", error.message);
        socket.emit(
          "errorMessage",
          "An unexpected error occurred while leaving room."
        );
      }
    });

    socket.on("deleteRoom", (data) => {
      handleDeleteRoom(socket, data);
      // Clean up onlineUsersByRoom
      if (onlineUsersByRoom.has(data.roomId)) {
        onlineUsersByRoom.delete(data.roomId);
      }
    });

    socket.on("disconnect", () => {
      console.log(`❌ [Socket Disconnected] User ID: ${socket.user.userId}`);
      // Remove user from all rooms' onlineUsers
      onlineUsersByRoom.forEach((users, roomId) => {
        if (users.has(socket.user.userId)) {
          users.delete(socket.user.userId);
          const onlineUsers = Array.from(users.values());
          io.to(roomId).emit("onlineUsersUpdate", {
            users: onlineUsers,
            roomId,
          });
          console.log(
            `📤 [onlineUsersUpdate on disconnect] roomId=${roomId}, users=`,
            onlineUsers
          );
        }
      });
    });
  });

  return io;
};
