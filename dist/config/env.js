import dotenv from 'dotenv';
import { z } from 'zod';
dotenv.config();
const envSchema = z.object({
    PORT: z.string().transform((val) => Number(val)).default('4000'),
    HOST: z.string().default('0.0.0.0'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DATABASE_URL: z.string().optional(),
    FRONTEND_URL: z.string().default('http://localhost:3000'),
    OPENAI_API_KEY: z.string().optional()
});
export const env = envSchema.parse(process.env);
