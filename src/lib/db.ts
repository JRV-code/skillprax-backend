import prisma from './prisma';

/**
 * Universal Database Client Adapter
 * Provides a standard db.query interface backed by Prisma and PostgreSQL.
 */
export const db = {
  async query<T = any>(sql: string, params: any[] = []): Promise<{ rows: T[] }> {
    const trimmed = sql.trim();
    if (trimmed.toUpperCase().startsWith('SELECT') || trimmed.toUpperCase().startsWith('WITH')) {
      const rows = await prisma.$queryRawUnsafe(sql, ...params);
      return { rows: Array.isArray(rows) ? (rows as T[]) : ([rows] as T[]) };
    } else {
      await prisma.$executeRawUnsafe(sql, ...params);
      return { rows: [] };
    }
  },
};

export default db;
