import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { getDB } from '../services/db.js';

const authMiddleware = async (req, res, next) => {
  const db = getDB();
  const userCollection = db.collection("users");
  const employeeCollection = db.collection("admins");
  const clientCollection = db.collection("clients");
  const companyCollection = db.collection("companyregistrations");

  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: "No token provided, authorization denied" });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: "Invalid token format, authorization denied" });
    }

    // Verify and decode token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      console.error("Token verification error:", error.message);
      return res.status(401).json({
        message: error.name === "TokenExpiredError" ? "Token expired" : "Invalid token",
      });
    }

    // Extract user ID and role from decoded token
    const idKey = decoded.userId || decoded.clientId || decoded.adminId || decoded.id;
    if (!idKey) {
      console.warn("Invalid token structure, user ID not found", decoded);
      return res.status(400).json({ message: "Invalid token structure, user ID not found" });
    }

    const userId = new ObjectId(idKey);
    
    // Map position to role
    let role = decoded.role || decoded.userRole || decoded.type || "Employee";
    const position = decoded.position?.toLowerCase();
    if (["employee", "manager", "hr"].includes(position)) {
      role = "user";
    } else if (position === "admin") {
      role = "admin";
    }else if (position === "client") {
      role = "client";
    }

    // Define projection for user data
    const projection = {
      position: 1,
      firstName: 1,
      fullName: 1,
      name: 1,
      companyId: 1,
      email: 1,
    };

    // Query user based on role
    let user = null;
    switch (role) {
      case "user":
        user = await userCollection.findOne({ _id: userId }, { projection });
        break;
      case "admin":
        user = await employeeCollection.findOne({ _id: userId }, { projection });
        break;
      case "client":
        user = await clientCollection.findOne({ _id: userId }, { projection });
        break;
      default:
        console.error(`Invalid role: ${role}`);
        return res.status(400).json({ message: "Invalid role, authorization denied" });
    }

    // Check if user exists
    if (!user) {
      console.warn(`User not found for ID: ${userId} with role: ${role}`);
      return res.status(401).json({ message: "User not found, authorization denied" });
    }

    // Fetch company name if companyId exists
    let companyName = decoded.companyName || null;
    const companyId = user.companyId || decoded.companyId || null;
    if (companyId) {
      try {
        const company = await companyCollection.findOne(
          { _id: new ObjectId(companyId) },
          { projection: { "companyInfo.companyName": 1 } }
        );
        companyName = company?.companyInfo?.companyName || "Unknown";
      } catch (error) {
        console.error(`Error fetching company for ID: ${companyId}`, error.message);
      }
    }

    // Attach user info to request
    req.user = {
      userId: idKey.toString(),
      email: user.email || decoded.email || null,
      companyId: companyId?.toString() || null,
      position: user.position || decoded.position || null,
      firstName: user.firstName || user.name || user.fullName || decoded.firstName || null,
      companyName,
      role,
    };

    next();
  } catch (error) {
    console.error("Authentication error:", error.message, error.stack);
    return res.status(500).json({ message: "Server error during authentication" });
  }
};

export default authMiddleware;