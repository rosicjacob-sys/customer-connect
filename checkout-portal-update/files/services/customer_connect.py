"""
Customer Connect client: sends paid orders' customers to Customer Connect,
the email-campaign app, so they can get its promo emails.

What is sent per order: email, first/last name, phone, the storefront the
order came from (source_domain, falling back to the brand's domain), the
store name, and when it was paid. Customer Connect cleans the data and keeps
one customer per email, linked to the store of their latest order.

Design notes
------------
* Never on the payment path. Orders are queued by the ORM hook
  (services/customer_connect_hook.py) and sent by a Celery task, which
  retries while Customer Connect is unreachable. A failure here never
  blocks or fails a sale.
* Signed: X-CC-Timestamp + X-CC-Signature (hex HMAC-SHA256 of
  "<timestamp>.<body>") with the secret both apps share. The body is
  serialised once and those exact bytes are both signed and sent.
* Sending the same order twice is harmless: Customer Connect only keeps the
  latest store per customer.

Environment
-----------
CUSTOMER_CONNECT_URL     e.g. https://connect.yourdomain.com  (blank = off)
CUSTOMER_CONNECT_SECRET  must equal Customer Connect's CHECKOUT_PORTAL_SECRET
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Iterable

import httpx

from config import settings

logger = logging.getLogger(__name__)

_TIMEOUT = httpx.Timeout(20.0, connect=5.0)
BATCH_SIZE = 500


def is_enabled() -> bool:
    return bool(getattr(settings, "CUSTOMER_CONNECT_URL", "") and getattr(settings, "CUSTOMER_CONNECT_SECRET", ""))


def _iso(dt: datetime | None) -> str | None:
    """The portal stores naive datetimes; they are UTC."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat(timespec="seconds")


def order_payload(order: Any, brand_domain: str | None = None) -> dict[str, Any]:
    """One order → the fields Customer Connect needs. Cleaning (typos, test
    emails, checkout-portal domains) happens on the Customer Connect side."""
    return {
        "order_id": order.id,
        "email": (order.email or "").strip(),
        "first_name": (order.first_name or "").strip(),
        "last_name": (order.last_name or "").strip(),
        "phone": (order.phone or "").strip(),
        "store_domain": (getattr(order, "source_domain", None) or brand_domain or "").strip(),
        "store_name": (order.store_name or "").strip(),
        "paid_at": _iso(order.paid_at or order.created_at),
    }


def sign(body: bytes, timestamp: int, secret: str) -> str:
    return hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()


async def send_orders(payloads: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """POST up to BATCH_SIZE orders. Raises on any failure so the caller
    (Celery task or backfill script) can retry."""
    orders = list(payloads)
    if not orders:
        return {"received": 0}
    if not is_enabled():
        raise RuntimeError("Customer Connect is not configured (CUSTOMER_CONNECT_URL / CUSTOMER_CONNECT_SECRET)")
    body = json.dumps({"orders": orders}, separators=(",", ":"), ensure_ascii=False).encode()
    ts = int(time.time())
    url = settings.CUSTOMER_CONNECT_URL.rstrip("/") + "/api/ingest/checkout"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(url, content=body, headers={
            "Content-Type": "application/json",
            "X-CC-Timestamp": str(ts),
            "X-CC-Signature": sign(body, ts, settings.CUSTOMER_CONNECT_SECRET),
        })
    if resp.status_code >= 300:
        raise RuntimeError(f"Customer Connect answered {resp.status_code}: {resp.text[:300]}")
    return resp.json()


async def load_paid_order_payloads(db, order_ids: list[str]) -> list[dict[str, Any]]:
    """Paid orders by id, with the brand's domain as a fallback store."""
    from sqlalchemy import select
    from models.brand import Brand
    from models.order import Order, PaymentStatus

    result = await db.execute(
        select(Order, Brand.domain)
        .join(Brand, Brand.id == Order.brand_id, isouter=True)
        .where(Order.id.in_(order_ids))
        .where(Order.payment_status.in_([PaymentStatus.paid, PaymentStatus.manual]))
    )
    return [order_payload(order, brand_domain) for order, brand_domain in result.all()]
