import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { getDB } from "../services/db.js";

// Middleware to check logged-in user for group chat
export const checkGroupChatAuth = async (req, res, next) => {
  const db = getDB();
  const userCollection = db.collection("users");
  const employeeCollection = db.collection("employees"); // Second collection

  try {
    // Get token from Authorization header
    const token = req.header("Authorization")?.replace("Bearer ", "");

    if (!token) {
      return res
        .status(401)
        .json({ message: "No token provided, authorization denied" });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Convert userId to ObjectId
    let userId;
    try {
      userId = new ObjectId(decoded.userId);
    } catch (error) {
      return res
        .status(401)
        .json({ message: "Invalid user ID format in token" });
    }

    // Search for user in both collections
    const userFromUsers = await userCollection.findOne(
      { _id: userId },
      { projection: { position: 1, firstName: 1, companyId: 1 } }
    );

    const userFromEmployees = await employeeCollection.findOne(
      { _id: userId },
      { projection: { position: 1, firstName: 1, companyId: 1 } }
    );

    // Combine results: prioritize users collection, fallback to employees
    const user = userFromUsers || userFromEmployees;

    if (!user) {
      return res
        .status(401)
        .json({ message: "User not found in either collection, authorization denied" });
    }

    // Check if user is an employee, head, or manager
    if (!["Employee", "Head", "Manager"].includes(user.role)) {
      return res
        .status(403)
        .json({ message: "Access denied: User is not an employee, head, or manager" });
    }

    // Attach user to request object
    req.user = {
      _id: user._id.toString(), // Convert ObjectId to string
      firstName: user.firstName || "Anonymous",
      companyId: user.companyId ? user.companyId.toString() : null, // Ensure companyId is string
      position: user.position,
    };
    next();
  } catch (error) {
    console.error("Authentication error:", error.message);
    res.status(401).json({ message: "Invalid token or server error, authorization denied" });
  }
};