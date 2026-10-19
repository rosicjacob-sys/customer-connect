# Checkout portal → Customer Connect

This update makes the checkout portal send every paid order's customer to Customer Connect, the email-campaign app, so they can get its promo emails.

## What it does

- When an order becomes **paid** or **manual** (on any path: webhooks, Celery polls, admin mark-paid, Interac/Zelle), and that change is committed, a Celery task sends the customer to Customer Connect: email, first and last name, phone, the storefront the order came from (`source_domain`, falling back to the brand's domain), the store name, and when it was paid.
- It hooks in the same way as the existing Deep2K report (`services/deep2k_hook.py`), so no payment path is missed.
- **It never touches the payment path.** Sending happens in Celery after the commit. If Customer Connect is down, the task retries after 1, 2, 4 … 64 minutes; nothing slows down or fails a checkout.
- Pending and abandoned checkouts are not sent. Neither are orders that are rolled back.
- Requests are signed with a secret both apps share (HMAC-SHA256, valid for 5 minutes). The portal's database stays closed to the internet.
- With `CUSTOMER_CONNECT_URL` blank (the default), it does nothing.

Customer Connect does the cleaning: it fixes email typos, drops test emails, made-up domains and `pepscheckoutportal.com` / `myshopify.com` store addresses, and keeps one customer per email, linked to the store of their latest order.

## Files

| File | |
|---|---|
| `services/customer_connect.py` | new: builds and signs the request |
| `services/customer_connect_hook.py` | new: notices orders becoming paid |
| `scripts/customer_connect_backfill.py` | new: sends past orders once |
| `tasks/celery_app.py` | adds the `report_paid_to_customer_connect` task (at the end) |
| `database.py` | imports the hook, next to the Deep2K one |
| `config.py` | adds `CUSTOMER_CONNECT_URL` and `CUSTOMER_CONNECT_SECRET` |

`customer-connect.patch` holds the same changes as a patch against the code you sent (checked: it applies cleanly). `files/` holds the complete changed files, if you'd rather copy them over.

## Apply

On the portal server, in the `checkout-server` directory:

```bash
patch -p1 < customer-connect.patch          # or copy files/ over the same paths
```

Add to `.env` (the secret must equal Customer Connect's `CHECKOUT_PORTAL_SECRET`):

```
CUSTOMER_CONNECT_URL=https://your-customer-connect-address
CUSTOMER_CONNECT_SECRET=the-shared-secret
```

Restart both, since the hook runs in the web app and the sending runs in the worker:

```bash
systemctl restart checkout-api checkout-worker
```

No database migration and no new Python packages (it uses `httpx`, which the portal already has).

## Send past orders, once

```bash
venv/bin/python scripts/customer_connect_backfill.py --all --dry-run   # count only
venv/bin/python scripts/customer_connect_backfill.py --all
```

Or a date range: `--since 2026-01-01 --until 2026-10-18`. It sends 500 orders per request, retries on errors, and prints what Customer Connect saved and what it left out. Safe to run more than once.

## Check it works

- Customer Connect → Settings → **Checkout portal** shows the last order received and the totals.
- The portal's worker log shows `[customer_connect] send failed …` if it can't reach Customer Connect (it keeps retrying).

## Turn it off

Blank `CUSTOMER_CONNECT_URL` and restart. Or reverse the patch: `patch -R -p1 < customer-connect.patch`.

## Tested

The hook and client were run for real (Python, SQLAlchemy 2) against a live Customer Connect: a pending order is not sent; becoming paid sends once; paid again, or paid then manual, sends nothing; an order created already paid is sent; a rolled-back payment is not sent; the signature is accepted, and a wrong secret is refused; an order on `pepscheckoutportal.com` is refused with a reason; Montreal on Oct 1 then Ottawa on Oct 2 leaves the customer at Ottawa, and re-sending the Oct 1 order doesn't move them back. What wasn't run here: the full portal app with MySQL and Celery. Try it on staging first, or watch the worker log after deploying.
