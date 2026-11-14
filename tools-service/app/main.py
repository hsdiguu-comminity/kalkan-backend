"""Kalkan güvenlik araçları servisi.

Araç router'ları (link, hash, password, email_header) app/routers/ altında yazılır ve
burada include_router ile eklenir. Bu servis bildirilen linklere yalnızca pasif kontrol yapar.
"""

from fastapi import FastAPI

app = FastAPI(title="Kalkan Tools Service", version="0.1.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "kalkan-tools-service"}


# Örnek: app.include_router(link.router, prefix="/tools/link", tags=["link"])
