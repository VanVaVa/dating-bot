import "reflect-metadata";
import { DataSource } from "typeorm";
import { Interaction } from "./entities/Interaction.js";
import { Rating } from "./entities/Rating.js";
import { User } from "./entities/User.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

export const AppDataSource = new DataSource({
  type: "postgres",
  url: databaseUrl,
  entities: [User, Interaction, Rating],
  synchronize: process.env.DB_SYNC !== "false",
  logging: process.env.DB_LOGGING === "true",
});
