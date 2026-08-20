import os
import smtplib
from dotenv import load_dotenv

load_dotenv()
sender = os.getenv("GMAIL_SENDER")
pw = os.getenv("GMAIL_APP_PASSWORD")

print(f"Sender loaded: {bool(sender)}")
print(f"App password loaded: {bool(pw)}, length: {len(pw) if pw else 0}")

smtp = smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30)
smtp.set_debuglevel(1)
smtp.login(sender, pw)
print("LOGIN OK")
smtp.quit()