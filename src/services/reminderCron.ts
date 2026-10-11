import nodemailer from 'nodemailer';
import prisma from '../lib/prisma';

// Transporter configuration: uses SMTP env vars if present, otherwise logs or creates test transporter
let transporter: any = null;

async function getTransporter(): Promise<any> {
  if (transporter) return transporter;

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT) || 587;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (smtpHost && smtpUser && smtpPass) {
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });
  } else {
    // Development fallback transporter with console logging
    transporter = nodemailer.createTransport({
      streamTransport: true,
      newline: 'windows',
      buffer: true,
    });
  }
  return transporter;
}

export async function sendDailyReminderEmail(profileId: string): Promise<{ success: boolean; messageId?: string; previewUrl?: string }> {
  try {
    const profile = await prisma.userProfile.findUnique({
      where: { id: profileId },
      include: {
        workspaces: {
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!profile || !profile.email) {
      return { success: false };
    }

    const recipientEmail = profile.email;
    const activeSkill = profile.workspaces[0]?.title || 'Daily Mastery Track';
    const streak = profile.currentStreak || 1;
    const frontendBaseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const workspaceLink = profile.workspaces[0]
      ? `${frontendBaseUrl}/workspace/${profile.workspaces[0].id}`
      : `${frontendBaseUrl}/workspace`;

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 24px; color: #1e293b; }
    .card { max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 24px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05); }
    .header { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: #ffffff; padding: 32px 28px; text-align: center; }
    .header h1 { margin: 0; font-size: 20px; font-weight: 800; letter-spacing: -0.025em; }
    .badge { display: inline-block; background: rgba(16, 185, 129, 0.2); color: #34d399; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 4px 12px; border-radius: 9999px; border: 1px solid rgba(52, 211, 153, 0.3); margin-top: 10px; }
    .content { padding: 32px 28px; }
    .streak-banner { background: #fffbeb; border: 1px solid #fef3c7; border-radius: 16px; padding: 16px; text-align: center; margin-bottom: 24px; }
    .streak-number { font-size: 28px; font-weight: 900; color: #b45309; }
    .btn { display: block; text-align: center; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff; font-weight: 700; font-size: 14px; text-decoration: none; padding: 14px 24px; border-radius: 16px; box-shadow: 0 10px 20px -5px rgba(16, 185, 129, 0.4); margin-top: 24px; }
    .footer { text-align: center; font-size: 11px; color: #94a3b8; padding: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>SKILL-TRACK</h1>
      <span class="badge">Daily Mastery Cadence</span>
    </div>
    <div class="content">
      <p style="font-size: 16px; font-weight: 600; color: #0f172a; margin-top: 0;">Hello ${profile.name},</p>
      <p style="font-size: 14px; line-height: 1.6; color: #475569;">
        It's time for your daily milestone in <strong>${activeSkill}</strong>! Maintaining unbroken daily momentum is the proven path to deep procedural mastery.
      </p>
      
      <div class="streak-banner">
        <div class="streak-number">🔥 ${streak} Days</div>
        <div style="font-size: 12px; font-weight: 700; color: #92400e; margin-top: 4px;">Active Daily Learning Streak</div>
      </div>

      <a href="${workspaceLink}" class="btn">Launch Workspace Studio ➔</a>
    </div>
    <div class="footer">
      Sent with care by SKILL-TRACK Autonomous Pedagogy Engine.<br>
      You can configure your daily notification time in Profile Settings.
    </div>
  </div>
</body>
</html>
`;

    const mailer = await getTransporter();
    const info = await mailer.sendMail({
      from: process.env.SMTP_FROM || '"SKILL-TRACK" <notifications@skillprax.com>',
      to: recipientEmail,
      subject: `Time for your daily SKILL-TRACK milestone in ${activeSkill}! 🔥`,
      html: htmlContent,
    });

    console.log(`[ReminderCron] Reminder email sent to ${recipientEmail}: ${info.messageId || 'STREAM_LOGGED'}`);
    return { success: true, messageId: info.messageId };
  } catch (err: any) {
    console.error('[ReminderCron] Failed to send reminder email:', err);
    return { success: false };
  }
}

// Background cron scheduler that runs every 10 minutes to dispatch reminders matching user time
export function startReminderScheduler(): void {
  const checkAndDispatchReminders = async () => {
    try {
      const now = new Date();
      const currentHours = String(now.getHours()).padStart(2, '0');
      const currentMinutes = String(now.getMinutes()).padStart(2, '0');
      const currentTimeString = `${currentHours}:${currentMinutes}`;

      const eligibleProfiles = await prisma.userProfile.findMany({
        where: {
          remindersEnabled: true,
          email: { not: null },
          reminderTime: { startsWith: currentHours },
        },
      });

      for (const p of eligibleProfiles) {
        await sendDailyReminderEmail(p.id);
      }
    } catch (err) {
      console.error('[ReminderCron] Error during scheduled check:', err);
    }
  };

  // Run on startup and every 10 minutes
  setInterval(checkAndDispatchReminders, 10 * 60 * 1000);
}
