import re

import pytest

from app.services.pii import first_name, scrub_text


@pytest.mark.parametrize("text", [
    "Ara beni +49 151 12345678 olursa",
    "0151 1234567 numaramdan yaz",
    "Tel: 089/12345678 arayın",
    "+90 532 123 45 67",
    "00491511234567",
])
def test_scrubText_whenPhoneNumber_thenRedacted(text):
    out = scrub_text(text)
    assert "[telefon]" in out
    assert not re.search(r"\d{5,}", out)


def test_scrubText_whenEmail_thenRedacted():
    assert scrub_text("mail: ali.veli+x@gmail.com yazın") == "mail: [e-posta] yazın"


def test_scrubText_whenIban_thenRedacted():
    assert "[iban]" in scrub_text("IBAN DE89 3704 0044 0532 0130 00 ye gönder")


def test_scrubText_whenWhatsappIdOrMention_thenRemoved():
    assert "491511234567" not in scrub_text("@491511234567 bakar mısın, 123456789012@lid de yazdı")


@pytest.mark.parametrize("text", [
    "Randevu 24.03.2025 14.30 civarı",
    "Kira 1.250 euro, depozito 2.500",
    "Saat 14:30'da Bürgeramt'ta olacağım",
    "Anmeldung için 3 hafta sonrasına randevu verdiler",
    "https://www.muenchen.de/rathaus/Stadtverwaltung",
])
def test_scrubText_whenNoPii_thenUnchanged(text):
    assert scrub_text(text) == text


@pytest.mark.parametrize("sender,expected", [
    ("Ali Yılmaz", "Ali"),
    ("~ Ayşe Demir", "Ayşe"),
    ("Anna-Lena Müller", "Anna-Lena"),
    ("Mehmet", "Mehmet"),
    ("+49 151 12345678", None),
    ("491511234567@lid", None),
    ("ali@example.com", None),
    ("", None),
    (None, None),
])
def test_firstName_whenSender_thenFirstNameOrNone(sender, expected):
    assert first_name(sender) == expected
