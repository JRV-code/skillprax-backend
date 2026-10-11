import nodemailer from 'nodemailer';

// Nodemailer transporter instance
let transporter: any = null;

export async function getEmailTransporter(): Promise<any> {
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
    // Development fallback transporter
    transporter = nodemailer.createTransport({
      streamTransport: true,
      newline: 'windows',
      buffer: true,
    });
  }
  return transporter;
}

export interface SendReminderEmailParams {
  to: string;
  userName: string;
  skillOrSportName: string;
  streakDays: number;
  targetDailyTime?: string;
  workspaceUrl?: string;
}

/**
 * Builds and dispatches the official branded SKILL-TRACK daily practice reminder email.
 */
export async function sendDailyPracticeReminderEmail(
  params: SendReminderEmailParams
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const {
      to,
      userName,
      skillOrSportName,
      streakDays,
      targetDailyTime = '45 Minutes',
      workspaceUrl,
    } = params;

    const appUrl = (process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const ctaLink = workspaceUrl || `${appUrl}/workspace`;

    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SKILL-TRACK Daily Milestone Reminder</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background-color: #F8FAFC;
      margin: 0;
      padding: 32px 16px;
      color: #0F172A;
    }
    .wrapper {
      max-width: 560px;
      margin: 0 auto;
      background: #FFFFFF;
      border-radius: 24px;
      border: 1px solid rgba(226, 232, 240, 0.9);
      overflow: hidden;
      box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.05);
    }
    .header {
      background: #0F172A;
      padding: 36px 32px 28px;
      text-align: center;
    }
    .wordmark {
      font-size: 26px;
      font-weight: 900;
      letter-spacing: -0.03em;
      text-decoration: none;
    }
    .wordmark-blue { color: #0284C7; }
    .wordmark-gold { color: #F59E0B; }
    .subtag {
      display: inline-block;
      margin-top: 10px;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #38BDF8;
      background: rgba(2, 132, 199, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.3);
      padding: 4px 14px;
      border-radius: 9999px;
    }
    .content {
      padding: 36px 32px;
    }
    .greeting {
      font-size: 17px;
      font-weight: 700;
      color: #0F172A;
      margin: 0 0 14px;
    }
    .body-text {
      font-size: 14px;
      line-height: 1.65;
      color: #475569;
      margin: 0 0 24px;
    }
    .metrics-card {
      background: #F8FAFC;
      border: 1px solid #E2E8F0;
      border-radius: 20px;
      padding: 22px 20px;
      margin-bottom: 28px;
      display: flex;
      justify-content: space-around;
      text-align: center;
    }
    .metric-item {
      flex: 1;
    }
    .metric-value {
      font-size: 26px;
      font-weight: 900;
      color: #0F172A;
    }
    .metric-label {
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #64748B;
      margin-top: 4px;
    }
    .cta-btn {
      display: block;
      text-align: center;
      background: #0284C7;
      color: #FFFFFF !important;
      font-weight: 800;
      font-size: 14px;
      text-decoration: none;
      padding: 16px 28px;
      border-radius: 16px;
      box-shadow: 0 10px 20px -5px rgba(2, 132, 199, 0.35);
      transition: background 0.2s ease;
    }
    .footer {
      background: #F8FAFC;
      border-top: 1px solid #E2E8F0;
      padding: 24px 32px;
      text-align: center;
      font-size: 11px;
      line-height: 1.6;
      color: #94A3B8;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="wordmark">
        <span class="wordmark-blue">SKILL-</span><span class="wordmark-gold">TRACK</span>
      </div>
      <div class="subtag">Daily Practice Reminder</div>
    </div>
    <div class="content">
      <p class="greeting">Hey ${userName},</p>
      <p class="body-text">
        Keep your learning momentum going! You have an active streak to protect in <strong>${skillOrSportName}</strong>. Consistent daily execution is the cornerstone of procedural mastery.
      </p>

      <table width="100%" cellpadding="0" cellspacing="0" class="metrics-card">
        <tr>
          <td align="center" style="border-right: 1px solid #E2E8F0; padding: 0 10px;">
            <div class="metric-value">🔥 ${streakDays}</div>
            <div class="metric-label">Streak Days</div>
          </td>
          <td align="center" style="padding: 0 10px;">
            <div class="metric-value">⏱️ ${targetDailyTime}</div>
            <div class="metric-label">Daily Target</div>
          </td>
        </tr>
      </table>

      <a href="${ctaLink}" class="cta-btn" target="_blank">Launch Workspace ➔</a>
    </div>
    <div class="footer">
      You received this because daily reminders are active for your account.<br>
      Update preferences anytime in your Profile Settings.<br>
      © 2026 SKILL-TRACK Autonomous Pedagogy Engine.
    </div>
  </div>
</body>
</html>
    `;

    const mailer = await getEmailTransporter();
    const info = await mailer.sendMail({
      from: process.env.SMTP_FROM || '"SKILL-TRACK" <reminders@skillprax.com>',
      to,
      subject: `Time for your daily SKILL-TRACK milestone in ${skillOrSportName}! 🔥`,
      html: htmlContent,
    });

    console.log(`[EmailService] Reminder sent to ${to}: ${info.messageId || 'STREAM_LOG'}`);
    return { success: true, messageId: info.messageId };
  } catch (err: any) {
    console.error('[EmailService] Dispatch failure:', err);
    return { success: false, error: err.message };
  }
}
