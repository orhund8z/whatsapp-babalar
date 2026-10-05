from datetime import datetime, timezone

import pytest

from app.services.chat_import import ChatImportError, parse_export

ANDROID = """24.03.2025, 14:32 - Mesajlar ve aramalar uçtan uca şifrelidir.
24.03.2025, 14:33 - Ali: Münih'te iyi bir Ausländerbehörde randevusu nasıl alınır, bilen var mı?
ikinci satır devam ediyor
24.03.2025, 14:34 - Veli: <Media omitted>
24.03.2025, 14:35 - Veli: kısa
"""

IOS = """‎[24.03.25, 14:33:10] Ali: Münih'te iyi bir Ausländerbehörde randevusu nasıl alınır, bilen var mı?
[24.03.25, 2:34:00 PM] Veli: Bu mesaj silindi
"""


def test_parseExport_whenAndroidFormat_thenMultilineJoinedAndSkipsSystemAndMedia():
    result = parse_export(ANDROID)
    assert result.skipped_system == 1
    assert result.skipped_media == 1
    assert len(result.messages) == 2
    first = result.messages[0]
    assert first.sender_name == "Ali"
    assert first.content.endswith("ikinci satır devam ediyor")
    # 14:33 Berlin (CET, UTC+1 in March before DST on 30th) -> 13:33 UTC
    assert first.sent_at == datetime(2025, 3, 24, 13, 33, tzinfo=timezone.utc)


def test_parseExport_whenIosFormat_thenSecondsAndAmPmHandled():
    result = parse_export(IOS)
    assert result.skipped_media == 1
    assert result.messages[0].sent_at == datetime(2025, 3, 24, 13, 33, 10, tzinfo=timezone.utc)


def test_parseExport_whenNoRecognizedLines_thenRaises():
    with pytest.raises(ChatImportError):
        parse_export("hello\nworld")
