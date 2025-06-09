import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { parse } from 'cookie';
import { getDB } from '../services/db.js'; // Adjust the path to your DB connection

const authMiddleware = async (req, res, next) => {
  const db = getDB();
  const userCollection = db.collection("users");
  const employeeCollection = db.collection("admins");
  const clientCollection = db.collection("clients");
  const companyCollection = db.collection("companyregistrations");

  try {
    let token = null;
    let decoded = null;
    let role = null;
    let secret = null;

    // Check for cookies
    if (!req.headers.cookie) {
      console.warn("No cookies found in request headers");
      return res
        .status(401)
        .json({ message: "No cookies provided, authorization denied" });
    }

    // Parse cookies
    const cookies = parse(req.headers.cookie);
    console.log("Cookies parsed:", cookies);

    // Try tokens in order of priority
    if (cookies.token) {
      token = cookies.token;
      secret = process.env.JWT_SECRET;
      role = "user";
    } else if (cookies.admintoken) {
      token = cookies.admintoken;
      secret = process.env.JWT_SECRET;
      role = "admin";
    } else if (cookies.clientToken) {
      token = cookies.clientToken;
      secret = process.env.JWT_SECRET;
      role = "client";
    } else {
      console.warn("No recognized token found in cookies:", Object.keys(cookies));
      return res
        .status(401)
        .json({ message: "No recognized token provided, authorization denied" });
    }

    // Validate token, role, and secret
    if (!token || !role || !secret) {
      console.warn("Token, role, or secret missing", { token: !!token, role, secret: !!secret });
      return res
        .status(401)
        .json({ message: "Invalid token or role configuration, authorization denied" });
    }

    // Verify token
    try {
      decoded = jwt.verify(token, secret);
      console.log("Token decoded:", decoded);
    } catch (error) {
      console.error("Token verification error:", error.message);
      return res.status(401).json({
        message:
          error.name === "TokenExpiredError"
            ? "Token expired"
            : "Invalid token",
      });
    }

    // Determine the user ID key
    const idKey =
      decoded.userId || decoded.clientId || decoded.adminId || decoded.id;
    if (!idKey) {
      console.warn("Invalid token structure, user ID not found", decoded);
      return res
        .status(400)
        .json({ message: "Invalid token structure, user ID not found" });
    }

    const userId = new ObjectId(idKey);
    console.log(`Querying ${role} with ID: ${userId}`);

    // Define projection for user data
    const projection = {
      position: 1,
      firstName: 1,
      fullName: 1, // Include fullName for users and admins
      name: 1, // Include name for clients
      companyId: 1,
      email: 1,
    };

    // Fetch user based on role
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
        return res
          .status(400)
          .json({ message: "Invalid role, authorization denied" });
    }

    // Check if user exists
    if (!user) {
      console.warn(`User not found for ID: ${userId} with role: ${role}`);
      return res
        .status(401)
        .json({ message: "User not found, authorization denied" });
    }

    // Fetch company name based on companyId
    let companyName = decoded.companyName || null;
    const companyId = user.companyId || decoded.companyId || null;
    if (companyId) {
      try {
        const company = await companyCollection.findOne(
          { _id: new ObjectId(companyId) },
          { projection: { "companyInfo.companyName": 1 } }
        );
        if (company && company.companyInfo) {
          companyName = company.companyInfo.companyName || "Unknown";
        } else {
          console.warn(`Company not found for ID: ${companyId}`);
        }
      } catch (error) {
        console.error(`Error fetching company for ID: ${companyId}`, error.message);
      }
    } else {
      console.warn("No companyId found in user or token");
    }

    // Attach user info to req.user
    req.user = {
      userId: idKey.toString(),
      email: user.email || decoded.email || null,
      companyId: companyId?.toString() || null,
      position: user.position || decoded.position || null,
      firstName: user.firstName || user.name || user.fullName || decoded.firstName || null,
      companyName: companyName,
      role,
    };
    console.log("User authenticated:", req.user);

    // Final validation before proceeding
    if (!req.user.role) {
      console.error("req.user.role is not defined after setting", req.user);
      return res
        .status(500)
        .json({ message: "Internal error: role not set" });
    }

    console.log("Proceeding to next middleware/controller");
    next();
  } catch (error) {
    console.error("Authentication error:", error.message, error.stack);
    return res.status(500).json({ message: "Server error during authentication" });
  }
};

export default authMiddleware;