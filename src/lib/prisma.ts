import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const activeDbUrl =
  process.env.NEON_DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL;

export const prisma = new PrismaClient(
  activeDbUrl
    ? {
        datasources: {
          db: {
            url: activeDbUrl,
          },
        },
      }
    : undefined
);

export default prisma;
