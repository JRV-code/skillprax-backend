import cron, { ScheduledTask } from 'node-cron';
import prisma from '../lib/prisma';
import { sendDailyPracticeReminderEmail } from '../services/emailService';

function getTodayString(): string {
  const d = new Date();
  return d.toISOString().split('T')[0];
}

/**
 * Checks if current time roughly matches the user's preferred reminder time.
 * preferredTime format: "HH:mm" (e.g., "19:00" or "20:30")
 */
function isTimeMatching(preferredTime: string = '19:00'): boolean {
  try {
    const now = new Date();
    const currentHours = now.getHours();
    const currentMinutes = now.getMinutes();

    const [prefHoursStr, prefMinutesStr] = preferredTime.split(':');
    const prefHours = parseInt(prefHoursStr, 10);
    const prefMinutes = parseInt(prefMinutesStr || '0', 10);

    if (isNaN(prefHours)) return false;

    // Matches if current hour matches and within a 20-minute window
    if (currentHours === prefHours) {
      return Math.abs(currentMinutes - prefMinutes) <= 20;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Executes a single sweep of the reminder schedule.
 */
export async function runReminderSweep(): Promise<{ scanned: number; dispatched: number }> {
  const todayStr = getTodayString();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  let dispatched = 0;

  try {
    // Query users where daily reminders are enabled, email exists, and reminder not sent today
    const candidates = await prisma.userProfile.findMany({
      where: {
        dailyReminderEnabled: true,
        email: { not: null },
        OR: [
          { lastReminderSentAt: null },
          { lastReminderSentAt: { lt: startOfToday } },
        ],
      },
      include: {
        workspaces: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
      },
    });

    for (const user of candidates) {
      if (!user.email) continue;

      // Check preferred time
      const preferredTime = user.preferredReminderTime || user.reminderTime || '19:00';
      if (!isTimeMatching(preferredTime)) {
        continue;
      }

      // Check if user has already practiced today
      if (user.lastPracticeDate === todayStr) {
        continue;
      }

      // Format target time
      const hours = user.targetDailyHours ?? user.targetHours ?? 1;
      const minutes = user.targetDailyMinutes ?? user.targetMinutes ?? 30;
      const targetTimeStr = `${hours}h ${minutes}m`;

      const activeTrack = user.workspaces[0]?.title || 'Daily Mastery Curriculum';
      const streak = user.currentStreak ?? user.streakDays ?? 1;

      const result = await sendDailyPracticeReminderEmail({
        to: user.email,
        userName: user.name || 'Learner',
        skillOrSportName: activeTrack,
        streakDays: streak,
        targetDailyTime: targetTimeStr,
      });

      if (result.success) {
        dispatched++;
        await prisma.userProfile.update({
          where: { id: user.id },
          data: { lastReminderSentAt: new Date() },
        });

        // Also update users table if present
        try {
          await (prisma as any).user?.update({
            where: { email: user.email },
            data: { lastReminderSentAt: new Date() },
          });
        } catch {}
      }
    }

    console.log(`[ReminderCronJob] Sweep complete: scanned ${candidates.length}, dispatched ${dispatched} reminders.`);
    return { scanned: candidates.length, dispatched };
  } catch (err) {
    console.error('[ReminderCronJob] Sweep execution error:', err);
    return { scanned: 0, dispatched: 0 };
  }
}

/**
 * Initializes the automated reminder cron scheduler running every 15 minutes.
 */
export function initializeReminderCron(): ScheduledTask {
  console.log('[ReminderCronJob] Initializing cron scheduler (every 15 minutes: */15 * * * *)...');
  
  const task = cron.schedule('*/15 * * * *', async () => {
    console.log('[ReminderCronJob] Triggering 15-minute scheduled reminder sweep...');
    await runReminderSweep();
  });

  return task;
}

export default initializeReminderCron;
