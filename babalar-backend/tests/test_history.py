import json
import unittest
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.database import Base
from app.models.models import AdminConfig, Message, WaGroup
from app.services.history import cancel_history, claim_history, finish_history, history_key, queue_history, recover_history


class HistoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda conn: Base.metadata.create_all(conn, tables=[WaGroup.__table__, Message.__table__, AdminConfig.__table__]))
        self.db = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.group = WaGroup(id=uuid.uuid4(), wa_group_id="123@g.us", group_name="Test", is_active=False,
                             last_ingested_at=datetime(2026, 10, 4, tzinfo=timezone.utc))
        self.db.add(self.group)
        self.db.add(Message(group_id=self.group.id, content="existing", sent_at=datetime(2026, 9, 4, tzinfo=timezone.utc)))
        await self.db.commit()

    async def asyncTearDown(self):
        await self.db.close()
        await self.engine.dispose()

    def result(self, job, **changes):
        data = dict(request_id=job["request_id"], error=None, before_at="2026-08-04T00:00:00+00:00",
                    before_id="msg-a", exhausted=False, scanned=250, saved=100)
        return SimpleNamespace(**{**data, **changes})

    async def test_pages_move_backwards_without_changing_forward_checkpoint(self):
        await queue_history(self.db, self.group.id, 250)
        with self.assertRaises(HTTPException) as error:
            await queue_history(self.db, self.group.id, 250)
        self.assertEqual(error.exception.status_code, 409)
        job = await claim_history(self.db)
        self.assertEqual(job["status"], "running")
        state = await finish_history(self.db, job["key"], self.result(job))
        self.assertEqual(state["before_id"], "msg-a")
        self.assertEqual(state["pages"], 1)
        next_job = await queue_history(self.db, self.group.id, 500)
        self.assertEqual(next_job["before_at"], "2026-08-04T00:00:00+00:00")
        self.assertFalse(self.group.is_active)
        self.assertEqual(self.group.last_ingested_at.month, 10)

    async def test_failure_and_restart_preserve_cursor_for_retry(self):
        queued = await queue_history(self.db, self.group.id, 250)
        job = await claim_history(self.db)
        state = await finish_history(self.db, job["key"], self.result(job, error="partial failure", saved=3))
        self.assertEqual(state["before_at"], queued["before_at"])
        self.assertEqual(state["saved"], 3)
        await queue_history(self.db, self.group.id, 250)
        await claim_history(self.db)
        await recover_history(self.db)
        row = await self.db.get(AdminConfig, history_key(self.group.id))
        self.assertEqual(json.loads(row.value)["status"], "error")

    async def test_exhaustion_can_be_rechecked_and_stale_results_are_rejected(self):
        await queue_history(self.db, self.group.id, 250)
        job = await claim_history(self.db)
        await finish_history(self.db, job["key"], self.result(job, exhausted=True))
        with self.assertRaises(HTTPException):
            await queue_history(self.db, self.group.id, 250)
        await queue_history(self.db, self.group.id, 250, recheck=True)
        next_job = await claim_history(self.db)
        with self.assertRaises(HTTPException) as error:
            await finish_history(self.db, next_job["key"], self.result(job))
        self.assertEqual(error.exception.status_code, 409)

    async def test_forward_cursor_is_rejected(self):
        await queue_history(self.db, self.group.id, 250)
        job = await claim_history(self.db)
        with self.assertRaises(HTTPException) as error:
            await finish_history(self.db, job["key"], self.result(job, before_at="2027-01-01T00:00:00Z"))
        self.assertEqual(error.exception.status_code, 422)

    async def test_queued_page_can_be_cancelled_without_moving_cursor(self):
        queued = await queue_history(self.db, self.group.id, 250)
        state = await cancel_history(self.db, self.group.id)
        self.assertEqual(state["status"], "idle")
        self.assertEqual(state["before_at"], queued["before_at"])
        self.assertIsNone(await claim_history(self.db))


if __name__ == "__main__":
    unittest.main()
