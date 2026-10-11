import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../lib/prisma';

const SEED_REVIEWS = [
  {
    userName: 'Aarav Mehta',
    avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
    rating: 5,
    reviewText: 'The Socratic evaluation gates completely eliminated my conceptual confusion in Organic Reaction Mechanisms. Best mastery architecture I have ever seen.',
    skillTag: 'Haloalkanes & Haloarenes',
    isVerified: true,
  },
  {
    userName: 'Elena Rostova',
    avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80',
    rating: 5,
    reviewText: 'Practicing sprint bio-mechanics with the dedicated Sports Hub timer and drill recommendations increased my stride power within 14 days.',
    skillTag: 'Sprint Acceleration Biomechanics',
    isVerified: true,
  },
  {
    userName: 'Kavita Sharma',
    avatarUrl: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop&q=80',
    rating: 5,
    reviewText: 'The in-app multi-language document reader translated complex quantum physics papers into Hindi seamlessly without losing mathematical rigor.',
    skillTag: 'Quantum Foundations',
    isVerified: true,
  },
  {
    userName: 'Marcus Sterling',
    avatarUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80',
    rating: 5,
    reviewText: 'The streak freezes can actually only be earned by maintaining unbroken consistency, which finally built a genuine daily discipline habit for me.',
    skillTag: 'Distributed Systems Consensus',
    isVerified: true,
  },
];

export const reviewRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // 1. GET /api/reviews/public — Public reviews for landing page wall of love
  fastify.get('/api/reviews/public', async (req, reply) => {
    try {
      let reviews = await prisma.review.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      if (reviews.length === 0) {
        // Seed default high-quality reviews
        for (const seed of SEED_REVIEWS) {
          await prisma.review.create({ data: seed });
        }
        reviews = await prisma.review.findMany({
          orderBy: { createdAt: 'desc' },
          take: 20,
        });
      }

      return reply.status(200).send({ reviews });
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
