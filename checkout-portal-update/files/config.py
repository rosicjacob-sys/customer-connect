from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # Database
    DB_HOST: str = "127.0.0.1"
    DB_PORT: int = 3306
    DB_NAME: str = "checkout_db"
    DB_DIALECT: str = "mysql"
    DB_USER: str = "checkout_user"
    DB_PASSWORD: str = ""

    # Full connection string (Neon/Render convention). If set it wins over
    # DB_HOST/DB_PORT/... above — DATABASE_URL/DATABASE_URL_SYNC normalize
    # its scheme to the right async/sync driver for whichever dialect it
    # declares, and translate Neon's sslmode= for asyncpg (see below).
    # e.g. postgres://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
    DB_URL: str = ""

    # App
    SECRET_KEY: str = "changeme"
    ENVIRONMENT: str = "production"
    BASE_URL: str = "https://checkout.yourdomain.com"

    # Redis
    REDIS_URL: str = "redis://127.0.0.1:6379/0"

    # Helcim
    HELCIM_API_TOKEN: str = ""
    HELCIM_API_URL: str = "https://api.helcim.com/v2"

    # BTCPay
    BTCPAY_URL: str = ""
    BTCPAY_API_KEY: str = ""
    BTCPAY_STORE_ID: str = ""
    BTCPAY_WEBHOOK_SECRET: str = ""

    RESEND_API_KEY: str = ""

    # Gmail
    GMAIL_CREDENTIALS_FILE: str = "./gmail_credentials.json"
    GMAIL_TOKEN_FILE: str = "./gmail_token.json"
    GMAIL_WATCH_EMAIL: str = ""

    # Interac / Zelle
    INTERAC_DEFAULT_EMAIL: str = ""
    ZELLE_DEFAULT_EMAIL: str = ""

    # Default brand accent color — used only when a store has no Brand row,
    # its accent_color is empty, AND no ?accent= query param was passed by
    # the store's theme. Neutral dark green, not an alarm-red default.
    DEFAULT_ACCENT_COLOR: str = "#0b3d2c"
    DEFAULT_ACCENT_HOVER: str = "#082c20"

    ADMIN_USERNAME: str = ""
    ADMIN_PASSWORD: str = ""

    BRIDGE_SECRET: str = ""
    BRIDGE_URL: str = "https://bridge-7.flystarcafe7.workers.dev/s2s"
    BRIDGE_SECRET_US: str = ""
    BRIDGE_URL_US:    str = ""

    SHOPIFY_STORE_DOMAIN: str = ""
    SHOPIFY_API_TOKEN: str = ""
    SHOPIFY_STORE_DOMAIN_US: str = ""
    SHOPIFY_API_TOKEN_US: str = ""
    SHOPIFY_WEBHOOK_SECRET: str = ""

    MPC_CHECKOUT_SHOP:  str = ""
    MPC_CHECKOUT_TOKEN: str = ""
    STORE_1_SHOP:       str = ""
    STORE_1_TOKEN:      str = ""

    MPC_WEBHOOK_SECRET:     str = ""
    STORE_1_WEBHOOK_SECRET: str = ""
    FROPEP_CHECKOUT_SHOP: str = ""
    FROPEP_CHECKOUT_TOKEN: str = ""
    FROPEP_WEBHOOK_SECRET: str = ""
    LUKPEP_CHECKOUT_SHOP: str = ""
    LUKPEP_CHECKOUT_TOKEN: str = ""
    LUKPEP_WEBHOOK_SECRET: str = ""
    TOPPEP_CHECKOUT_SHOP: str = ""
    TOPPEP_CHECKOUT_TOKEN: str = ""
    TOPPEP_WEBHOOK_SECRET: str = ""
    CANPEP_CHECKOUT_SHOP: str = ""
    CANPEP_CHECKOUT_TOKEN: str = ""
    CANPEP_WEBHOOK_SECRET: str = ""
    CRAPEP_CHECKOUT_SHOP: str = ""
    CRAPEP_CHECKOUT_TOKEN: str = ""
    CRAPEP_WEBHOOK_SECRET: str = ""
    SAKPEP_CHECKOUT_SHOP: str = ""
    SAKPEP_CHECKOUT_TOKEN: str = ""
    SAKPEP_WEBHOOK_SECRET: str = ""
    PLUPEP_CHECKOUT_SHOP: str = ""
    PLUPEP_CHECKOUT_TOKEN: str = ""
    PLUPEP_WEBHOOK_SECRET: str = ""
    LIPEP_CHECKOUT_SHOP: str = ""
    LIPEP_CHECKOUT_TOKEN: str = ""
    LIPEP_WEBHOOK_SECRET: str = ""
    MAXPEP_CHECKOUT_SHOP: str = ""
    MAXPEP_CHECKOUT_TOKEN: str = ""
    MAXPEP_WEBHOOK_SECRET: str = ""
    COLPEP_CHECKOUT_SHOP: str = ""
    COLPEP_CHECKOUT_TOKEN: str = ""
    COLPEP_WEBHOOK_SECRET: str = ""
    JAMPEP_CHECKOUT_SHOP: str = ""
    JAMPEP_CHECKOUT_TOKEN: str = ""
    JAMPEP_WEBHOOK_SECRET: str = ""
    SWOPEP_CHECKOUT_SHOP: str = ""
    SWOPEP_CHECKOUT_TOKEN: str = ""
    SWOPEP_WEBHOOK_SECRET: str = ""

    # NowPayments
    NOWPAYMENTS_API_KEY:     str = ""
    NOWPAYMENTS_IPN_SECRET:  str = ""
    NOWPAYMENTS_SUCCESS_URL: str = ""
    # Master kill-switch for the "Altcoins" payment option (NowPayments). Set
    # to False to hide it from the checkout without wiping API keys.
    ALTCOIN_ENABLED:         bool = True

    # Polling
    INTERAC_POLL_INTERVAL: int = 300

    # Order expiration
    ORDER_EXPIRY_CARD_MINUTES:    int = 60
    ORDER_EXPIRY_CRYPTO_MINUTES:  int = 60
    ORDER_EXPIRY_INTERAC_MINUTES: int = 2880

    # Affiliate dashboard
    AFFILIATE_DASHBOARD_URL: str = "https://peps-affiliate.onrender.com"

    # Card-enabled stores (comma-separated source domains) — legacy fallback
    # when no per-store row exists in STORE_CONFIG_CSV.
    CARD_ENABLED_STORES: str = ""

    # Per-source-store payment-method config (CSV file). See
    # services/store_config.py for format details. If the file doesn't
    # exist, gating falls back to the global env flags below.
    STORE_CONFIG_CSV: str = "data/source_stores.csv"

    # Per-store shipping-fee opt-in for the new-ca checkout design
    # (checkout-new-ca.html) only — separate file from STORE_CONFIG_CSV
    # above, see services/new_ca_store_config.py. No global default: a
    # store not listed here has shipping fee off on new-ca.
    NEW_CA_STORE_CONFIG_CSV: str = "data/new_ca_stores.csv"

    # Flat sub-$100 shipping fee. Off by default: only stores with
    # shipping_fee=1 in STORE_CONFIG_CSV charge it. Flip to true to enable
    # for every store without a per-store row value.
    SHIPPING_FEE_DEFAULT: bool = False

    # Shopify Payment Bridge — WordPress/WooCommerce plugin that creates a
    # Shopify-hosted checkout (real Shopify Payments) for a card order.
    # Same layering as shipping_fee: SHOPIFY_PROCESSOR_ENABLED is the global
    # default, the _US/_CA flags let it default on for one country only, and
    # a shopify_processor=1/0 row in STORE_CONFIG_CSV overrides either.
    SHOPIFY_PROCESSOR_ENABLED:    bool = False
    SHOPIFY_PROCESSOR_ENABLED_US: bool = False
    SHOPIFY_PROCESSOR_ENABLED_CA: bool = False
    SHOPIFY_PROCESSOR_WP_URL:        str = ""   # e.g. https://bridge.example.com
    SHOPIFY_PROCESSOR_SHARED_SECRET: str = ""   # matches wp-config.php SPB_CHECKOUT_SHARED_SECRET

    # The pool of Shopify stores this processor round-robins across — one
    # WordPress bridge site holds Admin API credentials for all of them, we
    # just pick which one handles each checkout (see services/
    # shopify_rotation.py: always the enabled store that's gone longest
    # since its last transaction, so each one naturally gets ~1 txn per
    # "week" when there are ~7 stores or order volume is low, but rotation
    # never blocks a customer if volume is higher than that).
    # Comma-separated myshopify.com domains, e.g.:
    #   SHOPIFY_PROCESSOR_STORE_KEYS=store-a.myshopify.com,store-b.myshopify.com,store-c.myshopify.com
    SHOPIFY_PROCESSOR_STORE_KEYS: str = ""

    # Each store in the pool above also needs its own webhook secret so
    # routes/webhooks.py can verify its orders/paid webhook — same
    # auto-detected <PREFIX>_CHECKOUT_SHOP / <PREFIX>_WEBHOOK_SECRET pattern
    # the other bridge stores use. The prefix can be anything; shop_domain
    # (the _CHECKOUT_SHOP value) is what actually gets matched, so it must
    # exactly match one of the domains listed in SHOPIFY_PROCESSOR_STORE_KEYS
    # above. Add one pair per store, e.g.:
    #   SPB_A_CHECKOUT_SHOP=store-a.myshopify.com
    #   SPB_A_WEBHOOK_SECRET=<secret from that store's Notifications → Webhooks page>
    #   SPB_B_CHECKOUT_SHOP=store-b.myshopify.com
    #   SPB_B_WEBHOOK_SECRET=<...>
    SPB_A_CHECKOUT_SHOP:  str = ""
    SPB_A_WEBHOOK_SECRET: str = ""
    SPB_B_CHECKOUT_SHOP:  str = ""
    SPB_B_WEBHOOK_SECRET: str = ""
    SPB_C_CHECKOUT_SHOP:  str = ""
    SPB_C_WEBHOOK_SECRET: str = ""

    # Stripe — for embedded checkout in modal
    STRIPE_PUBLISHABLE_KEY: str = ""    # pk_test_... (test) or pk_live_... (live)
    STRIPE_WORKER_URL:      str = "https://stripe-worker.flystarcafe7.workers.dev"

    # Helcim — worker URL for thank-you page order lookup
    HELCIM_WORKER_URL:      str = "https://hc-worker.flystarcafe7.workers.dev"

    # pymtz — credit card via hosted payment page (replaces bridge card flow).
    # Two merchant accounts: one for Canada (charged in USD via the 1.38
    # conversion shown on checkout) and one for the US. The country is
    # selected from order.currency: CAD→CA account, USD→US account. The legacy
    # single-account keys below are kept as fallbacks so a partially-configured
    # deploy still works.
    PYMTZ_API_KEY:        str = ""   # legacy / fallback if per-country unset
    PYMTZ_WEBHOOK_SECRET: str = ""   # legacy / fallback if per-country unset
    PYMTZ_API_KEY_CA:        str = ""   # pymtz_live_... for the Canada account
    PYMTZ_WEBHOOK_SECRET_CA: str = ""   # whsec_... for the Canada account
    PYMTZ_API_KEY_US:        str = ""   # pymtz_live_... for the US account
    PYMTZ_WEBHOOK_SECRET_US: str = ""   # whsec_... for the US account

    # Onramp via WordPress + 2530gateway plugin.
    # See services/onramp_wp.py for the architecture overview.
    ONRAMP_WP_ENABLED:         bool = False  # master kill-switch — flip to true to show the option
    ONRAMP_WP_URL:             str = ""   # e.g. http://23.137.251.62:8083 (no trailing /)
    ONRAMP_WP_CONSUMER_KEY:    str = ""   # ck_... from WC → Settings → Advanced → REST API (HTTPS only)
    ONRAMP_WP_CONSUMER_SECRET: str = ""   # cs_...
    # Application Password auth — preferred over WC REST keys when the
    # site is HTTP. Create at WP admin → Users → admin → Application Passwords.
    ONRAMP_WP_USERNAME:        str = ""   # WP username (e.g. "admin")
    ONRAMP_WP_APP_PASSWORD:    str = ""   # 24-char app password "aBcD eFgH ..."
    ONRAMP_WP_PRODUCT_ID:      str = ""   # leave blank to use fee_lines (no product needed)
    ONRAMP_WP_GATEWAY_ID:      str = ""   # leave blank for the default hosted gateway
    ONRAMP_WP_WEBHOOK_SECRET:  str = ""   # signing secret from the WC webhook config

    # Lasso — cloaked CC checkout via Whop payment rails
    LASSO_STORE_ID:           str = ""   # data-store-id from your Lasso merchant dashboard
    LASSO_CHECKOUT_URL:       str = ""   # set to https://pepscheckoutportal.com/pay for proxy mode
    LASSO_REAL_CHECKOUT_URL:  str = ""   # actual Lasso URL e.g. https://checkout.yourdomain.com/checkout
    LASSO_WHOP_SECRET:        str = ""   # webhook signing secret from Whop dashboard (legacy — fallback for /webhooks/whop)

    # Whop — direct embedded checkout (parallel option to the existing Card flow).
    # Each order creates a one-time checkout configuration with a per-order plan
    # at the customer's actual cart total. The plan title is cloaked so peptide
    # names never reach Whop.
    #
    # Production credentials (whop.com dashboard)
    WHOP_API_KEY:        str = ""  # Company API key from Whop dashboard → Developer → API Keys
    WHOP_COMPANY_ID:     str = ""  # biz_xxxxxxxxxxxxx — the Whop company that owns the plan
    WHOP_PRODUCT_ID:     str = ""  # prod_xxxxxxxxxxxxx — existing product to attach plans to (so dashboard Product column populates)
    WHOP_WEBHOOK_SECRET: str = ""  # whsec_... or ws_... — Developer → Webhooks → Signing secret

    # Sandbox credentials (sandbox.whop.com — completely separate from prod).
    # Only used when WHOP_SANDBOX=true. Leave blank if not testing in sandbox.
    WHOP_SANDBOX_API_KEY:        str = ""
    WHOP_SANDBOX_COMPANY_ID:     str = ""
    WHOP_SANDBOX_PRODUCT_ID:     str = ""
    WHOP_SANDBOX_WEBHOOK_SECRET: str = ""

    # Shared settings (same for both environments)
    WHOP_CURRENCY:       str = "cad"  # lowercase ISO 4217 — must match what Whop supports for this company
    WHOP_PLAN_TITLE:     str = "DigiTech SecureSync"  # cloaked title shown to customer on Whop checkout
    WHOP_RETURN_URL:     str = ""  # optional — leave blank to NOT send redirect_url to Whop (skip-redirect handles it)
    WHOP_SANDBOX:        bool = False  # True → use WHOP_SANDBOX_* credentials and route API calls to sandbox-api.whop.com

    # Master kill-switch for the Card (WHOP) payment option. Set to False to
    # hide the option from the checkout page AND reject any direct API calls
    # to /api/checkout/whop-embed, without having to wipe API keys or limits.
    # Useful for quick on/off without touching credentials.
    WHOP_ENABLED:        bool = True

    # Volume cap — refuse new Whop checkouts once this CAD amount has been
    # routed through Whop today (UTC day). Counts both pending and paid
    # orders so a flood of abandoned attempts also throttles us. Set to 0
    # to disable. Recommended: start at 100 week 1, ramp to 300.
    WHOP_DAILY_LIMIT: float = 300.0

    # Optional email sink — if set, customer emails sent to Whop are
    # rewritten to {user}+{order_id}@{domain}. NOTE: not recommended at
    # volume (pattern detection flag). Leave empty to pass the customer's
    # real email through (Whop's send_customer_emails=false handles
    # email suppression on Whop's side).
    WHOP_SINK_EMAIL: str = ""

    # ── Tier plans (big risk reducer for production volume) ─────────────
    # Instead of creating a new inline plan per order (→ 600+ unique plans
    # per month, bot-like pattern), pre-create N fixed-price plans in the
    # Whop dashboard and route each cart to the closest one. From Whop's
    # POV the account now looks like a normal SaaS pricing ladder.
    #
    # Format: comma-separated "price:plan_id" pairs (price in major units).
    # Example: WHOP_TIER_PLANS=49:plan_aaa,99:plan_bbb,199:plan_ccc,299:plan_ddd
    # Leave empty to disable tiers and fall back to inline plan creation.
    WHOP_TIER_PLANS:         str = ""  # production tier plans
    WHOP_SANDBOX_TIER_PLANS: str = ""  # sandbox tier plans (different plan_ids)

    # How to map a cart total to a tier when tiers are configured:
    #   "round_down" — use the largest tier ≤ cart amount (customer pays
    #                  same or less than cart; you absorb any delta).
    #                  Safest UX — no surprise charges.
    #   "nearest"    — use whichever tier is closest (customer might pay
    #                  slightly more if cart is between two tiers).
    #   "round_up"   — use smallest tier ≥ cart amount (customer always
    #                  pays same or more). Margin gain but dispute risk.
    # If cart is outside the tier range (smaller than smallest or larger
    # than largest), falls back to inline plan creation for that one order.
    WHOP_TIER_STRATEGY: str = "round_down"

    # ─── Deep2K analytics ───────────────────────────────────────────────
    # Blank disables cleanly — deep2k.py no-ops without URL/secret.
    DEEP2K_API_URL: str = ""
    DEEP2K_SITE_ID: str = ""
    DEEP2K_CHECKOUT_SECRET: str = ""
    DEEP2K_PAYMENT_SECRET: str = ""
    DEEP2K_CUSTOMER_IDENTITY_SECRET: str = ""

    # ─── Customer Connect (email campaigns) ─────────────────────────────
    # Paid orders' customers are sent there (services/customer_connect.py).
    # Blank disables cleanly. The secret must equal Customer Connect's
    # CHECKOUT_PORTAL_SECRET.
    CUSTOMER_CONNECT_URL: str = ""
    CUSTOMER_CONNECT_SECRET: str = ""

    @property
    def DATABASE_URL(self) -> str:
        # DB_URL, if set, is a full connection string (Render/Neon convention)
        # — normalize its scheme to the async driver for whichever dialect
        # it declares, rather than assuming one. Takes priority over
        # DB_HOST/DB_PORT/DB_DIALECT below, which remain the VPS/staging path
        # (DB_URL is empty there, so this block is skipped entirely).
        url = (self.DB_URL or "").strip()
        if url:
            if url.startswith("postgres://"):
                url = url.replace("postgres://", "postgresql://", 1)
            if url.startswith("postgresql://"):
                url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
                # asyncpg's connect() takes `ssl`, not libpq's `sslmode` —
                # and SQLAlchemy passes URL query params straight through
                # as connect kwargs, so Neon's default `?sslmode=require`
                # would crash the engine at startup ("connect() got an
                # unexpected keyword argument 'sslmode'"). Translate it;
                # psycopg2 (the sync driver, below) understands sslmode
                # natively, so it needs no translation.
                if "sslmode=" in url:
                    url = url.replace("sslmode=", "ssl=")
                return url
            if url.startswith("mysql://"):
                return url.replace("mysql://", "mysql+aiomysql://", 1)
            return url
        if self.DB_DIALECT == "postgres":
            return f"postgresql+asyncpg://{self.DB_USER}:{self.DB_PASSWORD}@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
        return f"mysql+aiomysql://{self.DB_USER}:{self.DB_PASSWORD}@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"

    @property
    def DATABASE_URL_SYNC(self) -> str:
        # Sync driver — used by Alembic/any blocking tooling, not the app itself.
        url = (self.DB_URL or "").strip()
        if url:
            if url.startswith("postgres://"):
                url = url.replace("postgres://", "postgresql://", 1)
            if url.startswith("postgresql://"):
                return url.replace("postgresql://", "postgresql+psycopg2://", 1)
            if url.startswith("mysql://"):
                return url.replace("mysql://", "mysql+pymysql://", 1)
            return url
        if self.DB_DIALECT == "postgres":
            return f"postgresql+psycopg2://{self.DB_USER}:{self.DB_PASSWORD}@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
        return f"mysql+pymysql://{self.DB_USER}:{self.DB_PASSWORD}@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "allow"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()