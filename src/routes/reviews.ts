import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../lib/prisma';

export const reviewRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. GET /api/reviews/public — Authentic-only public reviews (zero mock/AI reviews)
  fastify.get('/api/reviews/public', async (req, reply) => {
    try {
      // Query genuine reviews from PostgreSQL
      const reviews: any[] = await prisma.$queryRawUnsafe(`
        SELECT 
          id,
          user_id AS "userId",
          profile_id AS "profileId",
          user_name AS "userName",
          user_avatar AS "avatarUrl",
          skill_tag AS "skillTag",
          rating,
          COALESCE(comment, review_text) AS "reviewText",
          COALESCE(comment, review_text) AS comment,
          is_verified AS "isVerified",
          created_at AS "createdAt"
        FROM reviews
        WHERE is_verified = TRUE AND status = 'published'
        ORDER BY created_at DESC
        LIMIT 30;
      `);

      return reply.status(200).send({ reviews: reviews || [] });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/reviews/public] Failed');
      return reply.status(200).send({ reviews: [] });
    }
  });

  // 2. GET /api/reviews/user/:userId — Fetch reviews written by specific authenticated user
  fastify.get('/api/reviews/user/:userId', async (req, reply) => {
    const { userId } = req.params as { userId: string };
    try {
      const reviews: any[] = await prisma.$queryRawUnsafe(`
        SELECT 
          id,
          user_id AS "userId",
          profile_id AS "profileId",
          user_name AS "userName",
          user_avatar AS "avatarUrl",
          skill_tag AS "skillTag",
          rating,
          COALESCE(comment, review_text) AS "reviewText",
          COALESCE(comment, review_text) AS comment,
          is_verified AS "isVerified",
          created_at AS "createdAt"
        FROM reviews
        WHERE user_id = $1 OR profile_id = $1
        ORDER BY created_at DESC;
      `, userId);

      return reply.status(200).send({ reviews: reviews || [] });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/reviews/user/:userId] Failed');
      return reply.status(200).send({ reviews: [] });
    }
  });

  // 3. POST /api/reviews — Submit authentic review
  fastify.post('/api/reviews', async (req, reply) => {
    try {
      const body = (req.body || {}) as {
        userId?: string;
        profileId?: string;
        userName?: string;
        avatarUrl?: string;
        userAvatar?: string;
        rating?: number;
        reviewText?: string;
        comment?: string;
        skillTag?: string;
      };

      const reviewContent = (body.comment || body.reviewText || '').trim();
      if (!reviewContent || reviewContent.length < 10) {
        return reply.status(400).send({ error: 'Review text must be at least 10 characters long.' });
      }

      const rating = Math.min(5, Math.max(1, Number(body.rating) || 5));
      const uId = body.userId || body.profileId || 'anonymous-user';
      const uName = (body.userName || 'Verified Learner').trim();
      const uAvatar = body.avatarUrl || body.userAvatar || null;
      const sTag = body.skillTag?.trim() || 'General Pedagogy';

      const rows: any[] = await prisma.$queryRawUnsafe(`
        INSERT INTO reviews (
          user_id,
          profile_id,
          user_name,
          user_avatar,
          skill_tag,
          rating,
          comment,
          review_text,
          status,
          is_verified,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'published', TRUE, NOW(), NOW())
        RETURNING 
          id,
          user_id AS "userId",
          profile_id AS "profileId",
          user_name AS "userName",
          user_avatar AS "avatarUrl",
          skill_tag AS "skillTag",
          rating,
          comment,
          review_text AS "reviewText",
          is_verified AS "isVerified",
          created_at AS "createdAt";
      `, uId, uId, uName, uAvatar, sTag, rating, reviewContent, reviewContent);

      return reply.status(201).send({ success: true, review: rows[0] });
    } catch (err: any) {
      fastify.log.error(err, '[POST /api/reviews] Failed');
      return reply.status(500).send({ error: 'Failed to publish review' });
    }
  });

  // 4. PATCH /api/reviews/:id — Edit review
  fastify.patch('/api/reviews/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const body = (req.body || {}) as {
        rating?: number;
        reviewText?: string;
        comment?: string;
        skillTag?: string;
      };

      const newRating = body.rating !== undefined ? Math.min(5, Math.max(1, Number(body.rating))) : null;
      const newComment = (body.comment || body.reviewText || '').trim();
      const newSkillTag = body.skillTag?.trim() || null;

      const rows: any[] = await prisma.$queryRawUnsafe(`
        UPDATE reviews
        SET 
          rating = COALESCE($1, rating),
          comment = CASE WHEN $2 <> '' THEN $2 ELSE comment END,
          review_text = CASE WHEN $2 <> '' THEN $2 ELSE review_text END,
          skill_tag = COALESCE($3, skill_tag),
          updated_at = NOW()
        WHERE id = $4::uuid
        RETURNING 
          id,
          user_id AS "userId",
          profile_id AS "profileId",
          user_name AS "userName",
          user_avatar AS "avatarUrl",
          skill_tag AS "skillTag",
          rating,
          comment,
          review_text AS "reviewText",
          is_verified AS "isVerified",
          created_at AS "createdAt";
      `, newRating, newComment, newSkillTag, id);

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Review not found.' });
      }

      return reply.status(200).send({ success: true, review: rows[0] });
    } catch (err: any) {
      fastify.log.error(err, '[PATCH /api/reviews/:id] Failed');
      return reply.status(500).send({ error: 'Failed to update review' });
    }
  });

  // 5. DELETE /api/reviews/:id — Delete review
  fastify.delete('/api/reviews/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await prisma.$executeRawUnsafe(`
        DELETE FROM reviews WHERE id = $1::uuid;
      `, id);
      return reply.status(200).send({ success: true, message: 'Review deleted successfully.' });
    } catch (err: any) {
      fastify.log.error(err, '[DELETE /api/reviews/:id] Failed');
      return reply.status(500).send({ error: 'Failed to delete review' });
    }
  });
};

export default reviewRoutes;
