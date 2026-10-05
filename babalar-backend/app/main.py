import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.observability import langfuse
from app.api import auth, chat, admin, ingest
from contextlib import asynccontextmanager
import asyncio

APP_VERSION = os.getenv("APP_VERSION", "dev")

@asynccontextmanager
async def lifespan(app):
    yield
    await asyncio.to_thread(langfuse.flush)


app = FastAPI(title="Babalar API", version=APP_VERSION, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(chat.router)
app.include_router(admin.router)
app.include_router(ingest.router)


@app.get("/health")
async def health():
    return {"status": "ok", "version": APP_VERSION}


@app.get("/api/health")
async def api_health():
    return {"status": "ok", "version": APP_VERSION}
