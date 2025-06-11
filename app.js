// server.js
import express from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { connectDB } from "./src/services/db.js";
import cors from "cors";
import companyChat from "./src/route/company.chat.route.js";
import { initializeSocket } from "./src/services/socket.js";
import http from "http";

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 8080; // Use 8080 as default
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "https://task-tracker.code4bharat.com",
  "https://task-tracker-admin.code4bharat.com",
  "https://task-tracker-superadmin.code4bharat.com",
  "https://www.task-tracker.code4bharat.com",
  "https://www.task-tracker-admin.code4bharat.com",
  "https://www.task-tracker-superadmin.code4bharat.com",
]; // Match client origin

// Middleware
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// Routes
app.use("/api", companyChat);

app.get("/", (req, res) => {
  res.send("api is running");
});

// Initialize Socket.IO
const io = initializeSocket(server, allowedOrigins);

// Set io for use in routes if needed
app.set("io", io);

// Start server after DB connection
async function startServer() {
  try {
    await connectDB();
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

startServer();
