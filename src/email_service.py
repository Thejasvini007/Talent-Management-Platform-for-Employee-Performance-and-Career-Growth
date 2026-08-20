import os
import time
import smtplib
from email.message import EmailMessage
from html import escape


def send_welcome_email(
    recipient_email,
    name,
    employee_id,
    password,
    login_url,
):
    sender_email = os.getenv("GMAIL_SENDER")
    app_password = os.getenv("GMAIL_APP_PASSWORD")

    if not sender_email:
        raise RuntimeError("GMAIL_SENDER is missing.")
    if not app_password:
        raise RuntimeError("GMAIL_APP_PASSWORD is missing.")

    msg = EmailMessage()
    msg["Subject"] = "Welcome to Talent Sphere Elevate"
    msg["From"] = sender_email
    msg["To"] = recipient_email

    msg.set_content(
        f"""Welcome aboard, {name}!

Your training account has been created by your administrator.

YOUR LOGIN CREDENTIALS
Username / Email: {recipient_email}
Temporary Password: {password}
Employee ID: {employee_id}

Sign in to Talent Sphere Elevate:
{login_url}

CONFIDENTIALITY NOTICE
These credentials are personal and confidential. Do not share them with anyone else.

Regards,
Talent Sphere Elevate
"""
    )

    html_content = f"""
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Welcome to Talent Sphere Elevate</title>
</head>
<body style="margin:0; padding:0; background:#F5F6F8; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#FFFFFF; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(190,24,93,0.08); border:1px solid #F3E2E9;">

          <tr>
            <td style="background:linear-gradient(135deg,#EC4899 0%,#BE185D 55%,#9D174D 100%); padding:36px 40px;">
              <div style="width:48px; height:48px; background:rgba(255,255,255,0.18); border-radius:14px; display:inline-block; text-align:center; line-height:48px; font-size:22px; margin-bottom:14px;">🚀</div>
              <div style="color:#FFFFFF; font-size:22px; font-weight:800; letter-spacing:-0.02em;">Talent Sphere Elevate</div>
              <div style="color:rgba(255,255,255,0.85); font-size:13px; margin-top:4px; letter-spacing:0.02em; text-transform:uppercase;">AI Training Platform</div>
            </td>
          </tr>

          <tr>
            <td style="padding:40px;">
              <h2 style="margin:0 0 8px; font-size:20px; color:#231216; font-weight:700;">Welcome aboard, {escape(str(name))} 👋</h2>
              <p style="margin:0 0 24px; font-size:14px; color:rgba(35,18,26,0.62); line-height:1.6;">
                Your training account has been created by your administrator. Use the credentials below to sign in and begin your learning journey.
              </p>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FDF6F8; border-left:4px solid #BE185D; border-radius:10px; padding:4px;">
                <tr><td style="padding:20px 24px;">
                  <div style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#BE185D; margin-bottom:14px;">Your Login Credentials</div>

                  <div style="margin-bottom:12px;">
                    <div style="font-size:11px; color:rgba(35,18,26,0.55); margin-bottom:2px;">Username / Email</div>
                    <div style="font-size:14px; font-weight:600; color:#231216;">{escape(str(recipient_email))}</div>
                  </div>

                  <div style="margin-bottom:12px;">
                    <div style="font-size:11px; color:rgba(35,18,26,0.55); margin-bottom:2px;">Temporary Password</div>
                    <div style="font-size:14px; font-weight:600; color:#231216; font-family:ui-monospace,Consolas,monospace;">{escape(str(password))}</div>
                  </div>

                  <div>
                    <div style="font-size:11px; color:rgba(35,18,26,0.55); margin-bottom:2px;">Employee ID</div>
                    <div style="font-size:14px; font-weight:600; color:#231216;">{escape(str(employee_id))}</div>
                  </div>
                </td></tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px;">
                <tr><td align="center">
                  <a href="{escape(str(login_url), quote=True)}" style="display:inline-block; background:linear-gradient(135deg,#EC4899 0%,#BE185D 55%,#9D174D 100%); color:#FFFFFF; text-decoration:none; font-size:14px; font-weight:700; padding:14px 36px; border-radius:24px; box-shadow:0 4px 14px rgba(190,24,93,0.3);">
                    Sign in to Talent Sphere Elevate
                  </a>
                </td></tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px; background:#FFF9EB; border-radius:10px;">
                <tr><td style="padding:16px 20px;">
                  <div style="font-size:12px; font-weight:700; color:#8A6116; margin-bottom:4px;">🔒 Confidentiality Notice</div>
                  <div style="font-size:12.5px; color:#8A6116; line-height:1.5;">
                    These credentials are personal and confidential. Do not share them with anyone else. Please keep your account information secure.
                  </div>
                </td></tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 40px; border-top:1px solid #F3E2E9; text-align:center;">
              <div style="font-size:12px; color:rgba(35,18,26,0.45);">Talent Sphere Elevate &middot; AI-powered training &amp; knowledge platform</div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
"""

    msg.add_alternative(html_content, subtype="html")

    last_error = None
    for attempt in range(1, 4):  # try up to 3 times
        try:
            with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
                smtp.login(sender_email, app_password)
                smtp.send_message(msg)
            return  # success — stop retrying
        except smtplib.SMTPAuthenticationError as e:
            raise RuntimeError(
                "Gmail authentication failed. Check GMAIL_SENDER and GMAIL_APP_PASSWORD."
            ) from e
        except (smtplib.SMTPException, OSError) as e:
            last_error = e
            if attempt < 3:
                time.sleep(2)  # brief pause before retrying
                continue

    raise RuntimeError(
        f"Gmail SMTP error after {attempt} attempts: {last_error}"
    ) from last_error