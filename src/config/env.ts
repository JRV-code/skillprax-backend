import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().transform((val) => Number(val)).default('4000'),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().optional(),
  FRONTEND_URL: z.string().default('https://skillprax-frontend-3a8p.vercel.app'),
  OPENAI_API_KEY: z.string().optional()
});

export const env = envSchema.parse(process.env);

export const getAuthRedirectUrl = (path: string = '/'): string => {
  const baseUrl = process.env.FRONTEND_URL || (env.NODE_ENV === 'production' ? 'https://skillprax-frontend-3a8p.vercel.app' : 'http://localhost:3000');
  const formattedPath = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${formattedPath}`;
};
