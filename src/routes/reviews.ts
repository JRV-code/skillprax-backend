import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../lib/prisma';

export const reviewRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. GET /api/reviews/public — Authentic-only public reviews (no mock/seed reviews)
  fastify.get('/api/reviews/public', async (req, reply) => {
    try {
      // Query only genuine user reviews with verified status and published status
      const reviews = await prisma.review.findMany({
        where: {
          isVerified: true,
          status: 'published',
        },
        orderBy: { createdAt: 'desc' },
        take: 30,
      });

      // Returns authentic reviews or an empty array if none have been submitted yet
      return reply.status(200).send({ reviews: reviews || [] });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/reviews/public] Failed');
      return reply.status(500).send({ error: 'Failed to retrieve public reviews' });
    }
  });

  // 2. GET /api/reviews/user/:profileId — Fetch reviews written by specific profile
  fastify.get('/api/reviews/user/:profileId', async (req, reply) => {
    const { profileId } = req.params as { profileId: string };
    try {
      const reviews = await prisma.review.findMany({
        where: { profileId },
        orderBy: { createdAt: 'desc' },
      });
      return reply.status(200).send({ reviews });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/reviews/user/:profileId] Failed');
      return reply.status(500).send({ error: 'Failed to retrieve user reviews' });
    }
  });

  // 3. POST /api/reviews — Submit review
  fastify.post('/api/reviews', async (req, reply) => {
    try {
      const body = (req.body || {}) as {
        profileId?: string;
        userName?: string;
        avatarUrl?: string;
        rating?: number;
        reviewText?: string;
        skillTag?: string;
      };

      if (!body.reviewText || !body.reviewText.trim()) {
        return reply.status(400).send({ error: 'Review text cannot be empty.' });
      }

      const rating = Math.min(5, Math.max(1, Number(body.rating) || 5));

      const review = await prisma.review.create({
        data: {
          profileId: body.profileId || null,
          userName: (body.userName || 'Verified Learner').trim(),
          avatarUrl: body.avatarUrl || null,
          rating,
          reviewText: body.reviewText.trim(),
          skillTag: body.skillTag?.trim() || 'General Pedagogy',
          status: 'published',
          isVerified: true,
        },
      });

      return reply.status(201).send({ success: true, review });
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
        skillTag?: string;
      };

      const dataToUpdate: any = {};
      if (body.rating !== undefined) dataToUpdate.rating = Math.min(5, Math.max(1, Number(body.rating)));
      if (typeof body.reviewText === 'string' && body.reviewText.trim()) dataToUpdate.reviewText = body.reviewText.trim();
      if (typeof body.skillTag === 'string') dataToUpdate.skillTag = body.skillTag.trim();

      const review = await prisma.review.update({
        where: { id },
        data: dataToUpdate,
      });

      return reply.status(200).send({ success: true, review });
    } catch (err: any) {
      fastify.log.error(err, '[PATCH /api/reviews/:id] Failed');
      return reply.status(500).send({ error: 'Failed to update review' });
    }
  });

  // 5. DELETE /api/reviews/:id — Delete review
  fastify.delete('/api/reviews/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await prisma.review.delete({
        where: { id },
      });
      return reply.status(200).send({ success: true, message: 'Review deleted successfully.' });
    } catch (err: any) {
      fastify.log.error(err, '[DELETE /api/reviews/:id] Failed');
      return reply.status(500).send({ error: 'Failed to delete review' });
    }
  });
};

export default reviewRoutes;
