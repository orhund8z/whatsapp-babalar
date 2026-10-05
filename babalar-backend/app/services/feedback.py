import uuid
from datetime import datetime, timedelta, timezone

from jose import jwt, JWTError

from app.config import settings


def feedback_token(trace_id: str, user_id: str) -> str:
    return jwt.encode({"type": "feedback", "trace_id": trace_id, "sub": user_id,
                       "exp": datetime.now(timezone.utc) + timedelta(days=7)}, settings.jwt_secret, algorithm="HS256")


def verify_feedback(token: str, trace_id: str, user_id: str) -> bool:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
        return payload.get("type") == "feedback" and payload.get("sub") == user_id and payload.get("trace_id") == trace_id
    except JWTError:
        return False


def feedback_score_id(trace_id: str, user_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"babalar:user-thumbs:{trace_id}:{user_id}"))
