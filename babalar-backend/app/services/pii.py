"""PII scrubbing for WhatsApp content before it is stored, embedded or sent to an LLM.

Removes phone numbers, e-mail addresses, IBANs and WhatsApp IDs from free text and reduces
sender names to a first name. Free-text names inside message bodies cannot be detected reliably
and are left untouched.
"""
import re

_EMAIL = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}(?![\w.-])")
_WA_ID = re.compile(r"\b\d+@(?:lid|c\.us|g\.us)\b")
_MENTION = re.compile(r"@\d{6,}")
_IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b")
# Digit runs joined by spaces and phone punctuation; judged by digit count in _redact_number
_NUMBER = re.compile(r"(?<![\w/])\+?\d[\d ()./-]{6,}\d(?!\w)")
_DATE = re.compile(r"\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b")
_MIN_DIGITS = 8


def _redact_number(match: re.Match) -> str:
    text = match.group(0)
    digits = re.sub(r"\D", "", _DATE.sub("", text))
    return "[telefon]" if len(digits) >= _MIN_DIGITS else text


def scrub_text(text: str) -> str:
    text = _WA_ID.sub("", text)
    text = _EMAIL.sub("[e-posta]", text)
    text = _IBAN.sub("[iban]", text)
    text = _MENTION.sub("@kişi", text)
    return _NUMBER.sub(_redact_number, text).strip()


def first_name(sender: str | None) -> str | None:
    """First name only; None when the sender is a phone number, e-mail or WhatsApp ID."""
    if not sender:
        return None
    name = sender.strip().lstrip("~").strip()
    if not name or "@" in name or re.search(r"\d{5,}", name):
        return None
    token = name.split()[0].strip(".,;:()[]")
    return token[:50] or None
