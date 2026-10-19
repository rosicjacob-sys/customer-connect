"""
"An order became paid" hook for Customer Connect.

Same approach as services/deep2k_hook.py: listen at the ORM layer, so every
path that marks an order paid (webhooks, Celery polls, admin manual
mark-paid, Interac/Zelle matching) is covered, present and future. When an
Order's payment_status changes to paid or manual and that change is
COMMITTED, a Celery task is queued to send the customer to Customer Connect.

Activated by importing this module once at startup (done from database.py).
Never raises into application code: a Customer Connect problem must never
break a sale. Does nothing while CUSTOMER_CONNECT_URL is blank.
"""
import logging

from sqlalchemy import event, inspect as sa_inspect
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

_PENDING_KEY = "_customer_connect_paid_order_ids"
_PAID = ("paid", "manual")


def _is_paid(value) -> bool:
    # payment_status may be a PaymentStatus str-enum or a plain string.
    return getattr(value, "value", value) in _PAID


def _enqueue(order_id: str) -> None:
    from services import customer_connect
    if not customer_connect.is_enabled():
        return
    from tasks.celery_app import report_paid_to_customer_connect
    report_paid_to_customer_connect.apply_async(args=[order_id])


@event.listens_for(Session, "before_flush")
def _cc_capture_paid(session, flush_context, instances):
    """Record ids of orders becoming paid while attribute history is intact."""
    try:
        from models.order import Order
    except Exception:
        return
    bucket = session.info.setdefault(_PENDING_KEY, set())
    for obj in session.dirty:
        if not isinstance(obj, Order):
            continue
        hist = sa_inspect(obj).attrs.payment_status.history
        if hist.added and _is_paid(hist.added[0]):
            was_paid = bool(hist.deleted) and _is_paid(hist.deleted[0])
            if not was_paid and getattr(obj, "id", None):
                bucket.add(obj.id)
    for obj in session.new:
        if isinstance(obj, Order) and _is_paid(getattr(obj, "payment_status", None)):
            if getattr(obj, "id", None):
                bucket.add(obj.id)


@event.listens_for(Session, "after_commit")
def _cc_dispatch_paid(session):
    """Only after the transaction is durably committed, so a rolled-back
    'paid' never reaches Customer Connect."""
    ids = session.info.pop(_PENDING_KEY, None)
    if not ids:
        return
    for order_id in ids:
        if not order_id:
            continue
        try:
            _enqueue(order_id)
        except Exception:
            logger.exception("customer_connect: could not enqueue %s", order_id)


@event.listens_for(Session, "after_rollback")
def _cc_clear(session):
    session.info.pop(_PENDING_KEY, None)
