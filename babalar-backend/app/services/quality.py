"""Cheap evidence checks; these measure literal support, not full faithfulness."""
import re
from decimal import Decimal

_URL = re.compile(r"https?://[^\s<>\"'()]+")
_NUMBER = re.compile(r"(?<![\w])\d+(?:[.,]\d+)?(?![\w])")


def evidence_scores(answer: str, context: str) -> dict[str, float]:
    def urls(text):
        return {url.rstrip(".,;:!?]") for url in _URL.findall(text)}

    def numbers(text):
        return {Decimal(number.replace(",", ".")).normalize() for number in _NUMBER.findall(text)}

    def supported(claims, evidence):
        return len(claims & evidence) / len(claims) if claims else 1.0

    return {"url_groundedness": supported(urls(answer), urls(context)),
            "number_groundedness": supported(numbers(answer), numbers(context))}
