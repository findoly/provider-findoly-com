const mongoose = require("mongoose");

async function connectDatabase() {
  if (process.env.SKIP_DB === "true") return mongoose.connection;
  if ([1, 2].includes(mongoose.connection.readyState)) {
    return mongoose.connection;
  }

  const uri =
    process.env.MONGODB_URI;

  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: Number(
      process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 10000,
    ),
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 20),
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 2),
    maxIdleTimeMS: Number(process.env.MONGO_MAX_IDLE_TIME_MS || 60000),
    autoIndex: process.env.MONGO_AUTO_INDEX === "true",
  });

  console.log(`MongoDB connected: ${mongoose.connection.name}`);
  return mongoose.connection;
}

module.exports = connectDatabase;
