"""
Send past paid orders' customers to Customer Connect, once, so its customer
list starts complete. New paid orders are sent automatically by the hook in
services/customer_connect_hook.py; this is only for the orders before it.

Safe to run more than once: Customer Connect keeps one customer per email,
linked to the store of their latest order, whatever order they arrive in.

Needs CUSTOMER_CONNECT_URL and CUSTOMER_CONNECT_SECRET in the environment,
and the same database settings as the app.

Usage, from the checkout-server directory:

    python scripts/customer_connect_backfill.py --all
    python scripts/customer_connect_backfill.py --since 2026-01-01
    python scripts/customer_connect_backfill.py --since 2026-10-01 --until 2026-10-18
    python scripts/customer_connect_backfill.py --all --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select  # noqa: E402

from database import AsyncSessionLocal  # noqa: E402
from models.brand import Brand  # noqa: E402
from models.order import Order, PaymentStatus  # noqa: E402
from services import customer_connect  # noqa: E402

PAID = (PaymentStatus.paid, PaymentStatus.manual)


def _day(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d")


async def run(since: datetime | None, until: datetime | None, dry_run: bool) -> None:
    if not dry_run and not customer_connect.is_enabled():
        sys.exit("Set CUSTOMER_CONNECT_URL and CUSTOMER_CONNECT_SECRET first.")
    totals = {"orders": 0, "saved": 0, "added": 0, "storeChanged": 0, "notSaved": 0}
    last_key: tuple[datetime, str] | None = None

    async with AsyncSessionLocal() as db:
        while True:
            q = (select(Order, Brand.domain)
                 .join(Brand, Brand.id == Order.brand_id, isouter=True)
                 .where(Order.payment_status.in_(PAID))
                 .order_by(Order.created_at, Order.id)
                 .limit(customer_connect.BATCH_SIZE))
            if since:
                q = q.where(Order.created_at >= since)
            if until:
                q = q.where(Order.created_at < until + timedelta(days=1))
            if last_key:
                q = q.where((Order.created_at > last_key[0]) |
                            ((Order.created_at == last_key[0]) & (Order.id > last_key[1])))
            rows = (await db.execute(q)).all()
            if not rows:
                break
            last_key = (rows[-1][0].created_at, rows[-1][0].id)
            payloads = [customer_connect.order_payload(o, d) for o, d in rows]
            totals["orders"] += len(payloads)
            if dry_run:
                print(f"would send {len(payloads)} orders, up to {last_key[1]} ({last_key[0]})")
                continue
            for attempt in range(5):
                try:
                    result = await customer_connect.send_orders(payloads)
                    break
                except Exception as exc:  # network blip or Customer Connect restarting
                    if attempt == 4:
                        raise
                    wait = 5 * 2 ** attempt
                    print(f"  send failed ({exc}); retrying in {wait}s")
                    await asyncio.sleep(wait)
            for k in ("saved", "added", "storeChanged", "notSaved"):
                totals[k] += result.get(k, 0)
            print(f"sent {len(payloads)} orders up to {last_key[1]}: {result.get('saved', 0)} saved, "
                  f"{result.get('notSaved', 0)} not saved {result.get('dropped') or ''}")
    print("done:", totals)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--all", action="store_true", help="every paid order")
    p.add_argument("--since", type=_day, help="orders placed on or after YYYY-MM-DD")
    p.add_argument("--until", type=_day, help="orders placed on or before YYYY-MM-DD")
    p.add_argument("--dry-run", action="store_true", help="count, send nothing")
    a = p.parse_args()
    if not (a.all or a.since or a.until):
        p.error("say which orders: --all, or --since/--until")
    asyncio.run(run(a.since, a.until, a.dry_run))


if __name__ == "__main__":
    main()
