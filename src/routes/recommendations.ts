import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import prisma from '../lib/prisma';

export const recommendationRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // GET /api/recommendations/curated — Curated Next Horizons Engine (Module 4)
  fastify.get('/api/recommendations/curated', async (req, reply) => {
    try {
      const query = (req.query || {}) as { profileId?: string; domain?: string };
      let profile: any = null;

      if (query.profileId) {
        profile = await prisma.userProfile.findUnique({
          where: { id: query.profileId },
          include: { workspaces: { select: { title: true, domainCategory: true } } },
        });
      }

      const userProfession = profile?.profession || 'General Learner';
      const enrolledTitles = (profile?.workspaces || []).map((w: any) => w.title.toLowerCase());

      // Curated Recommendations pool (Cognitive & Sports)
      const recommendations = [
        {
          id: 'rec-eng-1',
          domain: 'Engineering & Applied Technology',
          title: 'Distributed Systems & Event-Driven Architecture',
          subGenre: 'Microservices & Kafka Pipelines',
          affinityScore: 96,
          radarMetrics: {
            conceptualDepth: 94,
            practicalApplication: 98,
            prerequisiteFit: 92,
            industryRelevance: 99,
            learningVelocity: 90,
          },
          rationale: `Direct progression tailored to ${userProfession}: Amplifies distributed protocols and event stream mastery.`,
          category: 'cognitive',
        },
        {
          id: 'rec-sport-1',
          domain: 'Athletics & Physical Mastery',
          title: 'Football: Ball Mastery & Tight Space Dribbling',
          subGenre: 'Cruyff Turns & Cone Agility Shuttles',
          affinityScore: 92,
          radarMetrics: {
            conceptualDepth: 85,
            practicalApplication: 98,
            prerequisiteFit: 95,
            industryRelevance: 88,
            learningVelocity: 94,
          },
          rationale: 'Active cross-training: Develops rapid peripheral vision, ankle elasticity, and cognitive reaction speeds.',
          category: 'sports',
        },
        {
          id: 'rec-math-1',
          domain: 'Formal Sciences & Mathematics',
          title: 'Graph Theory & Combinatorial Algorithms',
          subGenre: 'Shortest Paths & Flow Networks',
          affinityScore: 89,
          radarMetrics: {
            conceptualDepth: 98,
            practicalApplication: 86,
            prerequisiteFit: 90,
            industryRelevance: 92,
            learningVelocity: 82,
          },
          rationale: 'Foundational deepening: Sharpens discrete mathematical rigor and topological problem-solving.',
          category: 'cognitive',
        },
        {
          id: 'rec-sport-2',
          domain: 'Athletics & Physical Mastery',
          title: 'Cricket: Wicketkeeping & Lateral Reflexes',
          subGenre: 'Stump Alignment & Blind-Spot Catches',
          affinityScore: 88,
          radarMetrics: {
            conceptualDepth: 80,
            practicalApplication: 95,
            prerequisiteFit: 90,
            industryRelevance: 85,
            learningVelocity: 90,
          },
          rationale: 'High-focus neuromuscular conditioning: Enhances split-second glove coordination and low-crouch stamina.',
          category: 'sports',
        },
        {
          id: 'rec-design-1',
          domain: 'Design & Visual Systems',
          title: 'Human-Computer Interaction & Spatial Ergonomics',
          subGenre: 'Micro-Interactions & Glassmorphic UI Systems',
          affinityScore: 86,
          radarMetrics: {
            conceptualDepth: 88,
            practicalApplication: 92,
            prerequisiteFit: 84,
            industryRelevance: 90,
            learningVelocity: 86,
          },
          rationale: 'Interdisciplinary bridge: Merges engineering architecture with fluid, weightless user interfaces.',
          category: 'cognitive',
        },
      ];

      // Filter out already enrolled trajectories if applicable
      const filtered = recommendations.filter(
        (r) => !enrolledTitles.some((t: string) => t.includes(r.title.toLowerCase().slice(0, 15)))
      );

      return reply.status(200).send({
        success: true,
        recommendations: filtered.length > 0 ? filtered : recommendations,
      });
    } catch (err: any) {
      fastify.log.error(err, '[GET /api/recommendations/curated] Failed');
      return reply.status(500).send({ error: 'Failed to retrieve recommendations' });
    }
  });
};

export default recommendationRoutes;
