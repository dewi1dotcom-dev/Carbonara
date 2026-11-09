"""Outgoing e-mail over SMTP (settings from the environment)."""

from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from .config import settings


class MailError(RuntimeError):
    pass


def is_configured() -> bool:
    return bool(settings.smtp_host and (settings.smtp_from or settings.smtp_user))


def send(to: str, subject: str, body: str, reply_to: str | None = None) -> None:
    if not is_configured():
        raise MailError("E-mail sending is not set up on the server (SMTP_HOST / SMTP_FROM)")
    msg = EmailMessage()
    msg["From"] = settings.smtp_from or formataddr(("Carbonara", settings.smtp_user))
    msg["To"] = to
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain="carbonara.local")
    if reply_to:
        msg["Reply-To"] = reply_to
    msg.set_content(body)
    try:
        context = ssl.create_default_context()
        if settings.smtp_security == "ssl":
            server = smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=20, context=context)
        else:
            server = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20)
        with server:
            if settings.smtp_security == "starttls":
                server.starttls(context=context)
            if settings.smtp_user:
                server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(msg)
    except (smtplib.SMTPException, OSError) as exc:
        raise MailError(f"Could not send the e-mail: {exc}") from exc
