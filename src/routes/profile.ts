import { FastifyInstance, FastifyPluginAsync } from "fastify";
import prisma from "../lib/prisma";

export const profileRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Helper to ensure a profile record exists
  async function getOrCreateProfile() {
    let profile = await (prisma as any).userProfile.findUnique({
      where: { id: "default-profile" },
    });
    if (!profile) {
      profile = await (prisma as any).userProfile.create({
        data: {
          id: "default-profile",
          name: "SkillPrax Learner",
          age: 18,
          profession: "Full-Stack Builder",
        },
      });
    }
    return profile;
  }

  // GET /api/profile - Full profile data with aggregated track statistics
  fastify.get("/api/profile", async (_req, reply) => {
    try {
      const profile = await getOrCreateProfile();

      const workspaces = await prisma.workspace.findMany({
        orderBy: { updatedAt: "desc" },
        include: {
          steps: {
            select: { id: true, stepIndex: true, status: true, title: true },
            orderBy: { stepIndex: "asc" },
          },
        },
      });

      let totalMilestonesPassed = 0;
      let skillsMastered = 0;
      let skillsInProgress = 0;

      const skillCards = workspaces.map((ws: any) => {
        const steps = ws.steps || [];
        const totalSteps = Math.max(steps.length, 1);
        const passedCount = steps.filter((s: any) => s.status === "PASSED").length;
        const progress = Math.round((passedCount / totalSteps) * 100);
        const isMastered = steps.length > 0 && passedCount === steps.length;

        totalMilestonesPassed += passedCount;
        if (isMastered) {
          skillsMastered++;
        } else {
          skillsInProgress++;
        }

        return {
          id: ws.id,
          title: ws.title,
          domainCategory: ws.domainCategory,
          targetGoal: ws.targetGoal,
          level: ws.level,
          totalSteps,
          completedSteps: passedCount,
          currentStep: ws.currentStep || (passedCount < totalSteps ? passedCount + 1 : totalSteps),
          progress,
          isMastered,
          createdAt: ws.createdAt,
          updatedAt: ws.updatedAt,
        };
      });

      // Calculate App Usage / Tenure
      const now = new Date();
      const joinedDate = new Date(profile.createdAt);
      const diffMs = now.getTime() - joinedDate.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      const diffMonths = Math.floor(diffDays / 30);

      let tenureText = `${diffDays} days on SkillPrax`;
      if (diffMonths >= 1) {
        tenureText = `${diffMonths} month${diffMonths > 1 ? "s" : ""} active`;
      } else if (diffDays === 0) {
        tenureText = "Joined today";
      }

      return reply.status(200).send({
        profile: {
          name: profile.name,
          age: profile.age,
          profession: profile.profession,
          joinedAt: profile.createdAt,
          tenureText,
        },
        stats: {
          totalSkills: workspaces.length,
          skillsInProgress,
          skillsMastered,
          totalMilestonesPassed,
        },
        skillCards,
      });
    } catch (err: any) {
      fastify.log.error(err, "[GET /api/profile] Failed");
      return reply.status(500).send({ error: "Failed to fetch user profile" });
    }
  });

  // PATCH /api/profile - Update name, age, profession
  fastify.patch("/api/profile", async (req, reply) => {
    try {
      const body = (req.body || {}) as { name?: string; age?: number; profession?: string };
      const dataToUpdate: any = {};

      if (typeof body.name === "string" && body.name.trim()) {
        dataToUpdate.name = body.name.trim();
      }
      if (body.age !== undefined && !isNaN(Number(body.age))) {
        dataToUpdate.age = Number(body.age);
      }
      if (typeof body.profession === "string" && body.profession.trim()) {
        dataToUpdate.profession = body.profession.trim();
      }

      const updated = await (prisma as any).userProfile.upsert({
        where: { id: "default-profile" },
        create: {
          id: "default-profile",
          name: dataToUpdate.name || "Learner",
          age: dataToUpdate.age || 18,
          profession: dataToUpdate.profession || "Engineer",
        },
        update: dataToUpdate,
      });

      return reply.status(200).send(updated);
    } catch (err: any) {
      fastify.log.error(err, "[PATCH /api/profile] Failed");
      return reply.status(500).send({ error: "Failed to update profile" });
    }
  });
};

export default profileRoutes;
