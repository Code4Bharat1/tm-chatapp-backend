import { MongoClient } from "mongodb";

let db;
export const connectDB = async () => {
  console.log("Mongo URI:", process.env.MONGO_URI); // temporary debug
  const client = new MongoClient(process.env.MONGO_URI);

  try {
    await client.connect();
    console.log("connect to mongodb");
    db = client.db("tm");
  } catch (error) {
    console.log("error in connecting database", error);
  }
};
export const getDB = () => {
  if (!db) throw new Error("DB not initialized. Call connectDB() first.");
  return db;
};
