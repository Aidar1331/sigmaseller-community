-- Empty database bootstrap. Schema only; no customer or credential data.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.14 (Ubuntu 16.14-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: wb_price_daily(bigint, bigint, bigint, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wb_price_daily(p_workspace_id bigint, p_shop_id bigint, p_nm_id bigint, p_from date, p_to date) RETURNS TABLE(d date, price_kop integer, discount_pct integer, spp_pct integer, club_discount_pct integer)
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  WITH days AS (
    SELECT generate_series(p_from, p_to, INTERVAL '1 day')::date AS d
  ),
  events AS (
    SELECT date::date AS d,
           price, discount, spp, club_discount
    FROM wb_prices_history
    WHERE workspace_id = p_workspace_id
      AND shop_id     = p_shop_id
      AND nm_id       = p_nm_id
      AND date::date <= p_to
  ),
  locf AS (
    SELECT days.d,
           (
             SELECT price FROM events e
             WHERE e.d <= days.d
             ORDER BY e.d DESC LIMIT 1
           ) AS price,
           (
             SELECT discount FROM events e
             WHERE e.d <= days.d
             ORDER BY e.d DESC LIMIT 1
           ) AS discount,
           (
             SELECT spp FROM events e
             WHERE e.d <= days.d
             ORDER BY e.d DESC LIMIT 1
           ) AS spp,
           (
             SELECT club_discount FROM events e
             WHERE e.d <= days.d
             ORDER BY e.d DESC LIMIT 1
           ) AS club_discount
    FROM days
  )
  SELECT
    d,
    price::integer            AS price_kop,
    discount::integer         AS discount_pct,
    spp::integer              AS spp_pct,
    club_discount::integer    AS club_discount_pct
  FROM locf
  ORDER BY d;
$$;


--
-- Name: FUNCTION wb_price_daily(p_workspace_id bigint, p_shop_id bigint, p_nm_id bigint, p_from date, p_to date); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.wb_price_daily(p_workspace_id bigint, p_shop_id bigint, p_nm_id bigint, p_from date, p_to date) IS 'LOCF-resampled daily prices for a single (ws, shop, nm) triple over [from, to].';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ab_photo_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ab_photo_metrics (
    metric_id bigint NOT NULL,
    test_id bigint NOT NULL,
    phase_id bigint,
    variant text NOT NULL,
    date text NOT NULL,
    hour integer,
    views integer DEFAULT 0,
    opens integer DEFAULT 0,
    add_to_cart integer DEFAULT 0,
    orders integer DEFAULT 0,
    orders_rub bigint DEFAULT 0,
    buyouts integer DEFAULT 0,
    buyouts_rub bigint DEFAULT 0,
    ad_views integer DEFAULT 0,
    ad_clicks integer DEFAULT 0,
    ad_orders integer DEFAULT 0,
    ad_orders_rub bigint DEFAULT 0,
    ad_spend integer DEFAULT 0,
    ctr_bp integer DEFAULT 0,
    conversion_bp integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ab_photo_metrics_metric_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ab_photo_metrics ALTER COLUMN metric_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ab_photo_metrics_metric_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ab_photo_phases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ab_photo_phases (
    phase_id bigint NOT NULL,
    test_id bigint NOT NULL,
    variant text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    metrics_summary jsonb DEFAULT '{}'::jsonb,
    photos_synced boolean DEFAULT false
);


--
-- Name: ab_photo_phases_phase_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ab_photo_phases ALTER COLUMN phase_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ab_photo_phases_phase_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ab_photo_tests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ab_photo_tests (
    test_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    period_days integer DEFAULT 7 NOT NULL,
    goal text DEFAULT 'orders'::text NOT NULL,
    variant_a jsonb DEFAULT '{}'::jsonb NOT NULL,
    variant_b jsonb DEFAULT '{}'::jsonb NOT NULL,
    winner_variant text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    rotation_minutes integer DEFAULT 10080,
    min_photos integer DEFAULT 1,
    max_photos integer DEFAULT 4,
    current_variant text DEFAULT 'A'::text,
    last_rotated_at timestamp with time zone,
    auto_rotate boolean DEFAULT true,
    compare_ads_separately boolean DEFAULT true,
    shop_id bigint,
    variants jsonb DEFAULT '[]'::jsonb NOT NULL,
    name text,
    last_sync_error text,
    last_sync_error_at timestamp with time zone,
    original_photos jsonb DEFAULT '[]'::jsonb NOT NULL,
    test_photo_slot integer DEFAULT 0 NOT NULL,
    original_title text,
    original_description text,
    archived_at timestamp with time zone
);


--
-- Name: ab_photo_tests_test_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ab_photo_tests ALTER COLUMN test_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ab_photo_tests_test_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ab_photo_uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ab_photo_uploads (
    upload_id bigint NOT NULL,
    test_id bigint,
    workspace_id bigint NOT NULL,
    variant text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    original_filename text,
    stored_path text NOT NULL,
    url text,
    width integer,
    height integer,
    size_bytes bigint,
    mime_type text,
    is_synced_to_wb boolean DEFAULT false,
    synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ab_photo_uploads_upload_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ab_photo_uploads ALTER COLUMN upload_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ab_photo_uploads_upload_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_actions (
    action_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    conversation_id bigint,
    action_type text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    rationale text,
    result jsonb,
    executed_at timestamp with time zone,
    decided_by bigint,
    decided_at timestamp with time zone,
    decision_note text,
    event_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint,
    agent_name text,
    correlation_id uuid,
    verification_status text DEFAULT 'pending'::text,
    verification_attempts integer DEFAULT 0,
    agent_source text,
    idempotency_key text,
    retry_count integer DEFAULT 0 NOT NULL,
    last_error text,
    queued_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    next_retry_at timestamp with time zone,
    user_id bigint
);


--
-- Name: agent_actions_action_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.agent_actions ALTER COLUMN action_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.agent_actions_action_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_conversations (
    conversation_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    user_id bigint,
    agent_type text DEFAULT 'assistant'::text NOT NULL,
    title text,
    status text DEFAULT 'active'::text NOT NULL,
    thread_id text,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    error_message text,
    shop_id bigint
);


--
-- Name: agent_conversations_conversation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.agent_conversations ALTER COLUMN conversation_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.agent_conversations_conversation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_domain_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_domain_rules (
    rule_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    agent_name text NOT NULL,
    scope_type text DEFAULT 'global'::text NOT NULL,
    scope_value jsonb,
    rule_yaml text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_domain_rules_rule_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_domain_rules_rule_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_domain_rules_rule_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_domain_rules_rule_id_seq OWNED BY public.agent_domain_rules.rule_id;


--
-- Name: agent_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_events (
    event_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    event_type text NOT NULL,
    severity text DEFAULT 'info'::text NOT NULL,
    source text DEFAULT 'agent'::text NOT NULL,
    title text NOT NULL,
    description text,
    nm_id bigint,
    product_title text,
    suggested_action text,
    action_args jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    snoozed_until timestamp with time zone,
    applied_at timestamp with time zone,
    applied_by bigint,
    conversation_id bigint,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint,
    agent_source text,
    correlation_id uuid
);


--
-- Name: agent_events_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.agent_events ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.agent_events_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_execution_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_execution_runs (
    run_id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_name text NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    correlation_id uuid,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    tokens_input integer,
    tokens_output integer,
    cost_usd numeric(10,6),
    status text DEFAULT 'running'::text NOT NULL,
    input_snapshot jsonb,
    output jsonb,
    error text
);


--
-- Name: agent_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_locks (
    lock_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    locked_by text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: agent_locks_lock_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.agent_locks ALTER COLUMN lock_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.agent_locks_lock_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_messages (
    message_id bigint NOT NULL,
    conversation_id bigint NOT NULL,
    role text NOT NULL,
    content text,
    tool_calls jsonb,
    widget_type text,
    widget_props jsonb,
    sse_event_id text,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attachments jsonb
);


--
-- Name: agent_messages_message_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.agent_messages ALTER COLUMN message_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.agent_messages_message_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_run_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_run_results (
    run_id text NOT NULL,
    agent_name text NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    trigger text NOT NULL,
    status text NOT NULL,
    summary text,
    metrics jsonb,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);


--
-- Name: agent_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_settings (
    setting_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    auto_reply_positive boolean DEFAULT false,
    auto_reply_neutral boolean DEFAULT false,
    auto_reply_requires_approval boolean DEFAULT true,
    auto_price_protect_oos boolean DEFAULT false,
    min_margin_pct integer,
    max_price_change_pct integer DEFAULT 10,
    auto_bid_optimize boolean DEFAULT false,
    max_bid_rub bigint,
    telegram_chat_id text,
    telegram_critical boolean DEFAULT false,
    telegram_briefing boolean DEFAULT false,
    agent_model text,
    agent_max_tokens_per_day integer,
    pricing_enabled boolean DEFAULT false,
    pricing_mode text DEFAULT 'manual'::text,
    pricing_default_strategies jsonb DEFAULT '[]'::jsonb,
    reply_tone text DEFAULT 'friendly'::text,
    reply_cross_sell_frequency integer DEFAULT 3,
    reply_cross_sell_products jsonb DEFAULT '[]'::jsonb,
    reply_max_length integer DEFAULT 500,
    reply_forbidden_words jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: agent_settings_setting_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.agent_settings ALTER COLUMN setting_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.agent_settings_setting_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_supply_recommendations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_supply_recommendations (
    id bigint NOT NULL,
    run_id text NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    nm_id bigint NOT NULL,
    product_title text,
    current_stock integer NOT NULL,
    avg_daily_sales real NOT NULL,
    days_of_stock real,
    recommended_qty integer NOT NULL,
    urgency text NOT NULL,
    reason text,
    applied boolean DEFAULT false NOT NULL,
    applied_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    warehouse_id integer,
    warehouse_name text,
    expected_coefficient numeric(4,2),
    acceptance_cost_kop bigint,
    transit_cost_kop bigint,
    storage_cost_14d_kop bigint,
    expected_revenue_kop bigint,
    expected_roi_kop bigint,
    target_region text,
    recommended_at_for_date text
);


--
-- Name: agent_supply_recommendations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_supply_recommendations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_supply_recommendations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_supply_recommendations_id_seq OWNED BY public.agent_supply_recommendations.id;


--
-- Name: agent_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_tasks (
    task_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    conversation_id bigint NOT NULL,
    context_hash text NOT NULL,
    page text NOT NULL,
    filters jsonb DEFAULT '{}'::jsonb NOT NULL,
    summary jsonb,
    selected_items jsonb,
    message text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    error_message text,
    retry_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    shop_id bigint
);


--
-- Name: agent_tasks_task_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.agent_tasks ALTER COLUMN task_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.agent_tasks_task_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_verification_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_verification_checks (
    check_id uuid DEFAULT gen_random_uuid() NOT NULL,
    action_id bigint NOT NULL,
    shop_id bigint,
    check_type text NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    executed_at timestamp with time zone,
    result text,
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_provider_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_provider_settings (
    provider text NOT NULL,
    api_key text,
    base_url text,
    model text,
    prompt_price_per1m_micros bigint,
    completion_price_per1m_micros bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_type text
);


--
-- Name: ai_token_balance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_token_balance (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    balance_kopecks bigint DEFAULT 0 NOT NULL,
    max_budget_kopecks bigint,
    total_spent_kopecks bigint DEFAULT 0 NOT NULL,
    total_topped_up_kopecks bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_token_balance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ai_token_balance ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ai_token_balance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ai_token_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_token_transactions (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    user_id bigint NOT NULL,
    chat_message_id bigint,
    type character varying(20) DEFAULT 'usage'::character varying NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    cost_kopecks bigint DEFAULT 0 NOT NULL,
    raw_cost_kopecks bigint DEFAULT 0 NOT NULL,
    model character varying(50),
    tools_used text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_token_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ai_token_transactions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ai_token_transactions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ai_usage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_usage_events (
    usage_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    provider text NOT NULL,
    model text,
    prompt_tokens integer DEFAULT 0 NOT NULL,
    completion_tokens integer DEFAULT 0 NOT NULL,
    total_tokens integer DEFAULT 0 NOT NULL,
    cost_micros bigint DEFAULT 0 NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_usage_events_usage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.ai_usage_events ALTER COLUMN usage_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ai_usage_events_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    log_id bigint NOT NULL,
    workspace_id bigint,
    user_id bigint,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id text,
    details jsonb,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: audit_log_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ALTER COLUMN log_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.audit_log_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bidder_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bidder_actions (
    action_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    rule_id bigint,
    campaign_id bigint NOT NULL,
    action_type text NOT NULL,
    previous_value integer,
    new_value integer,
    reason text,
    context jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    error_text text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone
);


--
-- Name: bidder_actions_action_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.bidder_actions ALTER COLUMN action_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.bidder_actions_action_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bidder_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bidder_alerts (
    alert_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    campaign_id bigint,
    alert_type text NOT NULL,
    severity text DEFAULT 'warning'::text NOT NULL,
    title text NOT NULL,
    message text,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    notified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: bidder_alerts_alert_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.bidder_alerts ALTER COLUMN alert_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.bidder_alerts_alert_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bidder_keyword_auto_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bidder_keyword_auto_rules (
    rule_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    min_impressions integer DEFAULT 100 NOT NULL,
    min_days integer DEFAULT 7 NOT NULL,
    max_conversions integer DEFAULT 0 NOT NULL,
    max_drr_pct integer,
    min_ctr_pct integer,
    action text DEFAULT 'add_to_minus'::text NOT NULL,
    notify_only boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: bidder_keyword_auto_rules_rule_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.bidder_keyword_auto_rules ALTER COLUMN rule_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.bidder_keyword_auto_rules_rule_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bidder_keywords; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bidder_keywords (
    keyword_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    campaign_id bigint,
    keyword text NOT NULL,
    list_type text NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    reason text,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: bidder_keywords_keyword_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.bidder_keywords ALTER COLUMN keyword_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.bidder_keywords_keyword_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bidder_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bidder_rules (
    rule_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    name text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    campaign_ids bigint[],
    target_type text DEFAULT 'all'::text NOT NULL,
    rule_type text NOT NULL,
    conditions jsonb DEFAULT '{}'::jsonb NOT NULL,
    action_type text NOT NULL,
    action_value integer NOT NULL,
    min_bid integer DEFAULT 50 NOT NULL,
    max_bid integer DEFAULT 10000 NOT NULL,
    max_change_per_hour integer DEFAULT 500,
    active_hours jsonb,
    active_days jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bidder_rules_rule_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.bidder_rules ALTER COLUMN rule_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.bidder_rules_rule_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bidder_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bidder_settings (
    workspace_id bigint NOT NULL,
    is_enabled boolean DEFAULT false NOT NULL,
    check_interval_minutes integer DEFAULT 60 NOT NULL,
    global_min_bid integer DEFAULT 50 NOT NULL,
    global_max_bid integer DEFAULT 10000 NOT NULL,
    global_max_daily_spend integer,
    kill_switch_enabled boolean DEFAULT false NOT NULL,
    kill_switch_reason text,
    kill_switch_at timestamp with time zone,
    notify_telegram boolean DEFAULT false NOT NULL,
    telegram_chat_id text,
    notify_on_change boolean DEFAULT true NOT NULL,
    notify_on_error boolean DEFAULT true NOT NULL,
    last_run_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: cashflow_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cashflow_categories (
    category_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    parent_code text,
    type text NOT NULL,
    icon text,
    color text,
    is_system boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: cashflow_categories_category_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.cashflow_categories ALTER COLUMN category_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.cashflow_categories_category_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cashflow_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cashflow_entries (
    entry_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    date date NOT NULL,
    category text NOT NULL,
    description text,
    amount numeric(15,2) NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    source_id text,
    running_balance numeric(15,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: cashflow_entries_entry_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.cashflow_entries ALTER COLUMN entry_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.cashflow_entries_entry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cashflow_planned_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cashflow_planned_items (
    item_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    name text NOT NULL,
    category text NOT NULL,
    amount numeric(15,2) NOT NULL,
    is_recurring boolean DEFAULT false NOT NULL,
    recurrence_type text,
    recurrence_day integer,
    start_date date NOT NULL,
    end_date date,
    planned_date date,
    notes text,
    is_completed boolean DEFAULT false NOT NULL,
    completed_at timestamp with time zone,
    actual_amount numeric(15,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: cashflow_planned_items_item_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.cashflow_planned_items ALTER COLUMN item_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.cashflow_planned_items_item_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: cashflow_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cashflow_settings (
    workspace_id bigint NOT NULL,
    forecast_weeks integer DEFAULT 8 NOT NULL,
    include_planned boolean DEFAULT true NOT NULL,
    wb_payout_day integer DEFAULT 4 NOT NULL,
    wb_payout_delay_days integer DEFAULT 7 NOT NULL,
    alert_threshold numeric(15,2),
    alert_telegram boolean DEFAULT false NOT NULL,
    telegram_chat_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint,
    tax_rate_bp integer DEFAULT 600 NOT NULL
);


--
-- Name: COLUMN cashflow_settings.tax_rate_bp; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cashflow_settings.tax_rate_bp IS 'Ставка налогообложения в basis points. 600=6% УСН (default), 1500=15%, 0=без налога.';


--
-- Name: cashflow_wb_payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cashflow_wb_payouts (
    payout_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    report_id text NOT NULL,
    payout_date date NOT NULL,
    amount numeric(15,2) NOT NULL,
    sale_amount numeric(15,2),
    return_amount numeric(15,2),
    commission_amount numeric(15,2),
    delivery_amount numeric(15,2),
    penalty_amount numeric(15,2),
    storage_amount numeric(15,2),
    other_amount numeric(15,2),
    is_synced boolean DEFAULT false NOT NULL,
    synced_to_entry_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: cashflow_wb_payouts_payout_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.cashflow_wb_payouts ALTER COLUMN payout_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.cashflow_wb_payouts_payout_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: checkpoint_blobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checkpoint_blobs (
    thread_id text NOT NULL,
    checkpoint_ns text DEFAULT ''::text NOT NULL,
    channel text NOT NULL,
    version text NOT NULL,
    type text NOT NULL,
    blob bytea
);


--
-- Name: checkpoint_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checkpoint_migrations (
    v integer NOT NULL
);


--
-- Name: checkpoint_writes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checkpoint_writes (
    thread_id text NOT NULL,
    checkpoint_ns text DEFAULT ''::text NOT NULL,
    checkpoint_id text NOT NULL,
    task_id text NOT NULL,
    idx integer NOT NULL,
    channel text NOT NULL,
    type text,
    blob bytea NOT NULL
);


--
-- Name: checkpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checkpoints (
    thread_id text NOT NULL,
    checkpoint_ns text DEFAULT ''::text NOT NULL,
    checkpoint_id text NOT NULL,
    parent_checkpoint_id text,
    type text,
    checkpoint jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: creative_audit_experiments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.creative_audit_experiments (
    experiment_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    audit_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    applied_title boolean DEFAULT false NOT NULL,
    applied_description boolean DEFAULT false NOT NULL,
    applied_characteristics jsonb DEFAULT '[]'::jsonb NOT NULL,
    before_snapshot jsonb NOT NULL,
    baseline_metrics jsonb NOT NULL,
    baseline_date text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    result_metrics jsonb,
    result_date text,
    result_delta jsonb,
    result_verdict text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    reverted_at timestamp with time zone
);


--
-- Name: creative_audit_experiments_experiment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.creative_audit_experiments ALTER COLUMN experiment_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.creative_audit_experiments_experiment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: creative_audit_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.creative_audit_jobs (
    job_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    nm_id bigint NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    stage text,
    error_message text,
    snapshot_id bigint,
    final_audit_id bigint,
    result_json jsonb,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: creative_audit_jobs_job_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.creative_audit_jobs ALTER COLUMN job_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.creative_audit_jobs_job_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: creative_audit_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.creative_audit_runs (
    audit_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    status text DEFAULT 'completed'::text NOT NULL,
    is_free boolean DEFAULT true NOT NULL,
    model text,
    score integer,
    summary text,
    strengths jsonb DEFAULT '[]'::jsonb NOT NULL,
    issues jsonb DEFAULT '[]'::jsonb NOT NULL,
    quick_fixes jsonb DEFAULT '[]'::jsonb NOT NULL,
    content_suggestions jsonb DEFAULT '[]'::jsonb NOT NULL,
    photo_suggestions jsonb DEFAULT '[]'::jsonb NOT NULL,
    seo_suggestions jsonb DEFAULT '[]'::jsonb NOT NULL,
    checklist jsonb DEFAULT '[]'::jsonb NOT NULL,
    input_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: creative_audit_runs_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.creative_audit_runs ALTER COLUMN audit_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.creative_audit_runs_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: creative_audit_runs_final; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.creative_audit_runs_final (
    id bigint NOT NULL,
    card_audit_id bigint,
    photo_audit_id bigint,
    snapshot_id bigint,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    model_name text NOT NULL,
    prompt_version text DEFAULT 'v3.0'::text NOT NULL,
    is_validated boolean DEFAULT false,
    final_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    overall_score integer,
    card_score integer,
    photo_score integer,
    confidence integer,
    is_free boolean DEFAULT true NOT NULL,
    input_tokens integer,
    output_tokens integer,
    total_cost_usd text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: creative_audit_runs_final_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.creative_audit_runs_final ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.creative_audit_runs_final_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: creative_card_audit_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.creative_card_audit_runs (
    id bigint NOT NULL,
    snapshot_id bigint,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    model_name text NOT NULL,
    prompt_version text DEFAULT 'v3.0'::text NOT NULL,
    audit_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    input_tokens integer,
    output_tokens integer,
    cost_usd text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: creative_card_audit_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.creative_card_audit_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.creative_card_audit_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: creative_card_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.creative_card_snapshots (
    snapshot_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    snapshot_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    photo_urls jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: creative_card_snapshots_snapshot_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.creative_card_snapshots ALTER COLUMN snapshot_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.creative_card_snapshots_snapshot_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: creative_image_generations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.creative_image_generations (
    generation_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    audit_id bigint,
    nm_id bigint NOT NULL,
    prompt text NOT NULL,
    reference_photo_url text,
    designer_brief text,
    generation_type text NOT NULL,
    generated_images jsonb DEFAULT '[]'::jsonb NOT NULL,
    selected_index integer,
    status text DEFAULT 'pending'::text NOT NULL,
    error_message text,
    uploaded_to_wb boolean DEFAULT false NOT NULL,
    uploaded_photo_number integer,
    ab_test_id bigint,
    cost_usd text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: TABLE creative_image_generations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.creative_image_generations IS 'AI-generated images from audit designer briefs';


--
-- Name: creative_image_generations_generation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.creative_image_generations ALTER COLUMN generation_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.creative_image_generations_generation_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: creative_photo_audit_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.creative_photo_audit_runs (
    id bigint NOT NULL,
    snapshot_id bigint,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    model_name text NOT NULL,
    prompt_version text DEFAULT 'v3.0'::text NOT NULL,
    photos_analyzed integer DEFAULT 0,
    vision_mode boolean DEFAULT true,
    audit_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    input_tokens integer,
    output_tokens integer,
    cost_usd text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: creative_photo_audit_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.creative_photo_audit_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.creative_photo_audit_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: creative_visual_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.creative_visual_assets (
    asset_id bigint NOT NULL,
    job_id text NOT NULL,
    kind text NOT NULL,
    url text NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: creative_visual_assets_asset_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.creative_visual_assets ALTER COLUMN asset_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.creative_visual_assets_asset_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: creative_visual_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.creative_visual_jobs (
    job_id text NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    status text DEFAULT 'done'::text NOT NULL,
    prompt_version text,
    input_text text,
    output_text text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    output_json jsonb
);


--
-- Name: creative_visual_slides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.creative_visual_slides (
    slide_id bigint NOT NULL,
    job_id text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    title text,
    goal text,
    utp text,
    copy text,
    layout_hint text,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: creative_visual_slides_slide_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.creative_visual_slides ALTER COLUMN slide_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.creative_visual_slides_slide_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: document_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_chunks (
    chunk_id bigint NOT NULL,
    document_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    content text NOT NULL,
    chunk_index integer NOT NULL,
    page_number integer,
    token_count integer,
    content_hash text,
    embedding public.vector(1024),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: document_chunks_chunk_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.document_chunks ALTER COLUMN chunk_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.document_chunks_chunk_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    document_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    uploaded_by bigint,
    title text NOT NULL,
    file_name text,
    file_type text NOT NULL,
    file_size_bytes integer,
    storage_path text,
    full_text text,
    category text,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    nm_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    is_knowledge_base boolean DEFAULT false NOT NULL,
    status text DEFAULT 'uploaded'::text NOT NULL,
    chunk_count integer DEFAULT 0,
    page_count integer,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    shop_id bigint
);


--
-- Name: documents_document_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.documents ALTER COLUMN document_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.documents_document_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: fbs_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fbs_documents (
    doc_id bigint NOT NULL,
    run_id text NOT NULL,
    file_path text NOT NULL,
    file_name text,
    mime text,
    size_bytes bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: fbs_documents_doc_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.fbs_documents ALTER COLUMN doc_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.fbs_documents_doc_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: fbs_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fbs_runs (
    run_id text NOT NULL,
    workspace_id bigint NOT NULL,
    schedule_id bigint,
    shop_id bigint,
    status text DEFAULT 'queued'::text NOT NULL,
    error_text text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    telegram_chat_id text
);


--
-- Name: fbs_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fbs_schedules (
    schedule_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    days_of_week jsonb DEFAULT '[1, 2, 3, 4, 5, 6, 7]'::jsonb NOT NULL,
    send_time text DEFAULT '09:00'::text NOT NULL,
    timezone text DEFAULT 'Europe/Moscow'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_run_at timestamp with time zone,
    telegram_chat_id text,
    telegram_enabled boolean DEFAULT false NOT NULL
);


--
-- Name: fbs_schedules_schedule_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.fbs_schedules ALTER COLUMN schedule_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.fbs_schedules_schedule_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: feedback_reply_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feedback_reply_log (
    log_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    feedback_id text NOT NULL,
    nm_id bigint,
    sentiment text,
    tone_used text,
    kb_entries_used jsonb DEFAULT '[]'::jsonb NOT NULL,
    cross_sell_included boolean DEFAULT false NOT NULL,
    reply_text text NOT NULL,
    status text DEFAULT 'sent'::text NOT NULL,
    approved_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: feedback_reply_log_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.feedback_reply_log ALTER COLUMN log_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.feedback_reply_log_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: holiday_calendar; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.holiday_calendar (
    date date NOT NULL,
    label text NOT NULL,
    kind text NOT NULL
);


--
-- Name: insight_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insight_settings (
    workspace_id bigint NOT NULL,
    sensitivity text DEFAULT 'standard'::text NOT NULL,
    min_stock_days integer DEFAULT 5 NOT NULL,
    target_drr_pct integer DEFAULT 20 NOT NULL,
    excluded_tag_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    notify_channels jsonb DEFAULT '{"ui": true, "telegram": false, "categories": {}}'::jsonb NOT NULL,
    notify_time text DEFAULT '08:00'::text NOT NULL,
    timezone text DEFAULT 'Europe/Moscow'::text NOT NULL,
    last_run_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: insights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insights (
    insight_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint,
    date text NOT NULL,
    insight_type text NOT NULL,
    category text NOT NULL,
    severity text,
    score integer,
    title text NOT NULL,
    description text,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    fingerprint text,
    seen_at timestamp with time zone,
    dismissed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: insights_insight_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.insights ALTER COLUMN insight_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.insights_insight_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: knowledge_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_entries (
    entry_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    scope_type text NOT NULL,
    scope_key text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    entry_type text DEFAULT 'general'::text,
    category text,
    nm_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    priority integer DEFAULT 0,
    is_active boolean DEFAULT true
);


--
-- Name: knowledge_entries_entry_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.knowledge_entries ALTER COLUMN entry_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.knowledge_entries_entry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: marketplace_feedback_analysis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_feedback_analysis (
    analysis_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    marketplace text NOT NULL,
    item_type text NOT NULL,
    item_id text NOT NULL,
    sentiment text,
    summary text,
    key_points jsonb DEFAULT '[]'::jsonb NOT NULL,
    topics jsonb DEFAULT '[]'::jsonb NOT NULL,
    issues jsonb DEFAULT '[]'::jsonb NOT NULL,
    model text,
    confidence integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: marketplace_feedback_analysis_analysis_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.marketplace_feedback_analysis ALTER COLUMN analysis_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.marketplace_feedback_analysis_analysis_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: marketplace_feedback_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_feedback_items (
    workspace_id bigint NOT NULL,
    marketplace text NOT NULL,
    item_type text NOT NULL,
    item_id text NOT NULL,
    nm_id bigint,
    vendor_code text,
    product_title text,
    brand_name text,
    rating integer,
    text text,
    pros text,
    cons text,
    answer_text text,
    answer_state text,
    is_answered boolean DEFAULT false NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    answered_at timestamp with time zone,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    shop_id bigint,
    user_name text,
    photos_count integer DEFAULT 0,
    has_video boolean DEFAULT false,
    category text,
    sentiment text
);


--
-- Name: marketplace_reply_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_reply_drafts (
    draft_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    marketplace text NOT NULL,
    item_type text NOT NULL,
    item_id text NOT NULL,
    source text DEFAULT 'ai'::text NOT NULL,
    content text NOT NULL,
    confidence integer,
    status text DEFAULT 'draft'::text NOT NULL,
    decision_reason text,
    web_sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_at timestamp with time zone,
    sent_at timestamp with time zone,
    rejected_at timestamp with time zone,
    shop_id bigint
);


--
-- Name: marketplace_reply_drafts_draft_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.marketplace_reply_drafts ALTER COLUMN draft_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.marketplace_reply_drafts_draft_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: marketplace_reply_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_reply_settings (
    workspace_id bigint NOT NULL,
    marketplace text NOT NULL,
    item_type text NOT NULL,
    auto_send boolean DEFAULT false NOT NULL,
    min_confidence integer DEFAULT 70 NOT NULL,
    allow_web_search boolean DEFAULT true NOT NULL,
    require_approval boolean DEFAULT true NOT NULL,
    notify_telegram boolean DEFAULT false NOT NULL,
    tone text,
    max_length integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint,
    praise_level text DEFAULT 'moderate'::text,
    photo_bonus boolean DEFAULT true,
    star_5_template text,
    complaint_style text DEFAULT 'balanced'::text,
    signature text,
    forbidden_words jsonb DEFAULT '[]'::jsonb,
    auto_send_positive boolean DEFAULT false,
    auto_send_min_rating integer DEFAULT 4
);


--
-- Name: marketplace_shops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.marketplace_shops (
    shop_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    platform text NOT NULL,
    name text NOT NULL,
    api_key text NOT NULL,
    client_id text,
    wb_delivery_type text DEFAULT 'fbs'::text NOT NULL,
    tax_regime text DEFAULT 'usn15'::text NOT NULL,
    vat_pct smallint DEFAULT 0 NOT NULL,
    extra jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tax_rate smallint,
    vat_included boolean DEFAULT false NOT NULL,
    api_key_hash text,
    token_type text DEFAULT 'unknown'::text,
    CONSTRAINT marketplace_shops_token_type_check CHECK ((token_type = ANY (ARRAY['basic'::text, 'test'::text, 'personal'::text, 'service'::text, 'unknown'::text, 'invalid'::text])))
);


--
-- Name: COLUMN marketplace_shops.tax_regime; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.marketplace_shops.tax_regime IS 'Режим: usn6 (УСН Доходы), usn15 (УСН Д-Р), osno (ОСНО), patent (Патент)';


--
-- Name: COLUMN marketplace_shops.vat_pct; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.marketplace_shops.vat_pct IS 'НДС в % (0, 5, 10, 20). 0 = не плательщик НДС';


--
-- Name: COLUMN marketplace_shops.tax_rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.marketplace_shops.tax_rate IS 'Ставка налога в % (6, 15, 20). Если null — используется дефолт по режиму';


--
-- Name: COLUMN marketplace_shops.vat_included; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.marketplace_shops.vat_included IS 'Учитывать входящий НДС (есть счета-фактуры от поставщиков)';


--
-- Name: marketplace_shops_shop_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.marketplace_shops ALTER COLUMN shop_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.marketplace_shops_shop_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_sync_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_sync_runs (
    run_id text NOT NULL,
    workspace_id bigint NOT NULL,
    stage text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    shop_id bigint,
    rows_written integer
);


--
-- Name: COLUMN wb_sync_runs.rows_written; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wb_sync_runs.rows_written IS 'Number of rows actually written to target table. NULL = legacy run before this column was added. 0 = ran successfully but produced no rows (often a silent failure).';


--
-- Name: marketplace_shops_sync_status; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.marketplace_shops_sync_status AS
 SELECT shop_id,
    stage,
    max(finished_at) FILTER (WHERE (status = 'done'::text)) AS last_success_at,
    max(finished_at) FILTER (WHERE (status = 'failed'::text)) AS last_error_at,
    max(finished_at) FILTER (WHERE (status = 'token_expired'::text)) AS last_token_expired_at,
    ( SELECT r2.error
           FROM public.wb_sync_runs r2
          WHERE ((r2.shop_id = r.shop_id) AND (r2.stage = r.stage) AND (r2.status = ANY (ARRAY['failed'::text, 'token_expired'::text])))
          ORDER BY r2.finished_at DESC NULLS LAST
         LIMIT 1) AS last_error_message,
    count(*) FILTER (WHERE (status = 'done'::text)) AS success_count,
    count(*) FILTER (WHERE (status = 'failed'::text)) AS failed_count
   FROM public.wb_sync_runs r
  WHERE ((shop_id IS NOT NULL) AND (finished_at IS NOT NULL))
  GROUP BY shop_id, stage;


--
-- Name: notification_dedup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_dedup (
    kind text NOT NULL,
    shop_id bigint NOT NULL,
    sent_date date DEFAULT CURRENT_DATE NOT NULL,
    user_id bigint,
    sent_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_settings (
    setting_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    user_id bigint NOT NULL,
    telegram_chat_id text,
    telegram_enabled boolean DEFAULT false,
    notify_tasks boolean DEFAULT true,
    notify_alerts boolean DEFAULT true,
    notify_reminders boolean DEFAULT true,
    notify_feedback boolean DEFAULT false,
    notify_before_minutes integer DEFAULT 30,
    quiet_hours_start text,
    quiet_hours_end text,
    timezone text DEFAULT 'Europe/Moscow'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: notification_settings_setting_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.notification_settings ALTER COLUMN setting_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.notification_settings_setting_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: price_ab_phases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_ab_phases (
    phase_id bigint NOT NULL,
    test_id bigint NOT NULL,
    variant text NOT NULL,
    price_kop bigint NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    metrics_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    price_synced boolean DEFAULT false NOT NULL,
    sync_error text
);


--
-- Name: price_ab_phases_phase_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.price_ab_phases ALTER COLUMN phase_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.price_ab_phases_phase_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: price_ab_tests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_ab_tests (
    test_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    nm_id bigint NOT NULL,
    name text,
    status text DEFAULT 'running'::text NOT NULL,
    goal text DEFAULT 'orders'::text NOT NULL,
    period_days integer DEFAULT 7 NOT NULL,
    variants jsonb DEFAULT '[]'::jsonb NOT NULL,
    current_variant text DEFAULT 'A'::text,
    winner_variant text,
    rotation_minutes integer DEFAULT 20 NOT NULL,
    auto_rotate boolean DEFAULT true NOT NULL,
    original_price_kop bigint,
    last_rotated_at timestamp with time zone,
    last_sync_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: price_ab_tests_test_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.price_ab_tests ALTER COLUMN test_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.price_ab_tests_test_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: pricing_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_decisions (
    decision_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    strategy_type text NOT NULL,
    old_price_kop bigint NOT NULL,
    new_price_kop bigint NOT NULL,
    reason text NOT NULL,
    constraints_applied jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    action_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: pricing_decisions_decision_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pricing_decisions ALTER COLUMN decision_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.pricing_decisions_decision_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: pricing_strategies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_strategies (
    strategy_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    strategy_type text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: pricing_strategies_strategy_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pricing_strategies ALTER COLUMN strategy_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.pricing_strategies_strategy_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: pulse_alert_controls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pulse_alert_controls (
    control_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    tag_id bigint,
    nm_id bigint,
    enable_stocks boolean DEFAULT true NOT NULL,
    enable_ads boolean DEFAULT true NOT NULL,
    enable_drr boolean DEFAULT true NOT NULL,
    enable_buyout boolean DEFAULT true NOT NULL,
    enable_sales_drop boolean DEFAULT true NOT NULL,
    cooldown_days integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: pulse_alert_controls_control_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pulse_alert_controls ALTER COLUMN control_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.pulse_alert_controls_control_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: pulse_metric_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pulse_metric_groups (
    group_id text NOT NULL,
    title text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pulse_metrics_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pulse_metrics_catalog (
    metric_id text NOT NULL,
    group_id text NOT NULL,
    title text NOT NULL,
    unit text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_default_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pulse_migration_failures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pulse_migration_failures (
    failure_id bigint NOT NULL,
    name text NOT NULL,
    error_code text,
    error_message text,
    failed_statement text,
    failed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pulse_migration_failures_failure_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pulse_migration_failures ALTER COLUMN failure_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.pulse_migration_failures_failure_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: pulse_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pulse_migrations (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pulse_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pulse_plans (
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    nm_id bigint NOT NULL,
    metric text NOT NULL,
    value bigint NOT NULL,
    created_by_user_id bigint NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: pulse_preset_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pulse_preset_events (
    event_id bigint NOT NULL,
    preset_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    actor_user_id bigint NOT NULL,
    event_type text NOT NULL,
    before jsonb,
    after jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pulse_preset_events_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pulse_preset_events ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.pulse_preset_events_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: pulse_preset_group_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pulse_preset_group_settings (
    preset_id bigint NOT NULL,
    group_id text NOT NULL,
    is_enabled boolean NOT NULL
);


--
-- Name: pulse_preset_metric_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pulse_preset_metric_settings (
    preset_id bigint NOT NULL,
    metric_id text NOT NULL,
    is_enabled boolean NOT NULL
);


--
-- Name: pulse_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pulse_presets (
    preset_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    created_by_user_id bigint NOT NULL,
    name text NOT NULL,
    description text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_pinned boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    shop_id bigint
);


--
-- Name: pulse_presets_preset_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.pulse_presets ALTER COLUMN preset_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.pulse_presets_preset_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: region_warehouse_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.region_warehouse_mapping (
    id bigint NOT NULL,
    region_name text NOT NULL,
    warehouse_id integer NOT NULL,
    priority integer DEFAULT 1,
    delivery_days integer DEFAULT 3
);


--
-- Name: region_warehouse_mapping_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.region_warehouse_mapping ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.region_warehouse_mapping_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sales_monthly_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_monthly_targets (
    workspace_id bigint NOT NULL,
    shop_id bigint DEFAULT 0 NOT NULL,
    month text NOT NULL,
    market_revenue_rub bigint,
    target_share_pct numeric(6,4),
    plan_revenue_rub bigint DEFAULT 0 NOT NULL,
    plan_ad_spend_rub bigint,
    plan_impressions bigint,
    plan_orders_qty integer,
    comment text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sales_monthly_targets_per_nm; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sales_monthly_targets_per_nm (
    workspace_id bigint NOT NULL,
    shop_id bigint DEFAULT 0 NOT NULL,
    month text NOT NULL,
    nm_id bigint NOT NULL,
    plan_qty integer DEFAULT 0 NOT NULL,
    plan_rub bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seo_addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_addresses (
    address_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    name text NOT NULL,
    dest text,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: seo_addresses_address_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.seo_addresses ALTER COLUMN address_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.seo_addresses_address_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: seo_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_alerts (
    alert_id bigint NOT NULL,
    keyword_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    previous_position integer,
    current_position integer,
    alert_type text NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seo_alerts_alert_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.seo_alerts ALTER COLUMN alert_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.seo_alerts_alert_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: seo_competitor_keywords; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_competitor_keywords (
    workspace_id bigint NOT NULL,
    shop_id bigint,
    competitor_id bigint NOT NULL,
    keyword_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seo_competitor_positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_competitor_positions (
    position_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    competitor_id bigint NOT NULL,
    keyword_id bigint NOT NULL,
    address_id bigint,
    checked_at timestamp with time zone NOT NULL,
    "position" integer,
    page integer,
    price integer,
    original_price integer,
    discount smallint,
    feedbacks integer,
    rating real,
    is_promo boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seo_competitor_positions_position_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.seo_competitor_positions ALTER COLUMN position_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.seo_competitor_positions_position_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: seo_competitors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_competitors (
    competitor_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    name text NOT NULL,
    nm_id bigint NOT NULL,
    keyword_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint,
    is_active boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seo_competitors_competitor_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.seo_competitors ALTER COLUMN competitor_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.seo_competitors_competitor_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: seo_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_jobs (
    job_id text NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    status text DEFAULT 'done'::text NOT NULL,
    queries_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    input_text text,
    output_title text,
    output_description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seo_keyword_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_keyword_products (
    keyword_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seo_keyword_tag_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_keyword_tag_links (
    keyword_id bigint NOT NULL,
    tag_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seo_keyword_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_keyword_tags (
    tag_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    name text NOT NULL,
    color text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: seo_keyword_tags_tag_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.seo_keyword_tags ALTER COLUMN tag_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.seo_keyword_tags_tag_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: seo_keywords; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_keywords (
    keyword_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    keyword text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    alert_threshold integer,
    last_checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: seo_keywords_keyword_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.seo_keywords ALTER COLUMN keyword_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.seo_keywords_keyword_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: seo_position_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_position_snapshots (
    snapshot_id bigint NOT NULL,
    keyword_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    "position" integer,
    page integer,
    total_products integer,
    cpm integer,
    is_promo boolean DEFAULT false NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    address_id bigint
);


--
-- Name: seo_position_snapshots_snapshot_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.seo_position_snapshots ALTER COLUMN snapshot_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.seo_position_snapshots_snapshot_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: seo_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seo_settings (
    workspace_id bigint NOT NULL,
    check_interval_hours integer DEFAULT 12 NOT NULL,
    alert_on_drop_positions integer DEFAULT 5 NOT NULL,
    alert_on_exit_top integer DEFAULT 50 NOT NULL,
    alert_on_enter_top integer DEFAULT 10 NOT NULL,
    notify_telegram boolean DEFAULT false NOT NULL,
    notify_email boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint,
    alert_on_competitor_price_drop_pct integer DEFAULT 15 NOT NULL,
    alert_on_new_competitor_top_n integer DEFAULT 10 NOT NULL,
    last_check_at timestamp with time zone
);


--
-- Name: signup_waitlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signup_waitlist (
    id bigint NOT NULL,
    email public.citext NOT NULL,
    name text,
    source text,
    user_agent text,
    ip inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    notified_at timestamp with time zone
);


--
-- Name: signup_waitlist_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.signup_waitlist ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.signup_waitlist_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: studio_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.studio_assets (
    asset_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    project_id bigint,
    type text NOT NULL,
    name text,
    url text NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint,
    user_id bigint
);


--
-- Name: studio_assets_asset_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.studio_assets ALTER COLUMN asset_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.studio_assets_asset_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: studio_credits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.studio_credits (
    credit_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    operation text NOT NULL,
    credits_used integer NOT NULL,
    model text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: studio_credits_credit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.studio_credits ALTER COLUMN credit_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.studio_credits_credit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: studio_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.studio_presets (
    preset_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    name text NOT NULL,
    category text,
    settings jsonb NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: studio_presets_preset_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.studio_presets ALTER COLUMN preset_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.studio_presets_preset_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: studio_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.studio_projects (
    project_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id integer,
    name text NOT NULL,
    type text DEFAULT 'image'::text NOT NULL,
    canvas_data jsonb,
    thumbnail text,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: studio_projects_project_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.studio_projects ALTER COLUMN project_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.studio_projects_project_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: studio_prompt_suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.studio_prompt_suggestions (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    nm_id bigint NOT NULL,
    audit_id bigint,
    user_id bigint,
    prompts_json jsonb NOT NULL,
    product_context_json jsonb NOT NULL,
    model_used text DEFAULT 'claude-sonnet-4-6'::text NOT NULL,
    input_tokens integer,
    output_tokens integer,
    label text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: studio_prompt_suggestions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.studio_prompt_suggestions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.studio_prompt_suggestions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: studio_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.studio_tasks (
    task_id text NOT NULL,
    workspace_id bigint NOT NULL,
    project_id bigint,
    type text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    input jsonb NOT NULL,
    output jsonb,
    error text,
    progress integer DEFAULT 0,
    credits_used integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    shop_id integer
);


--
-- Name: supplies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supplies (
    supply_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    draft_id bigint,
    wb_supply_id text,
    warehouse_id integer,
    warehouse_name text,
    delivery_date date,
    status text DEFAULT 'created'::text NOT NULL,
    items_count integer,
    total_qty integer,
    total_boxes integer,
    acceptance_coefficient numeric(5,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    accepted_at timestamp with time zone,
    shop_id bigint
);


--
-- Name: supplies_supply_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supplies ALTER COLUMN supply_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supplies_supply_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supply_booking_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supply_booking_queue (
    queue_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    draft_id bigint,
    warehouse_id integer NOT NULL,
    desired_date date NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    attempts integer DEFAULT 0,
    last_attempt_at timestamp with time zone,
    next_attempt_at timestamp with time zone,
    booked_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    preorder_id bigint,
    max_coefficient numeric(4,2) DEFAULT 1.0
);


--
-- Name: supply_booking_queue_queue_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supply_booking_queue ALTER COLUMN queue_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supply_booking_queue_queue_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supply_box_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supply_box_settings (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint,
    items_per_box integer DEFAULT 10 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint,
    alert_coeff_threshold numeric(4,2) DEFAULT 1.0,
    auto_book_enabled boolean DEFAULT false
);


--
-- Name: supply_box_settings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supply_box_settings ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supply_box_settings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supply_boxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supply_boxes (
    box_id bigint NOT NULL,
    supply_id bigint NOT NULL,
    wb_trbx_id text,
    box_number integer NOT NULL,
    items jsonb NOT NULL,
    sticker_file bytea,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: supply_boxes_box_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supply_boxes ALTER COLUMN box_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supply_boxes_box_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supply_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supply_documents (
    doc_id bigint NOT NULL,
    supply_id bigint NOT NULL,
    doc_type text NOT NULL,
    file_name text NOT NULL,
    file_data bytea NOT NULL,
    file_size integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: supply_documents_doc_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supply_documents ALTER COLUMN doc_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supply_documents_doc_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supply_draft_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supply_draft_items (
    item_id bigint NOT NULL,
    draft_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    vendor_code text,
    title text,
    barcode text,
    quantity integer NOT NULL,
    quantity_adjusted integer,
    items_per_box integer,
    boxes_count integer,
    current_stock integer,
    avg_daily_sales numeric(10,2),
    days_of_stock numeric(10,1),
    region_breakdown jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: supply_draft_items_item_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supply_draft_items ALTER COLUMN item_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supply_draft_items_item_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supply_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supply_drafts (
    draft_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    name text,
    warehouse_id integer,
    warehouse_name text,
    planned_date date,
    status text DEFAULT 'draft'::text NOT NULL,
    total_items integer DEFAULT 0,
    total_qty integer DEFAULT 0,
    total_boxes integer DEFAULT 0,
    source_regions text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint,
    wb_preorder_id bigint
);


--
-- Name: supply_drafts_draft_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supply_drafts ALTER COLUMN draft_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supply_drafts_draft_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supply_drivers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supply_drivers (
    driver_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    car_model text NOT NULL,
    car_number text NOT NULL,
    is_default boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: supply_drivers_driver_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supply_drivers ALTER COLUMN driver_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supply_drivers_driver_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supply_passes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supply_passes (
    pass_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    supply_id bigint,
    wb_pass_id integer,
    warehouse_id integer NOT NULL,
    driver_first_name text NOT NULL,
    driver_last_name text NOT NULL,
    car_model text NOT NULL,
    car_number text NOT NULL,
    valid_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: supply_passes_pass_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supply_passes ALTER COLUMN pass_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supply_passes_pass_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supply_priority_warehouses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supply_priority_warehouses (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    warehouse_id integer NOT NULL,
    warehouse_name text NOT NULL,
    priority integer,
    regions text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: supply_priority_warehouses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supply_priority_warehouses ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supply_priority_warehouses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: supply_roi_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supply_roi_history (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    nm_id bigint,
    warehouse_id integer,
    quantity integer,
    acceptance_cost_kop bigint,
    transit_cost_kop bigint,
    storage_cost_kop bigint,
    expected_revenue_kop bigint,
    expected_margin_kop bigint,
    roi_kop bigint,
    decision text,
    preorder_id integer,
    fbs_supply_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: supply_roi_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.supply_roi_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: supply_roi_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.supply_roi_history_id_seq OWNED BY public.supply_roi_history.id;


--
-- Name: supply_slots_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.supply_slots_cache (
    cache_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    warehouse_id integer NOT NULL,
    date date NOT NULL,
    coefficient numeric(5,2),
    available boolean DEFAULT true,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: supply_slots_cache_cache_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.supply_slots_cache ALTER COLUMN cache_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.supply_slots_cache_cache_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: system_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_events (
    event_id uuid DEFAULT gen_random_uuid() NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    agent_name text,
    event_type text NOT NULL,
    workspace_id bigint,
    shop_id bigint,
    entity_type text,
    entity_id text,
    payload jsonb,
    correlation_id uuid
);


--
-- Name: tg_chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tg_chat_messages (
    msg_id bigint NOT NULL,
    session_id bigint NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    tool_calls jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tg_chat_messages_msg_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tg_chat_messages_msg_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tg_chat_messages_msg_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tg_chat_messages_msg_id_seq OWNED BY public.tg_chat_messages.msg_id;


--
-- Name: tg_chat_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tg_chat_sessions (
    session_id bigint NOT NULL,
    user_id bigint NOT NULL,
    tg_chat_id text NOT NULL,
    title text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_msg_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone
);


--
-- Name: tg_chat_sessions_session_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tg_chat_sessions_session_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tg_chat_sessions_session_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tg_chat_sessions_session_id_seq OWNED BY public.tg_chat_sessions.session_id;


--
-- Name: user_refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_refresh_tokens (
    session_id text NOT NULL,
    user_id bigint NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    replaced_by_session_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_sessions (
    session_id text NOT NULL,
    user_id bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_telegram_link_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_telegram_link_codes (
    code text NOT NULL,
    user_id bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_telegram_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_telegram_links (
    user_id bigint NOT NULL,
    tg_chat_id text NOT NULL,
    tg_username text,
    linked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    user_id bigint NOT NULL,
    email public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    password_hash text,
    reset_token text,
    reset_expires_at timestamp with time zone,
    email_verified boolean DEFAULT false NOT NULL,
    email_verify_token text,
    email_verify_expires_at timestamp with time zone,
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone
);


--
-- Name: COLUMN users.is_admin; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.is_admin IS 'System admin flag. Grants access to admin routes and bypass workspace checks.';


--
-- Name: users_user_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.users ALTER COLUMN user_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.users_user_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: v_seo_snapshots_scoped; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_seo_snapshots_scoped AS
 SELECT k.workspace_id,
    k.shop_id,
    k.keyword_id,
    k.keyword,
    s.nm_id,
    s.address_id,
    s."position",
    s.page,
    s.total_products,
    s.cpm,
    s.is_promo,
    s.checked_at,
    (s.checked_at)::date AS checked_date
   FROM (public.seo_keywords k
     JOIN public.seo_position_snapshots s ON ((s.keyword_id = k.keyword_id)));


--
-- Name: VIEW v_seo_snapshots_scoped; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_seo_snapshots_scoped IS 'seo_position_snapshots joined with seo_keywords for direct (ws, shop) filtering.';


--
-- Name: warehouse_region_mapping; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.warehouse_region_mapping (
    id bigint NOT NULL,
    warehouse_id integer NOT NULL,
    warehouse_name text NOT NULL,
    region_name text NOT NULL,
    priority integer DEFAULT 1
);


--
-- Name: warehouse_region_mapping_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.warehouse_region_mapping ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.warehouse_region_mapping_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_adv_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_adv_daily (
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    spend_kopecks bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    views_count integer DEFAULT 0 NOT NULL,
    clicks_count integer DEFAULT 0 NOT NULL,
    atbs_count integer DEFAULT 0 NOT NULL,
    orders_count integer DEFAULT 0 NOT NULL,
    sum_price_kopecks bigint DEFAULT 0 NOT NULL,
    spend_manual_kopecks bigint DEFAULT 0 NOT NULL,
    views_manual_count integer DEFAULT 0 NOT NULL,
    clicks_manual_count integer DEFAULT 0 NOT NULL,
    atbs_manual_count integer DEFAULT 0 NOT NULL,
    orders_manual_count integer DEFAULT 0 NOT NULL,
    sum_price_manual_kopecks bigint DEFAULT 0 NOT NULL,
    spend_unified_kopecks bigint DEFAULT 0 NOT NULL,
    views_unified_count integer DEFAULT 0 NOT NULL,
    clicks_unified_count integer DEFAULT 0 NOT NULL,
    atbs_unified_count integer DEFAULT 0 NOT NULL,
    orders_unified_count integer DEFAULT 0 NOT NULL,
    sum_price_unified_kopecks bigint DEFAULT 0 NOT NULL,
    shop_id bigint NOT NULL
);


--
-- Name: wb_adv_daily_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_adv_daily_products (
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    nm_id bigint NOT NULL,
    spend_kopecks bigint DEFAULT 0 NOT NULL,
    adverts_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    views_count integer DEFAULT 0 NOT NULL,
    clicks_count integer DEFAULT 0 NOT NULL,
    atbs_count integer DEFAULT 0 NOT NULL,
    orders_count integer DEFAULT 0 NOT NULL,
    sum_price_kopecks bigint DEFAULT 0 NOT NULL,
    spend_manual_kopecks bigint DEFAULT 0 NOT NULL,
    views_manual_count integer DEFAULT 0 NOT NULL,
    clicks_manual_count integer DEFAULT 0 NOT NULL,
    atbs_manual_count integer DEFAULT 0 NOT NULL,
    orders_manual_count integer DEFAULT 0 NOT NULL,
    sum_price_manual_kopecks bigint DEFAULT 0 NOT NULL,
    spend_unified_kopecks bigint DEFAULT 0 NOT NULL,
    views_unified_count integer DEFAULT 0 NOT NULL,
    clicks_unified_count integer DEFAULT 0 NOT NULL,
    atbs_unified_count integer DEFAULT 0 NOT NULL,
    orders_unified_count integer DEFAULT 0 NOT NULL,
    sum_price_unified_kopecks bigint DEFAULT 0 NOT NULL,
    shop_id bigint NOT NULL
);


--
-- Name: wb_adv_finance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_adv_finance (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    upd_num integer NOT NULL,
    upd_time timestamp with time zone,
    upd_date text NOT NULL,
    upd_sum_kopecks bigint NOT NULL,
    advert_id integer NOT NULL,
    camp_name text,
    advert_type smallint NOT NULL,
    advert_status smallint NOT NULL,
    payment_type text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE wb_adv_finance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.wb_adv_finance IS 'Фактические списания на рекламу из WB API /adv/v1/upd';


--
-- Name: COLUMN wb_adv_finance.payment_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wb_adv_finance.payment_type IS 'Источник списания: Баланс (неттинг), Счёт (пополнение), Бонусы, Кэшбэк';


--
-- Name: wb_adv_finance_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_adv_finance_daily (
    workspace_id bigint NOT NULL,
    shop_id bigint,
    date text NOT NULL,
    balance_kopecks bigint DEFAULT 0 NOT NULL,
    account_kopecks bigint DEFAULT 0 NOT NULL,
    bonus_kopecks bigint DEFAULT 0 NOT NULL,
    cashback_kopecks bigint DEFAULT 0 NOT NULL,
    total_kopecks bigint DEFAULT 0 NOT NULL,
    transactions_count integer DEFAULT 0 NOT NULL,
    adverts_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: COLUMN wb_adv_finance_daily.balance_kopecks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wb_adv_finance_daily.balance_kopecks IS 'Списания с Баланса (взаимозачёт), попадают в "Прочие удержания" еженедельного отчёта';


--
-- Name: COLUMN wb_adv_finance_daily.account_kopecks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wb_adv_finance_daily.account_kopecks IS 'Списания со Счёта (ручное пополнение), НЕ попадают в еженедельные отчёты';


--
-- Name: wb_adv_finance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_adv_finance ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_adv_finance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_alert_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_alert_settings (
    setting_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    tag_id bigint,
    nm_id bigint,
    max_drr_fact_pct integer,
    max_drr_forecast_pct integer,
    min_days_of_stock integer,
    buyout_drop_pp_warn integer,
    buyout_drop_pp_crit integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_alert_settings_setting_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_alert_settings ALTER COLUMN setting_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_alert_settings_setting_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_backfill_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_backfill_progress (
    workspace_id bigint NOT NULL,
    shop_id bigint NOT NULL,
    sync_type text NOT NULL,
    target_oldest date NOT NULL,
    oldest_covered date,
    newest_covered date,
    last_advanced_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wb_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_campaigns (
    campaign_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    name text DEFAULT ''::text NOT NULL,
    status integer DEFAULT 0 NOT NULL,
    type integer DEFAULT 8 NOT NULL,
    payment_type text DEFAULT 'cpm'::text NOT NULL,
    daily_budget integer DEFAULT 0 NOT NULL,
    current_bid integer,
    create_time timestamp with time zone,
    change_time timestamp with time zone,
    start_time timestamp with time zone,
    end_time timestamp with time zone,
    today_spend integer DEFAULT 0 NOT NULL,
    today_views integer DEFAULT 0 NOT NULL,
    today_clicks integer DEFAULT 0 NOT NULL,
    today_orders integer DEFAULT 0 NOT NULL,
    today_drr numeric(5,2),
    nm_ids jsonb DEFAULT '[]'::jsonb,
    keywords jsonb DEFAULT '[]'::jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE wb_campaigns; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.wb_campaigns IS 'WB advertising campaigns synced from Advert API';


--
-- Name: wb_card_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_card_snapshots (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    snapshot_date date NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'wb_api_poll'::text NOT NULL,
    wb_updated_at timestamp with time zone,
    title text,
    description text,
    brand text,
    subject_id integer,
    vendor_code text,
    photos jsonb DEFAULT '[]'::jsonb NOT NULL,
    video text,
    characteristics jsonb DEFAULT '[]'::jsonb NOT NULL,
    sizes jsonb,
    dimensions jsonb,
    tags jsonb,
    raw_card jsonb DEFAULT '{}'::jsonb NOT NULL,
    changes_from_prev jsonb,
    changes_summary text
);


--
-- Name: TABLE wb_card_snapshots; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.wb_card_snapshots IS 'Полный ежедневный архив карточек WB. Cron wb-card-snapshot-daily заполняет раз в сутки.';


--
-- Name: wb_card_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wb_card_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wb_card_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wb_card_snapshots_id_seq OWNED BY public.wb_card_snapshots.id;


--
-- Name: wb_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_cards (
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    vendor_code text,
    title text,
    brand_name text,
    subject_id integer,
    subject_name text,
    main_photo_url text,
    photos jsonb DEFAULT '[]'::jsonb NOT NULL,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint,
    embedding public.vector(1024),
    embedding_text text,
    embedded_at timestamp with time zone
);


--
-- Name: wb_chats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_chats (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    chat_id text NOT NULL,
    nm_id bigint,
    order_id bigint,
    buyer_id text,
    last_message text,
    last_message_at timestamp with time zone,
    unread_count integer DEFAULT 0,
    status text DEFAULT 'open'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint,
    reply_sign text
);


--
-- Name: wb_chats_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_chats ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_chats_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_cogs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_cogs (
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    cogs_kopecks bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint,
    logistics_per_unit_kop bigint DEFAULT 0 NOT NULL
);


--
-- Name: COLUMN wb_cogs.logistics_per_unit_kop; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.wb_cogs.logistics_per_unit_kop IS 'Логистика селлера до склада WB (копейки за единицу). 0 = fallback 1.2% от revenue в supplyRoi.';


--
-- Name: wb_compensations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_compensations (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    nm_id bigint,
    date text NOT NULL,
    operation_type text NOT NULL,
    amount_kopecks bigint DEFAULT 0 NOT NULL,
    description text,
    rrd_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wb_compensations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_compensations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_compensations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_deductions_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_deductions_daily (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint,
    date timestamp with time zone NOT NULL,
    type text NOT NULL,
    amount integer NOT NULL,
    reason text,
    document_number text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_deductions_daily_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_deductions_daily ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_deductions_daily_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_event_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_event_comments (
    comment_id bigint NOT NULL,
    event_id bigint NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wb_event_comments_comment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_event_comments ALTER COLUMN comment_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_event_comments_comment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_events (
    event_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint,
    date text NOT NULL,
    "time" text,
    type text NOT NULL,
    category text,
    severity text,
    status text DEFAULT 'open'::text NOT NULL,
    title text NOT NULL,
    description text,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    fingerprint text,
    due_at timestamp with time zone,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    assignee_id bigint,
    reminder_at timestamp with time zone,
    reminder_sent boolean DEFAULT false,
    priority text DEFAULT 'medium'::text,
    tags text[] DEFAULT '{}'::text[],
    parent_event_id bigint,
    recurrence jsonb,
    completed_at timestamp with time zone,
    source text DEFAULT 'manual'::text,
    source_id text,
    linked_campaign_id bigint,
    linked_supply_id text,
    trigger_rule text,
    suggested_action text,
    widget_type text,
    widget_props jsonb,
    agent_conversation_id bigint,
    agent_action_id bigint,
    dedupe_key text,
    shop_id bigint,
    reminder_minutes_before integer
);


--
-- Name: wb_events_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_events ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_events_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_fbs_shipments_daily_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_fbs_shipments_daily_products (
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    nm_id bigint NOT NULL,
    supplies_count integer DEFAULT 0 NOT NULL,
    orders_count integer DEFAULT 0 NOT NULL,
    items_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_fbs_supplies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_fbs_supplies (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    wb_supply_id text NOT NULL,
    name text,
    cargo_type integer,
    destination_office_id integer,
    recommended_wh_id integer,
    closed_at timestamp with time zone,
    scan_dt timestamp with time zone,
    reject_dt timestamp with time zone,
    done boolean DEFAULT false,
    orders_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    synced_at timestamp with time zone
);


--
-- Name: wb_fbs_supplies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wb_fbs_supplies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wb_fbs_supplies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wb_fbs_supplies_id_seq OWNED BY public.wb_fbs_supplies.id;


--
-- Name: wb_fbs_supply_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_fbs_supply_orders (
    id bigint NOT NULL,
    fbs_supply_pk bigint NOT NULL,
    wb_order_id bigint NOT NULL,
    status text,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wb_fbs_supply_orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wb_fbs_supply_orders_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wb_fbs_supply_orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wb_fbs_supply_orders_id_seq OWNED BY public.wb_fbs_supply_orders.id;


--
-- Name: wb_finance_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_finance_daily (
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    lines integer DEFAULT 0 NOT NULL,
    retail_kopecks bigint DEFAULT 0 NOT NULL,
    payout_kopecks bigint DEFAULT 0 NOT NULL,
    commission_kopecks bigint DEFAULT 0 NOT NULL,
    logistics_kopecks bigint DEFAULT 0 NOT NULL,
    return_logistics_kopecks bigint DEFAULT 0 NOT NULL,
    storage_kopecks bigint DEFAULT 0 NOT NULL,
    penalty_kopecks bigint DEFAULT 0 NOT NULL,
    acquiring_kopecks bigint DEFAULT 0 NOT NULL,
    additional_payment_kopecks bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_acceptance_kopecks bigint DEFAULT 0 NOT NULL,
    other_hold_kopecks bigint DEFAULT 0 NOT NULL,
    returns_count integer DEFAULT 0 NOT NULL,
    cashback_amount_kopecks bigint DEFAULT 0 NOT NULL,
    cashback_discount_kopecks bigint DEFAULT 0 NOT NULL,
    cashback_commission_change_kopecks bigint DEFAULT 0 NOT NULL,
    seller_promo_discount_kopecks bigint DEFAULT 0 NOT NULL,
    loyalty_discount_kopecks bigint DEFAULT 0 NOT NULL,
    wb_discount_percent integer DEFAULT 0 NOT NULL,
    installment_cofinancing_kopecks bigint DEFAULT 0 NOT NULL,
    promotion_kopecks bigint DEFAULT 0 NOT NULL,
    shop_id bigint NOT NULL,
    spp_amount_kopecks bigint DEFAULT 0 NOT NULL,
    ppvz_vw_kopecks bigint DEFAULT 0 NOT NULL,
    ppvz_reward_kopecks bigint DEFAULT 0 NOT NULL,
    supplier_promo_kopecks bigint DEFAULT 0 NOT NULL,
    product_discount_kopecks bigint DEFAULT 0 NOT NULL,
    ppvz_spp_prc integer DEFAULT 0 NOT NULL,
    returns_sum_kopecks bigint DEFAULT 0 NOT NULL,
    rr_date text
);


--
-- Name: wb_finance_daily_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_finance_daily_products (
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    nm_id bigint NOT NULL,
    lines integer DEFAULT 0 NOT NULL,
    revenue_kopecks bigint DEFAULT 0 NOT NULL,
    income_from_sales_kopecks bigint DEFAULT 0 NOT NULL,
    commission_kopecks bigint DEFAULT 0 NOT NULL,
    logistics_kopecks bigint DEFAULT 0 NOT NULL,
    return_logistics_kopecks bigint DEFAULT 0 NOT NULL,
    paid_acceptance_kopecks bigint DEFAULT 0 NOT NULL,
    storage_kopecks bigint DEFAULT 0 NOT NULL,
    penalties_kopecks bigint DEFAULT 0 NOT NULL,
    other_hold_kopecks bigint DEFAULT 0 NOT NULL,
    acquiring_kopecks bigint DEFAULT 0 NOT NULL,
    additional_payments_kopecks bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    returns_count integer DEFAULT 0 NOT NULL,
    cashback_amount_kopecks bigint DEFAULT 0 NOT NULL,
    cashback_discount_kopecks bigint DEFAULT 0 NOT NULL,
    cashback_commission_change_kopecks bigint DEFAULT 0 NOT NULL,
    seller_promo_discount_kopecks bigint DEFAULT 0 NOT NULL,
    loyalty_discount_kopecks bigint DEFAULT 0 NOT NULL,
    wb_discount_percent integer DEFAULT 0 NOT NULL,
    installment_cofinancing_kopecks bigint DEFAULT 0 NOT NULL,
    promotion_kopecks bigint DEFAULT 0 NOT NULL,
    shop_id bigint NOT NULL,
    spp_amount_kopecks bigint DEFAULT 0 NOT NULL,
    ppvz_vw_kopecks bigint DEFAULT 0 NOT NULL,
    ppvz_reward_kopecks bigint DEFAULT 0 NOT NULL,
    supplier_promo_kopecks bigint DEFAULT 0 NOT NULL,
    product_discount_kopecks bigint DEFAULT 0 NOT NULL,
    ppvz_spp_prc integer DEFAULT 0 NOT NULL,
    returns_sum_kopecks bigint DEFAULT 0 NOT NULL,
    rr_date text,
    report_id bigint,
    sale_qty integer DEFAULT 0 NOT NULL
);


--
-- Name: wb_finance_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_finance_reports (
    workspace_id bigint NOT NULL,
    shop_id bigint NOT NULL,
    report_id bigint NOT NULL,
    seller_finance_name text,
    date_from date NOT NULL,
    date_to date NOT NULL,
    create_date date NOT NULL,
    currency text DEFAULT 'RUB'::text NOT NULL,
    report_type integer DEFAULT 1 NOT NULL,
    retail_amount_kopecks bigint DEFAULT 0 NOT NULL,
    for_pay_kopecks bigint DEFAULT 0 NOT NULL,
    delivery_service_kopecks bigint DEFAULT 0 NOT NULL,
    paid_storage_kopecks bigint DEFAULT 0 NOT NULL,
    paid_acceptance_kopecks bigint DEFAULT 0 NOT NULL,
    deduction_kopecks bigint DEFAULT 0 NOT NULL,
    penalty_kopecks bigint DEFAULT 0 NOT NULL,
    additional_payment_kopecks bigint DEFAULT 0 NOT NULL,
    cashback_amount_kopecks bigint DEFAULT 0 NOT NULL,
    cashback_discount_kopecks bigint DEFAULT 0 NOT NULL,
    cashback_commission_change_kopecks bigint DEFAULT 0 NOT NULL,
    payment_schedule_kopecks bigint DEFAULT 0 NOT NULL,
    bank_payment_kopecks bigint DEFAULT 0 NOT NULL,
    avg_sale_percent numeric(6,3),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wb_finance_weekly_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_finance_weekly_products (
    workspace_id bigint NOT NULL,
    date_from text NOT NULL,
    date_to text NOT NULL,
    nm_id bigint NOT NULL,
    lines integer DEFAULT 0 NOT NULL,
    revenue_kopecks bigint DEFAULT 0 NOT NULL,
    income_from_sales_kopecks bigint DEFAULT 0 NOT NULL,
    logistics_kopecks bigint DEFAULT 0 NOT NULL,
    paid_acceptance_kopecks bigint DEFAULT 0 NOT NULL,
    storage_kopecks bigint DEFAULT 0 NOT NULL,
    penalties_kopecks bigint DEFAULT 0 NOT NULL,
    other_hold_kopecks bigint DEFAULT 0 NOT NULL,
    additional_payments_kopecks bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_funnel_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_funnel_daily (
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    source text NOT NULL,
    view_count integer DEFAULT 0 NOT NULL,
    open_card_count integer DEFAULT 0 NOT NULL,
    add_to_cart_count integer DEFAULT 0 NOT NULL,
    add_to_wishlist_count integer DEFAULT 0 NOT NULL,
    order_count integer DEFAULT 0 NOT NULL,
    order_sum bigint DEFAULT 0 NOT NULL,
    buyout_count integer DEFAULT 0 NOT NULL,
    buyout_sum bigint DEFAULT 0 NOT NULL,
    view_to_open_conversion_bp integer DEFAULT 0 NOT NULL,
    open_to_cart_conversion_bp integer DEFAULT 0 NOT NULL,
    cart_to_order_conversion_bp integer DEFAULT 0 NOT NULL,
    buyout_percent_bp integer DEFAULT 0 NOT NULL,
    products_count integer DEFAULT 0 NOT NULL,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cancel_count integer DEFAULT 0 NOT NULL,
    cancel_sum bigint DEFAULT 0 NOT NULL,
    shop_id bigint NOT NULL
);


--
-- Name: wb_funnel_daily_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_funnel_daily_products (
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    nm_id bigint NOT NULL,
    view_count integer DEFAULT 0 NOT NULL,
    open_card_count integer DEFAULT 0 NOT NULL,
    add_to_cart_count integer DEFAULT 0 NOT NULL,
    add_to_wishlist_count integer DEFAULT 0 NOT NULL,
    order_count integer DEFAULT 0 NOT NULL,
    order_sum bigint DEFAULT 0 NOT NULL,
    buyout_count integer DEFAULT 0 NOT NULL,
    buyout_sum bigint DEFAULT 0 NOT NULL,
    buyout_percent_bp integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cancel_count integer DEFAULT 0 NOT NULL,
    cancel_sum bigint DEFAULT 0 NOT NULL,
    shop_id bigint NOT NULL
);


--
-- Name: wb_hidden_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_hidden_products (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    reason text,
    hidden_at timestamp with time zone,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    is_resolved boolean DEFAULT false,
    resolved_at timestamp with time zone,
    shop_id bigint
);


--
-- Name: wb_hidden_products_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_hidden_products ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_hidden_products_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_orders_sales_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_orders_sales_daily (
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    orders_count integer DEFAULT 0 NOT NULL,
    sales_count integer DEFAULT 0 NOT NULL,
    sales_rub bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    orders_rub bigint DEFAULT 0 NOT NULL,
    discount_percent_sum_bp bigint DEFAULT 0 NOT NULL,
    finished_price_rub bigint DEFAULT 0 NOT NULL,
    shop_id bigint NOT NULL
);


--
-- Name: wb_orders_sales_daily_product_regions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_orders_sales_daily_product_regions (
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    nm_id bigint NOT NULL,
    region_name text NOT NULL,
    orders_count integer DEFAULT 0 NOT NULL,
    sales_count integer DEFAULT 0 NOT NULL,
    sales_rub bigint DEFAULT 0 NOT NULL,
    for_pay_rub bigint DEFAULT 0 NOT NULL,
    orders_rub bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_orders_sales_daily_product_warehouses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_orders_sales_daily_product_warehouses (
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    nm_id bigint NOT NULL,
    warehouse_name text NOT NULL,
    orders_count integer DEFAULT 0 NOT NULL,
    sales_count integer DEFAULT 0 NOT NULL,
    sales_rub bigint DEFAULT 0 NOT NULL,
    for_pay_rub bigint DEFAULT 0 NOT NULL,
    orders_rub bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_orders_sales_daily_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_orders_sales_daily_products (
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    nm_id bigint NOT NULL,
    orders_count integer DEFAULT 0 NOT NULL,
    sales_count integer DEFAULT 0 NOT NULL,
    sales_rub bigint DEFAULT 0 NOT NULL,
    for_pay_rub bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    orders_rub bigint DEFAULT 0 NOT NULL,
    discount_percent_sum_bp bigint DEFAULT 0 NOT NULL,
    finished_price_rub bigint DEFAULT 0 NOT NULL,
    shop_id bigint NOT NULL
);


--
-- Name: wb_orders_sales_daily_regions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_orders_sales_daily_regions (
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    region_name text NOT NULL,
    orders_count integer DEFAULT 0 NOT NULL,
    sales_count integer DEFAULT 0 NOT NULL,
    sales_rub bigint DEFAULT 0 NOT NULL,
    for_pay_rub bigint DEFAULT 0 NOT NULL,
    orders_rub bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_orders_sales_daily_warehouses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_orders_sales_daily_warehouses (
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    warehouse_name text NOT NULL,
    orders_count integer DEFAULT 0 NOT NULL,
    sales_count integer DEFAULT 0 NOT NULL,
    sales_rub bigint DEFAULT 0 NOT NULL,
    for_pay_rub bigint DEFAULT 0 NOT NULL,
    orders_rub bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_prices_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_prices_history (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    date timestamp with time zone NOT NULL,
    price integer,
    discount integer,
    spp integer,
    club_discount integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_prices_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_prices_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_prices_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_reconciliation_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_reconciliation_log (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    check_name text NOT NULL,
    expected bigint DEFAULT 0 NOT NULL,
    actual bigint DEFAULT 0 NOT NULL,
    delta bigint DEFAULT 0 NOT NULL,
    delta_percent real DEFAULT 0 NOT NULL,
    status text DEFAULT 'ok'::text NOT NULL,
    details text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_reconciliation_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_reconciliation_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_reconciliation_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_region_sales; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_region_sales (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    date timestamp with time zone NOT NULL,
    region_id integer,
    region_name text,
    district_name text,
    orders integer DEFAULT 0,
    sales integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_region_sales_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_region_sales ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_region_sales_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_returns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_returns (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    return_id bigint NOT NULL,
    order_id bigint,
    nm_id bigint,
    status text,
    reason text,
    customer_comment text,
    photos jsonb,
    approved_at timestamp with time zone,
    rejected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_returns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_returns ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_returns_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_search_queries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_search_queries (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    date timestamp with time zone NOT NULL,
    query text NOT NULL,
    "position" integer,
    views integer DEFAULT 0,
    clicks integer DEFAULT 0,
    orders integer DEFAULT 0,
    ctr real DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_search_queries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_search_queries ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_search_queries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_self_purchases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_self_purchases (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    shop_id bigint,
    nm_id bigint,
    date text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    amount_kopecks bigint DEFAULT 0 NOT NULL,
    purpose text,
    order_id text,
    comment text,
    created_by_user_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wb_self_purchases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_self_purchases ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_self_purchases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_shops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_shops (
    shop_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    name text NOT NULL,
    wb_api_key text NOT NULL,
    wb_delivery_type text DEFAULT 'fbs'::text NOT NULL,
    tax_regime text DEFAULT 'usn15'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    vat_pct numeric(5,2) DEFAULT 0 NOT NULL
);


--
-- Name: wb_shops_shop_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_shops ALTER COLUMN shop_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_shops_shop_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_spp_weekly; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_spp_weekly (
    workspace_id bigint NOT NULL,
    date_from text NOT NULL,
    date_to text NOT NULL,
    nm_id bigint NOT NULL,
    spp_pct_bp integer DEFAULT 0 NOT NULL,
    lines integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_stocks_current; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_stocks_current (
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    quantity integer DEFAULT 0 NOT NULL,
    warehouse_name text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    in_way_to_client integer DEFAULT 0 NOT NULL,
    in_way_from_client integer DEFAULT 0 NOT NULL,
    product_title text,
    days_of_stock integer,
    shop_id bigint NOT NULL
);


--
-- Name: wb_stocks_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_stocks_daily (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    date timestamp with time zone NOT NULL,
    warehouse_id integer,
    warehouse_name text,
    qty integer DEFAULT 0,
    in_way_to_client integer DEFAULT 0,
    in_way_from_client integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_stocks_daily_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_stocks_daily ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_stocks_daily_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_stocks_daily_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_stocks_daily_products (
    workspace_id bigint NOT NULL,
    date text NOT NULL,
    nm_id bigint NOT NULL,
    quantity integer DEFAULT 0 NOT NULL,
    in_way_to_client integer DEFAULT 0 NOT NULL,
    in_way_from_client integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint NOT NULL
);


--
-- Name: wb_stocks_fbs_current; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_stocks_fbs_current (
    workspace_id bigint NOT NULL,
    shop_id bigint NOT NULL,
    warehouse_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    sku text NOT NULL,
    quantity integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wb_storage_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_storage_daily (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    date timestamp with time zone NOT NULL,
    warehouse_id integer,
    warehouse_name text,
    volume real,
    cost integer,
    days integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_storage_daily_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_storage_daily ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_storage_daily_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_supplies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_supplies (
    id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    wb_supply_id integer,
    wb_preorder_id integer NOT NULL,
    status_id smallint DEFAULT 1 NOT NULL,
    box_type_id smallint,
    warehouse_id integer,
    warehouse_name text,
    transit_warehouse_id integer,
    transit_warehouse_name text,
    supply_date date,
    fact_date timestamp with time zone,
    acceptance_cost integer,
    paid_acceptance_coef real,
    storage_coef text,
    delivery_coef text,
    quantity integer DEFAULT 0,
    accepted_quantity integer DEFAULT 0,
    ready_for_sale_qty integer DEFAULT 0,
    phone text,
    reject_reason text,
    is_box_on_pallet boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    synced_at timestamp with time zone,
    shop_id bigint
);


--
-- Name: wb_supplies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_supplies ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_supplies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_supply_box_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_supply_box_items (
    id bigint NOT NULL,
    box_id bigint NOT NULL,
    barcode text NOT NULL,
    quantity integer NOT NULL
);


--
-- Name: wb_supply_box_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_supply_box_items ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_supply_box_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_supply_boxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_supply_boxes (
    id bigint NOT NULL,
    supply_id bigint NOT NULL,
    package_code text NOT NULL,
    quantity integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wb_supply_boxes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_supply_boxes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_supply_boxes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_supply_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_supply_items (
    id bigint NOT NULL,
    supply_id bigint NOT NULL,
    barcode text NOT NULL,
    vendor_code text,
    nm_id bigint,
    quantity integer NOT NULL,
    accepted_quantity integer DEFAULT 0,
    ready_for_sale_qty integer DEFAULT 0,
    need_kiz boolean DEFAULT false,
    tnved text,
    tech_size text,
    color text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wb_supply_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_supply_items ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_supply_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_tag_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_tag_products (
    workspace_id bigint NOT NULL,
    tag_id bigint NOT NULL,
    nm_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_tags (
    tag_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    name text NOT NULL,
    color text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    shop_id bigint
);


--
-- Name: wb_tags_tag_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_tags ALTER COLUMN tag_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_tags_tag_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_transit_tariffs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_transit_tariffs (
    id bigint NOT NULL,
    transit_warehouse_name text NOT NULL,
    destination_warehouse_name text NOT NULL,
    active_from timestamp with time zone,
    box_tariff jsonb,
    pallet_tariff integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: wb_transit_tariffs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.wb_transit_tariffs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.wb_transit_tariffs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: wb_warehouses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wb_warehouses (
    id integer NOT NULL,
    name text NOT NULL,
    address text,
    work_time text,
    is_active boolean DEFAULT true,
    is_transit_active boolean DEFAULT false,
    updated_at timestamp with time zone DEFAULT now(),
    region text
);


--
-- Name: workspace_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_invites (
    invite_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    role text DEFAULT 'viewer'::text NOT NULL,
    token text NOT NULL,
    created_by bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    used_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_invites_invite_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.workspace_invites ALTER COLUMN invite_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.workspace_invites_invite_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: workspace_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_members (
    workspace_id bigint NOT NULL,
    user_id bigint NOT NULL,
    role text DEFAULT 'viewer'::text NOT NULL,
    invited_by bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: COLUMN workspace_members.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspace_members.role IS 'owner | manager | viewer';


--
-- Name: workspace_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_payments (
    payment_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    provider text DEFAULT 'manual'::text NOT NULL,
    provider_payment_id text,
    amount_kopecks bigint DEFAULT 0 NOT NULL,
    currency text DEFAULT 'RUB'::text NOT NULL,
    subscription_type text,
    days_added integer,
    status text DEFAULT 'completed'::text NOT NULL,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_payments_payment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.workspace_payments ALTER COLUMN payment_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.workspace_payments_payment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: workspace_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_subscriptions (
    subscription_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    status text DEFAULT 'inactive'::text NOT NULL,
    plan_code text,
    provider text,
    current_period_end timestamp with time zone,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    current_period_start timestamp with time zone,
    auto_renew boolean DEFAULT true NOT NULL,
    cancel_at_period_end boolean DEFAULT false NOT NULL
);


--
-- Name: workspace_subscriptions_subscription_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.workspace_subscriptions ALTER COLUMN subscription_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.workspace_subscriptions_subscription_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    workspace_id bigint NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    audit_version text,
    CONSTRAINT workspaces_audit_version_check CHECK (((audit_version IS NULL) OR (audit_version = ANY (ARRAY['v3'::text, 'v5_council'::text]))))
);


--
-- Name: COLUMN workspaces.audit_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspaces.audit_version IS 'Override for which creative-audit pipeline runs for this workspace. NULL = fallback to env AUDIT_VERSION which itself falls back to ''v3''. Allowed values: ''v3'', ''v5_council''.';


--
-- Name: workspaces_workspace_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.workspaces ALTER COLUMN workspace_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.workspaces_workspace_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: agent_domain_rules rule_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_domain_rules ALTER COLUMN rule_id SET DEFAULT nextval('public.agent_domain_rules_rule_id_seq'::regclass);


--
-- Name: agent_supply_recommendations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_supply_recommendations ALTER COLUMN id SET DEFAULT nextval('public.agent_supply_recommendations_id_seq'::regclass);


--
-- Name: supply_roi_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_roi_history ALTER COLUMN id SET DEFAULT nextval('public.supply_roi_history_id_seq'::regclass);


--
-- Name: tg_chat_messages msg_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tg_chat_messages ALTER COLUMN msg_id SET DEFAULT nextval('public.tg_chat_messages_msg_id_seq'::regclass);


--
-- Name: tg_chat_sessions session_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tg_chat_sessions ALTER COLUMN session_id SET DEFAULT nextval('public.tg_chat_sessions_session_id_seq'::regclass);


--
-- Name: wb_card_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_card_snapshots ALTER COLUMN id SET DEFAULT nextval('public.wb_card_snapshots_id_seq'::regclass);


--
-- Name: wb_fbs_supplies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_fbs_supplies ALTER COLUMN id SET DEFAULT nextval('public.wb_fbs_supplies_id_seq'::regclass);


--
-- Name: wb_fbs_supply_orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_fbs_supply_orders ALTER COLUMN id SET DEFAULT nextval('public.wb_fbs_supply_orders_id_seq'::regclass);


--
-- Name: ab_photo_metrics ab_photo_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_photo_metrics
    ADD CONSTRAINT ab_photo_metrics_pkey PRIMARY KEY (metric_id);


--
-- Name: ab_photo_metrics ab_photo_metrics_test_id_variant_date_hour_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_photo_metrics
    ADD CONSTRAINT ab_photo_metrics_test_id_variant_date_hour_key UNIQUE (test_id, variant, date, hour);


--
-- Name: ab_photo_phases ab_photo_phases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_photo_phases
    ADD CONSTRAINT ab_photo_phases_pkey PRIMARY KEY (phase_id);


--
-- Name: ab_photo_tests ab_photo_tests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_photo_tests
    ADD CONSTRAINT ab_photo_tests_pkey PRIMARY KEY (test_id);


--
-- Name: ab_photo_uploads ab_photo_uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_photo_uploads
    ADD CONSTRAINT ab_photo_uploads_pkey PRIMARY KEY (upload_id);


--
-- Name: agent_actions agent_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_actions
    ADD CONSTRAINT agent_actions_pkey PRIMARY KEY (action_id);


--
-- Name: agent_conversations agent_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_conversations
    ADD CONSTRAINT agent_conversations_pkey PRIMARY KEY (conversation_id);


--
-- Name: agent_domain_rules agent_domain_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_domain_rules
    ADD CONSTRAINT agent_domain_rules_pkey PRIMARY KEY (rule_id);


--
-- Name: agent_events agent_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_events
    ADD CONSTRAINT agent_events_pkey PRIMARY KEY (event_id);


--
-- Name: agent_execution_runs agent_execution_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_execution_runs
    ADD CONSTRAINT agent_execution_runs_pkey PRIMARY KEY (run_id);


--
-- Name: agent_locks agent_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_locks
    ADD CONSTRAINT agent_locks_pkey PRIMARY KEY (lock_id);


--
-- Name: agent_messages agent_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_messages
    ADD CONSTRAINT agent_messages_pkey PRIMARY KEY (message_id);


--
-- Name: agent_run_results agent_run_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_results
    ADD CONSTRAINT agent_run_results_pkey PRIMARY KEY (run_id);


--
-- Name: agent_settings agent_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_settings
    ADD CONSTRAINT agent_settings_pkey PRIMARY KEY (setting_id);


--
-- Name: agent_supply_recommendations agent_supply_recommendations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_supply_recommendations
    ADD CONSTRAINT agent_supply_recommendations_pkey PRIMARY KEY (id);


--
-- Name: agent_tasks agent_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tasks
    ADD CONSTRAINT agent_tasks_pkey PRIMARY KEY (task_id);


--
-- Name: agent_verification_checks agent_verification_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_verification_checks
    ADD CONSTRAINT agent_verification_checks_pkey PRIMARY KEY (check_id);


--
-- Name: ai_provider_settings ai_provider_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_provider_settings
    ADD CONSTRAINT ai_provider_settings_pkey PRIMARY KEY (provider);


--
-- Name: ai_token_balance ai_token_balance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_balance
    ADD CONSTRAINT ai_token_balance_pkey PRIMARY KEY (id);


--
-- Name: ai_token_balance ai_token_balance_workspace_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_balance
    ADD CONSTRAINT ai_token_balance_workspace_uniq UNIQUE (workspace_id);


--
-- Name: ai_token_transactions ai_token_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_transactions
    ADD CONSTRAINT ai_token_transactions_pkey PRIMARY KEY (id);


--
-- Name: ai_usage_events ai_usage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage_events
    ADD CONSTRAINT ai_usage_events_pkey PRIMARY KEY (usage_id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (log_id);


--
-- Name: bidder_actions bidder_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_actions
    ADD CONSTRAINT bidder_actions_pkey PRIMARY KEY (action_id);


--
-- Name: bidder_alerts bidder_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_alerts
    ADD CONSTRAINT bidder_alerts_pkey PRIMARY KEY (alert_id);


--
-- Name: bidder_keyword_auto_rules bidder_keyword_auto_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_keyword_auto_rules
    ADD CONSTRAINT bidder_keyword_auto_rules_pkey PRIMARY KEY (rule_id);


--
-- Name: bidder_keywords bidder_keywords_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_keywords
    ADD CONSTRAINT bidder_keywords_pkey PRIMARY KEY (keyword_id);


--
-- Name: bidder_rules bidder_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_rules
    ADD CONSTRAINT bidder_rules_pkey PRIMARY KEY (rule_id);


--
-- Name: bidder_settings bidder_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_settings
    ADD CONSTRAINT bidder_settings_pkey PRIMARY KEY (workspace_id);


--
-- Name: cashflow_categories cashflow_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_categories
    ADD CONSTRAINT cashflow_categories_pkey PRIMARY KEY (category_id);


--
-- Name: cashflow_entries cashflow_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_entries
    ADD CONSTRAINT cashflow_entries_pkey PRIMARY KEY (entry_id);


--
-- Name: cashflow_planned_items cashflow_planned_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_planned_items
    ADD CONSTRAINT cashflow_planned_items_pkey PRIMARY KEY (item_id);


--
-- Name: cashflow_settings cashflow_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_settings
    ADD CONSTRAINT cashflow_settings_pkey PRIMARY KEY (workspace_id);


--
-- Name: cashflow_wb_payouts cashflow_wb_payouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_wb_payouts
    ADD CONSTRAINT cashflow_wb_payouts_pkey PRIMARY KEY (payout_id);


--
-- Name: checkpoint_blobs checkpoint_blobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkpoint_blobs
    ADD CONSTRAINT checkpoint_blobs_pkey PRIMARY KEY (thread_id, checkpoint_ns, channel, version);


--
-- Name: checkpoint_migrations checkpoint_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkpoint_migrations
    ADD CONSTRAINT checkpoint_migrations_pkey PRIMARY KEY (v);


--
-- Name: checkpoint_writes checkpoint_writes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkpoint_writes
    ADD CONSTRAINT checkpoint_writes_pkey PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx);


--
-- Name: checkpoints checkpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checkpoints
    ADD CONSTRAINT checkpoints_pkey PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id);


--
-- Name: creative_audit_experiments creative_audit_experiments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_experiments
    ADD CONSTRAINT creative_audit_experiments_pkey PRIMARY KEY (experiment_id);


--
-- Name: creative_audit_jobs creative_audit_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_jobs
    ADD CONSTRAINT creative_audit_jobs_pkey PRIMARY KEY (job_id);


--
-- Name: creative_audit_runs_final creative_audit_runs_final_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_runs_final
    ADD CONSTRAINT creative_audit_runs_final_pkey PRIMARY KEY (id);


--
-- Name: creative_audit_runs creative_audit_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_runs
    ADD CONSTRAINT creative_audit_runs_pkey PRIMARY KEY (audit_id);


--
-- Name: creative_card_audit_runs creative_card_audit_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_card_audit_runs
    ADD CONSTRAINT creative_card_audit_runs_pkey PRIMARY KEY (id);


--
-- Name: creative_card_snapshots creative_card_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_card_snapshots
    ADD CONSTRAINT creative_card_snapshots_pkey PRIMARY KEY (snapshot_id);


--
-- Name: creative_image_generations creative_image_generations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_image_generations
    ADD CONSTRAINT creative_image_generations_pkey PRIMARY KEY (generation_id);


--
-- Name: creative_photo_audit_runs creative_photo_audit_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_photo_audit_runs
    ADD CONSTRAINT creative_photo_audit_runs_pkey PRIMARY KEY (id);


--
-- Name: creative_visual_assets creative_visual_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_visual_assets
    ADD CONSTRAINT creative_visual_assets_pkey PRIMARY KEY (asset_id);


--
-- Name: creative_visual_jobs creative_visual_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_visual_jobs
    ADD CONSTRAINT creative_visual_jobs_pkey PRIMARY KEY (job_id);


--
-- Name: creative_visual_slides creative_visual_slides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_visual_slides
    ADD CONSTRAINT creative_visual_slides_pkey PRIMARY KEY (slide_id);


--
-- Name: document_chunks document_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_chunks
    ADD CONSTRAINT document_chunks_pkey PRIMARY KEY (chunk_id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (document_id);


--
-- Name: fbs_documents fbs_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fbs_documents
    ADD CONSTRAINT fbs_documents_pkey PRIMARY KEY (doc_id);


--
-- Name: fbs_runs fbs_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fbs_runs
    ADD CONSTRAINT fbs_runs_pkey PRIMARY KEY (run_id);


--
-- Name: fbs_schedules fbs_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fbs_schedules
    ADD CONSTRAINT fbs_schedules_pkey PRIMARY KEY (schedule_id);


--
-- Name: feedback_reply_log feedback_reply_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback_reply_log
    ADD CONSTRAINT feedback_reply_log_pkey PRIMARY KEY (log_id);


--
-- Name: holiday_calendar holiday_calendar_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.holiday_calendar
    ADD CONSTRAINT holiday_calendar_pkey PRIMARY KEY (date);


--
-- Name: insight_settings insight_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insight_settings
    ADD CONSTRAINT insight_settings_pkey PRIMARY KEY (workspace_id);


--
-- Name: insights insights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insights
    ADD CONSTRAINT insights_pkey PRIMARY KEY (insight_id);


--
-- Name: knowledge_entries knowledge_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_entries
    ADD CONSTRAINT knowledge_entries_pkey PRIMARY KEY (entry_id);


--
-- Name: marketplace_feedback_analysis marketplace_feedback_analysis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_feedback_analysis
    ADD CONSTRAINT marketplace_feedback_analysis_pkey PRIMARY KEY (analysis_id);


--
-- Name: marketplace_feedback_items marketplace_feedback_items_workspace_id_marketplace_item_type_i; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_feedback_items
    ADD CONSTRAINT marketplace_feedback_items_workspace_id_marketplace_item_type_i PRIMARY KEY (workspace_id, marketplace, item_type, item_id);


--
-- Name: marketplace_reply_drafts marketplace_reply_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_reply_drafts
    ADD CONSTRAINT marketplace_reply_drafts_pkey PRIMARY KEY (draft_id);


--
-- Name: marketplace_reply_settings marketplace_reply_settings_workspace_id_marketplace_item_type_p; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_reply_settings
    ADD CONSTRAINT marketplace_reply_settings_workspace_id_marketplace_item_type_p PRIMARY KEY (workspace_id, marketplace, item_type);


--
-- Name: marketplace_shops marketplace_shops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_shops
    ADD CONSTRAINT marketplace_shops_pkey PRIMARY KEY (shop_id);


--
-- Name: notification_dedup notification_dedup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_dedup
    ADD CONSTRAINT notification_dedup_pkey PRIMARY KEY (kind, shop_id, sent_date);


--
-- Name: notification_settings notification_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_settings
    ADD CONSTRAINT notification_settings_pkey PRIMARY KEY (setting_id);


--
-- Name: notification_settings notification_settings_workspace_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_settings
    ADD CONSTRAINT notification_settings_workspace_id_user_id_key UNIQUE (workspace_id, user_id);


--
-- Name: price_ab_phases price_ab_phases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_ab_phases
    ADD CONSTRAINT price_ab_phases_pkey PRIMARY KEY (phase_id);


--
-- Name: price_ab_tests price_ab_tests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_ab_tests
    ADD CONSTRAINT price_ab_tests_pkey PRIMARY KEY (test_id);


--
-- Name: pricing_decisions pricing_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_decisions
    ADD CONSTRAINT pricing_decisions_pkey PRIMARY KEY (decision_id);


--
-- Name: pricing_strategies pricing_strategies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_strategies
    ADD CONSTRAINT pricing_strategies_pkey PRIMARY KEY (strategy_id);


--
-- Name: pulse_alert_controls pulse_alert_controls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_alert_controls
    ADD CONSTRAINT pulse_alert_controls_pkey PRIMARY KEY (control_id);


--
-- Name: pulse_metric_groups pulse_metric_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_metric_groups
    ADD CONSTRAINT pulse_metric_groups_pkey PRIMARY KEY (group_id);


--
-- Name: pulse_metrics_catalog pulse_metrics_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_metrics_catalog
    ADD CONSTRAINT pulse_metrics_catalog_pkey PRIMARY KEY (metric_id);


--
-- Name: pulse_migration_failures pulse_migration_failures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_migration_failures
    ADD CONSTRAINT pulse_migration_failures_pkey PRIMARY KEY (failure_id);


--
-- Name: pulse_migrations pulse_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_migrations
    ADD CONSTRAINT pulse_migrations_pkey PRIMARY KEY (name);


--
-- Name: pulse_plans pulse_plans_workspace_id_date_nm_id_metric_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_plans
    ADD CONSTRAINT pulse_plans_workspace_id_date_nm_id_metric_pk PRIMARY KEY (workspace_id, date, nm_id, metric);


--
-- Name: pulse_preset_events pulse_preset_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_preset_events
    ADD CONSTRAINT pulse_preset_events_pkey PRIMARY KEY (event_id);


--
-- Name: pulse_preset_group_settings pulse_preset_group_settings_preset_id_group_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_preset_group_settings
    ADD CONSTRAINT pulse_preset_group_settings_preset_id_group_id_pk PRIMARY KEY (preset_id, group_id);


--
-- Name: pulse_preset_metric_settings pulse_preset_metric_settings_preset_id_metric_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_preset_metric_settings
    ADD CONSTRAINT pulse_preset_metric_settings_preset_id_metric_id_pk PRIMARY KEY (preset_id, metric_id);


--
-- Name: pulse_presets pulse_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_presets
    ADD CONSTRAINT pulse_presets_pkey PRIMARY KEY (preset_id);


--
-- Name: region_warehouse_mapping region_warehouse_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.region_warehouse_mapping
    ADD CONSTRAINT region_warehouse_mapping_pkey PRIMARY KEY (id);


--
-- Name: region_warehouse_mapping region_warehouse_mapping_region_name_warehouse_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.region_warehouse_mapping
    ADD CONSTRAINT region_warehouse_mapping_region_name_warehouse_id_key UNIQUE (region_name, warehouse_id);


--
-- Name: sales_monthly_targets_per_nm sales_monthly_targets_per_nm_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_monthly_targets_per_nm
    ADD CONSTRAINT sales_monthly_targets_per_nm_pkey PRIMARY KEY (workspace_id, shop_id, month, nm_id);


--
-- Name: sales_monthly_targets sales_monthly_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sales_monthly_targets
    ADD CONSTRAINT sales_monthly_targets_pkey PRIMARY KEY (workspace_id, shop_id, month);


--
-- Name: seo_addresses seo_addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_addresses
    ADD CONSTRAINT seo_addresses_pkey PRIMARY KEY (address_id);


--
-- Name: seo_alerts seo_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_alerts
    ADD CONSTRAINT seo_alerts_pkey PRIMARY KEY (alert_id);


--
-- Name: seo_competitor_keywords seo_competitor_keywords_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_competitor_keywords
    ADD CONSTRAINT seo_competitor_keywords_pkey PRIMARY KEY (competitor_id, keyword_id);


--
-- Name: seo_competitor_positions seo_competitor_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_competitor_positions
    ADD CONSTRAINT seo_competitor_positions_pkey PRIMARY KEY (position_id);


--
-- Name: seo_competitors seo_competitors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_competitors
    ADD CONSTRAINT seo_competitors_pkey PRIMARY KEY (competitor_id);


--
-- Name: seo_jobs seo_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_jobs
    ADD CONSTRAINT seo_jobs_pkey PRIMARY KEY (job_id);


--
-- Name: seo_keyword_products seo_keyword_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_keyword_products
    ADD CONSTRAINT seo_keyword_products_pkey PRIMARY KEY (keyword_id, nm_id);


--
-- Name: seo_keyword_tag_links seo_keyword_tag_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_keyword_tag_links
    ADD CONSTRAINT seo_keyword_tag_links_pkey PRIMARY KEY (keyword_id, tag_id);


--
-- Name: seo_keyword_tags seo_keyword_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_keyword_tags
    ADD CONSTRAINT seo_keyword_tags_pkey PRIMARY KEY (tag_id);


--
-- Name: seo_keywords seo_keywords_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_keywords
    ADD CONSTRAINT seo_keywords_pkey PRIMARY KEY (keyword_id);


--
-- Name: seo_position_snapshots seo_position_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_position_snapshots
    ADD CONSTRAINT seo_position_snapshots_pkey PRIMARY KEY (snapshot_id);


--
-- Name: seo_settings seo_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_settings
    ADD CONSTRAINT seo_settings_pkey PRIMARY KEY (workspace_id);


--
-- Name: signup_waitlist signup_waitlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signup_waitlist
    ADD CONSTRAINT signup_waitlist_pkey PRIMARY KEY (id);


--
-- Name: studio_assets studio_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_assets
    ADD CONSTRAINT studio_assets_pkey PRIMARY KEY (asset_id);


--
-- Name: studio_credits studio_credits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_credits
    ADD CONSTRAINT studio_credits_pkey PRIMARY KEY (credit_id);


--
-- Name: studio_presets studio_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_presets
    ADD CONSTRAINT studio_presets_pkey PRIMARY KEY (preset_id);


--
-- Name: studio_projects studio_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_projects
    ADD CONSTRAINT studio_projects_pkey PRIMARY KEY (project_id);


--
-- Name: studio_prompt_suggestions studio_prompt_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_prompt_suggestions
    ADD CONSTRAINT studio_prompt_suggestions_pkey PRIMARY KEY (id);


--
-- Name: studio_tasks studio_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_tasks
    ADD CONSTRAINT studio_tasks_pkey PRIMARY KEY (task_id);


--
-- Name: supplies supplies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplies
    ADD CONSTRAINT supplies_pkey PRIMARY KEY (supply_id);


--
-- Name: supplies supplies_wb_supply_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplies
    ADD CONSTRAINT supplies_wb_supply_id_key UNIQUE (wb_supply_id);


--
-- Name: supply_booking_queue supply_booking_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_booking_queue
    ADD CONSTRAINT supply_booking_queue_pkey PRIMARY KEY (queue_id);


--
-- Name: supply_box_settings supply_box_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_box_settings
    ADD CONSTRAINT supply_box_settings_pkey PRIMARY KEY (id);


--
-- Name: supply_box_settings supply_box_settings_workspace_id_nm_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_box_settings
    ADD CONSTRAINT supply_box_settings_workspace_id_nm_id_key UNIQUE (workspace_id, nm_id);


--
-- Name: supply_boxes supply_boxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_boxes
    ADD CONSTRAINT supply_boxes_pkey PRIMARY KEY (box_id);


--
-- Name: supply_documents supply_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_documents
    ADD CONSTRAINT supply_documents_pkey PRIMARY KEY (doc_id);


--
-- Name: supply_draft_items supply_draft_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_draft_items
    ADD CONSTRAINT supply_draft_items_pkey PRIMARY KEY (item_id);


--
-- Name: supply_drafts supply_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_drafts
    ADD CONSTRAINT supply_drafts_pkey PRIMARY KEY (draft_id);


--
-- Name: supply_drivers supply_drivers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_drivers
    ADD CONSTRAINT supply_drivers_pkey PRIMARY KEY (driver_id);


--
-- Name: supply_passes supply_passes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_passes
    ADD CONSTRAINT supply_passes_pkey PRIMARY KEY (pass_id);


--
-- Name: supply_priority_warehouses supply_priority_warehouses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_priority_warehouses
    ADD CONSTRAINT supply_priority_warehouses_pkey PRIMARY KEY (id);


--
-- Name: supply_priority_warehouses supply_priority_warehouses_workspace_id_warehouse_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_priority_warehouses
    ADD CONSTRAINT supply_priority_warehouses_workspace_id_warehouse_id_key UNIQUE (workspace_id, warehouse_id);


--
-- Name: supply_roi_history supply_roi_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_roi_history
    ADD CONSTRAINT supply_roi_history_pkey PRIMARY KEY (id);


--
-- Name: supply_slots_cache supply_slots_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_slots_cache
    ADD CONSTRAINT supply_slots_cache_pkey PRIMARY KEY (cache_id);


--
-- Name: supply_slots_cache supply_slots_cache_workspace_id_warehouse_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_slots_cache
    ADD CONSTRAINT supply_slots_cache_workspace_id_warehouse_id_date_key UNIQUE (workspace_id, warehouse_id, date);


--
-- Name: system_events system_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_events
    ADD CONSTRAINT system_events_pkey PRIMARY KEY (event_id);


--
-- Name: tg_chat_messages tg_chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tg_chat_messages
    ADD CONSTRAINT tg_chat_messages_pkey PRIMARY KEY (msg_id);


--
-- Name: tg_chat_sessions tg_chat_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tg_chat_sessions
    ADD CONSTRAINT tg_chat_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: user_refresh_tokens user_refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_refresh_tokens
    ADD CONSTRAINT user_refresh_tokens_pkey PRIMARY KEY (session_id);


--
-- Name: user_sessions user_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_pkey PRIMARY KEY (session_id);


--
-- Name: user_telegram_link_codes user_telegram_link_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_telegram_link_codes
    ADD CONSTRAINT user_telegram_link_codes_pkey PRIMARY KEY (code);


--
-- Name: user_telegram_links user_telegram_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_telegram_links
    ADD CONSTRAINT user_telegram_links_pkey PRIMARY KEY (user_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (user_id);


--
-- Name: warehouse_region_mapping warehouse_region_mapping_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_region_mapping
    ADD CONSTRAINT warehouse_region_mapping_pkey PRIMARY KEY (id);


--
-- Name: warehouse_region_mapping warehouse_region_mapping_warehouse_id_region_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.warehouse_region_mapping
    ADD CONSTRAINT warehouse_region_mapping_warehouse_id_region_name_key UNIQUE (warehouse_id, region_name);


--
-- Name: wb_adv_daily_products wb_adv_daily_products_workspace_id_shop_id_date_nm_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_adv_daily_products
    ADD CONSTRAINT wb_adv_daily_products_workspace_id_shop_id_date_nm_id_pk PRIMARY KEY (workspace_id, shop_id, date, nm_id);


--
-- Name: wb_adv_daily wb_adv_daily_workspace_id_shop_id_date_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_adv_daily
    ADD CONSTRAINT wb_adv_daily_workspace_id_shop_id_date_pk PRIMARY KEY (workspace_id, shop_id, date);


--
-- Name: wb_adv_finance_daily wb_adv_finance_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_adv_finance_daily
    ADD CONSTRAINT wb_adv_finance_daily_pkey PRIMARY KEY (workspace_id, date);


--
-- Name: wb_adv_finance wb_adv_finance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_adv_finance
    ADD CONSTRAINT wb_adv_finance_pkey PRIMARY KEY (id);


--
-- Name: wb_alert_settings wb_alert_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_alert_settings
    ADD CONSTRAINT wb_alert_settings_pkey PRIMARY KEY (setting_id);


--
-- Name: wb_backfill_progress wb_backfill_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_backfill_progress
    ADD CONSTRAINT wb_backfill_progress_pkey PRIMARY KEY (workspace_id, shop_id, sync_type);


--
-- Name: wb_campaigns wb_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_campaigns
    ADD CONSTRAINT wb_campaigns_pkey PRIMARY KEY (campaign_id);


--
-- Name: wb_card_snapshots wb_card_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_card_snapshots
    ADD CONSTRAINT wb_card_snapshots_pkey PRIMARY KEY (id);


--
-- Name: wb_cards wb_cards_workspace_id_nm_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_cards
    ADD CONSTRAINT wb_cards_workspace_id_nm_id_pk PRIMARY KEY (workspace_id, nm_id);


--
-- Name: wb_chats wb_chats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_chats
    ADD CONSTRAINT wb_chats_pkey PRIMARY KEY (id);


--
-- Name: wb_cogs wb_cogs_workspace_id_nm_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_cogs
    ADD CONSTRAINT wb_cogs_workspace_id_nm_id_pk PRIMARY KEY (workspace_id, nm_id);


--
-- Name: wb_compensations wb_compensations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_compensations
    ADD CONSTRAINT wb_compensations_pkey PRIMARY KEY (id);


--
-- Name: wb_deductions_daily wb_deductions_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_deductions_daily
    ADD CONSTRAINT wb_deductions_daily_pkey PRIMARY KEY (id);


--
-- Name: wb_event_comments wb_event_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_event_comments
    ADD CONSTRAINT wb_event_comments_pkey PRIMARY KEY (comment_id);


--
-- Name: wb_events wb_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_events
    ADD CONSTRAINT wb_events_pkey PRIMARY KEY (event_id);


--
-- Name: wb_fbs_shipments_daily_products wb_fbs_shipments_daily_products_workspace_id_date_nm_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_fbs_shipments_daily_products
    ADD CONSTRAINT wb_fbs_shipments_daily_products_workspace_id_date_nm_id_pk PRIMARY KEY (workspace_id, date, nm_id);


--
-- Name: wb_fbs_supplies wb_fbs_supplies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_fbs_supplies
    ADD CONSTRAINT wb_fbs_supplies_pkey PRIMARY KEY (id);


--
-- Name: wb_fbs_supply_orders wb_fbs_supply_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_fbs_supply_orders
    ADD CONSTRAINT wb_fbs_supply_orders_pkey PRIMARY KEY (id);


--
-- Name: wb_finance_daily_products wb_finance_daily_products_workspace_id_shop_id_date_nm_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_finance_daily_products
    ADD CONSTRAINT wb_finance_daily_products_workspace_id_shop_id_date_nm_id_pk PRIMARY KEY (workspace_id, shop_id, date, nm_id);


--
-- Name: wb_finance_daily wb_finance_daily_workspace_id_shop_id_date_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_finance_daily
    ADD CONSTRAINT wb_finance_daily_workspace_id_shop_id_date_pk PRIMARY KEY (workspace_id, shop_id, date);


--
-- Name: wb_finance_reports wb_finance_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_finance_reports
    ADD CONSTRAINT wb_finance_reports_pkey PRIMARY KEY (workspace_id, shop_id, report_id);


--
-- Name: wb_finance_weekly_products wb_finance_weekly_products_workspace_id_date_from_date_to_nm_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_finance_weekly_products
    ADD CONSTRAINT wb_finance_weekly_products_workspace_id_date_from_date_to_nm_id PRIMARY KEY (workspace_id, date_from, date_to, nm_id);


--
-- Name: wb_funnel_daily_products wb_funnel_daily_products_workspace_id_shop_id_date_nm_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_funnel_daily_products
    ADD CONSTRAINT wb_funnel_daily_products_workspace_id_shop_id_date_nm_id_pk PRIMARY KEY (workspace_id, shop_id, date, nm_id);


--
-- Name: wb_funnel_daily wb_funnel_daily_workspace_id_shop_id_date_source_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_funnel_daily
    ADD CONSTRAINT wb_funnel_daily_workspace_id_shop_id_date_source_pk PRIMARY KEY (workspace_id, shop_id, date, source);


--
-- Name: wb_hidden_products wb_hidden_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_hidden_products
    ADD CONSTRAINT wb_hidden_products_pkey PRIMARY KEY (id);


--
-- Name: wb_orders_sales_daily_product_regions wb_orders_sales_daily_product_regions_workspace_id_date_nm_id_r; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_product_regions
    ADD CONSTRAINT wb_orders_sales_daily_product_regions_workspace_id_date_nm_id_r PRIMARY KEY (workspace_id, date, nm_id, region_name);


--
-- Name: wb_orders_sales_daily_product_warehouses wb_orders_sales_daily_product_warehouses_workspace_id_date_nm_i; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_product_warehouses
    ADD CONSTRAINT wb_orders_sales_daily_product_warehouses_workspace_id_date_nm_i PRIMARY KEY (workspace_id, date, nm_id, warehouse_name);


--
-- Name: wb_orders_sales_daily_products wb_orders_sales_daily_products_workspace_id_shop_id_date_nm_id_; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_products
    ADD CONSTRAINT wb_orders_sales_daily_products_workspace_id_shop_id_date_nm_id_ PRIMARY KEY (workspace_id, shop_id, date, nm_id);


--
-- Name: wb_orders_sales_daily_regions wb_orders_sales_daily_regions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_regions
    ADD CONSTRAINT wb_orders_sales_daily_regions_pkey PRIMARY KEY (workspace_id, date, region_name);


--
-- Name: wb_orders_sales_daily_warehouses wb_orders_sales_daily_warehouses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_warehouses
    ADD CONSTRAINT wb_orders_sales_daily_warehouses_pkey PRIMARY KEY (workspace_id, date, warehouse_name);


--
-- Name: wb_orders_sales_daily wb_orders_sales_daily_workspace_id_shop_id_date_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily
    ADD CONSTRAINT wb_orders_sales_daily_workspace_id_shop_id_date_pk PRIMARY KEY (workspace_id, shop_id, date);


--
-- Name: wb_prices_history wb_prices_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_prices_history
    ADD CONSTRAINT wb_prices_history_pkey PRIMARY KEY (id);


--
-- Name: wb_reconciliation_log wb_reconciliation_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_reconciliation_log
    ADD CONSTRAINT wb_reconciliation_log_pkey PRIMARY KEY (id);


--
-- Name: wb_region_sales wb_region_sales_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_region_sales
    ADD CONSTRAINT wb_region_sales_pkey PRIMARY KEY (id);


--
-- Name: wb_returns wb_returns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_returns
    ADD CONSTRAINT wb_returns_pkey PRIMARY KEY (id);


--
-- Name: wb_search_queries wb_search_queries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_search_queries
    ADD CONSTRAINT wb_search_queries_pkey PRIMARY KEY (id);


--
-- Name: wb_self_purchases wb_self_purchases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_self_purchases
    ADD CONSTRAINT wb_self_purchases_pkey PRIMARY KEY (id);


--
-- Name: wb_shops wb_shops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_shops
    ADD CONSTRAINT wb_shops_pkey PRIMARY KEY (shop_id);


--
-- Name: wb_spp_weekly wb_spp_weekly_workspace_id_date_from_date_to_nm_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_spp_weekly
    ADD CONSTRAINT wb_spp_weekly_workspace_id_date_from_date_to_nm_id_pk PRIMARY KEY (workspace_id, date_from, date_to, nm_id);


--
-- Name: wb_stocks_current wb_stocks_current_workspace_id_shop_id_nm_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_stocks_current
    ADD CONSTRAINT wb_stocks_current_workspace_id_shop_id_nm_id_pk PRIMARY KEY (workspace_id, shop_id, nm_id);


--
-- Name: wb_stocks_daily wb_stocks_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_stocks_daily
    ADD CONSTRAINT wb_stocks_daily_pkey PRIMARY KEY (id);


--
-- Name: wb_stocks_daily_products wb_stocks_daily_products_workspace_id_shop_id_date_nm_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_stocks_daily_products
    ADD CONSTRAINT wb_stocks_daily_products_workspace_id_shop_id_date_nm_id_pk PRIMARY KEY (workspace_id, shop_id, date, nm_id);


--
-- Name: wb_stocks_fbs_current wb_stocks_fbs_current_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_stocks_fbs_current
    ADD CONSTRAINT wb_stocks_fbs_current_pkey PRIMARY KEY (workspace_id, shop_id, warehouse_id, sku);


--
-- Name: wb_storage_daily wb_storage_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_storage_daily
    ADD CONSTRAINT wb_storage_daily_pkey PRIMARY KEY (id);


--
-- Name: wb_supplies wb_supplies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_supplies
    ADD CONSTRAINT wb_supplies_pkey PRIMARY KEY (id);


--
-- Name: wb_supplies wb_supplies_workspace_shop_preorder_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_supplies
    ADD CONSTRAINT wb_supplies_workspace_shop_preorder_uniq UNIQUE (workspace_id, shop_id, wb_preorder_id);


--
-- Name: wb_supply_box_items wb_supply_box_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_supply_box_items
    ADD CONSTRAINT wb_supply_box_items_pkey PRIMARY KEY (id);


--
-- Name: wb_supply_boxes wb_supply_boxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_supply_boxes
    ADD CONSTRAINT wb_supply_boxes_pkey PRIMARY KEY (id);


--
-- Name: wb_supply_items wb_supply_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_supply_items
    ADD CONSTRAINT wb_supply_items_pkey PRIMARY KEY (id);


--
-- Name: wb_sync_runs wb_sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_sync_runs
    ADD CONSTRAINT wb_sync_runs_pkey PRIMARY KEY (run_id);


--
-- Name: wb_tag_products wb_tag_products_workspace_id_tag_id_nm_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_tag_products
    ADD CONSTRAINT wb_tag_products_workspace_id_tag_id_nm_id_pk PRIMARY KEY (workspace_id, tag_id, nm_id);


--
-- Name: wb_tags wb_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_tags
    ADD CONSTRAINT wb_tags_pkey PRIMARY KEY (tag_id);


--
-- Name: wb_transit_tariffs wb_transit_tariffs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_transit_tariffs
    ADD CONSTRAINT wb_transit_tariffs_pkey PRIMARY KEY (id);


--
-- Name: wb_warehouses wb_warehouses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_warehouses
    ADD CONSTRAINT wb_warehouses_pkey PRIMARY KEY (id);


--
-- Name: workspace_invites workspace_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invites
    ADD CONSTRAINT workspace_invites_pkey PRIMARY KEY (invite_id);


--
-- Name: workspace_invites workspace_invites_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invites
    ADD CONSTRAINT workspace_invites_token_key UNIQUE (token);


--
-- Name: workspace_members workspace_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_pkey PRIMARY KEY (workspace_id, user_id);


--
-- Name: workspace_payments workspace_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_payments
    ADD CONSTRAINT workspace_payments_pkey PRIMARY KEY (payment_id);


--
-- Name: workspace_subscriptions workspace_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_subscriptions
    ADD CONSTRAINT workspace_subscriptions_pkey PRIMARY KEY (subscription_id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (workspace_id);


--
-- Name: ab_photo_metrics_phase_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ab_photo_metrics_phase_idx ON public.ab_photo_metrics USING btree (phase_id);


--
-- Name: ab_photo_metrics_test_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ab_photo_metrics_test_idx ON public.ab_photo_metrics USING btree (test_id, date);


--
-- Name: ab_photo_phases_test_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ab_photo_phases_test_idx ON public.ab_photo_phases USING btree (test_id, started_at);


--
-- Name: ab_photo_tests_archived_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ab_photo_tests_archived_idx ON public.ab_photo_tests USING btree (workspace_id, archived_at);


--
-- Name: ab_photo_tests_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ab_photo_tests_nm_idx ON public.ab_photo_tests USING btree (workspace_id, nm_id, created_at);


--
-- Name: ab_photo_tests_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ab_photo_tests_workspace_idx ON public.ab_photo_tests USING btree (workspace_id, created_at);


--
-- Name: ab_photo_uploads_test_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ab_photo_uploads_test_idx ON public.ab_photo_uploads USING btree (test_id, variant, "position");


--
-- Name: ab_photo_uploads_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ab_photo_uploads_workspace_idx ON public.ab_photo_uploads USING btree (workspace_id);


--
-- Name: agent_actions_agent_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_actions_agent_name_idx ON public.agent_actions USING btree (agent_name, created_at);


--
-- Name: agent_actions_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_actions_conversation_idx ON public.agent_actions USING btree (conversation_id);


--
-- Name: agent_actions_conversation_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_actions_conversation_status_idx ON public.agent_actions USING btree (conversation_id, status, queued_at);


--
-- Name: agent_actions_correlation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_actions_correlation_idx ON public.agent_actions USING btree (correlation_id);


--
-- Name: agent_actions_idempotency_key_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_actions_idempotency_key_uniq ON public.agent_actions USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: agent_actions_queue_pickup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_actions_queue_pickup_idx ON public.agent_actions USING btree (next_retry_at NULLS FIRST, queued_at NULLS FIRST) WHERE (status = ANY (ARRAY['queued'::text, 'failed:retryable'::text]));


--
-- Name: agent_actions_reply_feedback_dedup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_actions_reply_feedback_dedup_idx ON public.agent_actions USING btree (workspace_id, ((payload ->> 'feedbackId'::text))) WHERE ((action_type = 'reply_feedback'::text) AND (status = 'executed'::text));


--
-- Name: agent_actions_running_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_actions_running_started_idx ON public.agent_actions USING btree (started_at) WHERE (status = 'running'::text);


--
-- Name: agent_actions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_actions_status_idx ON public.agent_actions USING btree (status, created_at);


--
-- Name: agent_actions_verification_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_actions_verification_status_idx ON public.agent_actions USING btree (verification_status) WHERE ((verification_status IS NOT NULL) AND (verification_status <> 'verified'::text));


--
-- Name: agent_actions_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_actions_workspace_idx ON public.agent_actions USING btree (workspace_id, status);


--
-- Name: agent_actions_ws_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_actions_ws_shop_idx ON public.agent_actions USING btree (workspace_id, shop_id, created_at DESC);


--
-- Name: agent_conversations_thread_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_conversations_thread_uniq ON public.agent_conversations USING btree (thread_id);


--
-- Name: agent_conversations_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_conversations_user_idx ON public.agent_conversations USING btree (user_id);


--
-- Name: agent_conversations_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_conversations_workspace_idx ON public.agent_conversations USING btree (workspace_id, updated_at);


--
-- Name: agent_domain_rules_ws_shop_agent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_domain_rules_ws_shop_agent_idx ON public.agent_domain_rules USING btree (workspace_id, shop_id, agent_name);


--
-- Name: agent_events_correlation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_events_correlation_idx ON public.agent_events USING btree (correlation_id);


--
-- Name: agent_events_nmid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_events_nmid_idx ON public.agent_events USING btree (nm_id);


--
-- Name: agent_events_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_events_type_idx ON public.agent_events USING btree (event_type, created_at);


--
-- Name: agent_events_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_events_workspace_idx ON public.agent_events USING btree (workspace_id, status, created_at);


--
-- Name: agent_execution_runs_ws_shop_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_execution_runs_ws_shop_started_idx ON public.agent_execution_runs USING btree (workspace_id, shop_id, started_at);


--
-- Name: agent_locks_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_locks_expires_idx ON public.agent_locks USING btree (expires_at);


--
-- Name: agent_locks_resource_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_locks_resource_uniq ON public.agent_locks USING btree (workspace_id, resource_type, resource_id);


--
-- Name: agent_messages_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_messages_conversation_idx ON public.agent_messages USING btree (conversation_id, created_at);


--
-- Name: agent_rules_ws_agent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_rules_ws_agent_idx ON public.agent_domain_rules USING btree (workspace_id, agent_name, enabled);


--
-- Name: agent_run_results_ws_agent_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_run_results_ws_agent_time_idx ON public.agent_run_results USING btree (workspace_id, agent_name, started_at);


--
-- Name: agent_runs_agent_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_runs_agent_name_idx ON public.agent_execution_runs USING btree (agent_name, started_at);


--
-- Name: agent_runs_correlation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_runs_correlation_idx ON public.agent_execution_runs USING btree (correlation_id);


--
-- Name: agent_runs_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_runs_workspace_idx ON public.agent_execution_runs USING btree (workspace_id, started_at);


--
-- Name: agent_settings_workspace_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX agent_settings_workspace_uniq ON public.agent_settings USING btree (workspace_id);


--
-- Name: agent_supply_reco_ws_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_supply_reco_ws_nm_idx ON public.agent_supply_recommendations USING btree (workspace_id, nm_id);


--
-- Name: agent_supply_reco_ws_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_supply_reco_ws_run_idx ON public.agent_supply_recommendations USING btree (workspace_id, run_id);


--
-- Name: agent_tasks_dedup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_tasks_dedup_idx ON public.agent_tasks USING btree (workspace_id, context_hash, created_at);


--
-- Name: agent_tasks_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_tasks_status_idx ON public.agent_tasks USING btree (status);


--
-- Name: agent_tasks_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_tasks_workspace_idx ON public.agent_tasks USING btree (workspace_id, created_at);


--
-- Name: agent_verification_checks_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_verification_checks_shop_idx ON public.agent_verification_checks USING btree (shop_id);


--
-- Name: ai_usage_events_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_events_provider_idx ON public.ai_usage_events USING btree (provider, created_at);


--
-- Name: ai_usage_events_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_events_workspace_idx ON public.ai_usage_events USING btree (workspace_id, created_at);


--
-- Name: audit_log_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_action_idx ON public.audit_log USING btree (action, created_at DESC);


--
-- Name: audit_log_resource_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_resource_idx ON public.audit_log USING btree (resource_type, resource_id);


--
-- Name: audit_log_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_shop_idx ON public.audit_log USING btree (shop_id, created_at);


--
-- Name: audit_log_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_user_idx ON public.audit_log USING btree (user_id, created_at DESC);


--
-- Name: audit_log_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_workspace_idx ON public.audit_log USING btree (workspace_id, created_at DESC);


--
-- Name: bidder_actions_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bidder_actions_campaign_idx ON public.bidder_actions USING btree (campaign_id, created_at DESC);


--
-- Name: bidder_actions_rule_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bidder_actions_rule_idx ON public.bidder_actions USING btree (rule_id, created_at DESC);


--
-- Name: bidder_actions_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bidder_actions_workspace_idx ON public.bidder_actions USING btree (workspace_id, created_at DESC);


--
-- Name: bidder_alerts_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bidder_alerts_campaign_idx ON public.bidder_alerts USING btree (campaign_id, created_at);


--
-- Name: bidder_alerts_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bidder_alerts_unread_idx ON public.bidder_alerts USING btree (workspace_id, is_read);


--
-- Name: bidder_alerts_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bidder_alerts_workspace_idx ON public.bidder_alerts USING btree (workspace_id, created_at);


--
-- Name: bidder_keyword_auto_rules_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bidder_keyword_auto_rules_workspace_idx ON public.bidder_keyword_auto_rules USING btree (workspace_id, is_active);


--
-- Name: bidder_keywords_campaign_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bidder_keywords_campaign_idx ON public.bidder_keywords USING btree (campaign_id, list_type);


--
-- Name: bidder_keywords_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bidder_keywords_uniq ON public.bidder_keywords USING btree (workspace_id, campaign_id, keyword, list_type);


--
-- Name: bidder_keywords_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bidder_keywords_workspace_idx ON public.bidder_keywords USING btree (workspace_id, list_type);


--
-- Name: bidder_rules_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bidder_rules_workspace_idx ON public.bidder_rules USING btree (workspace_id, is_active);


--
-- Name: cashflow_categories_code_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cashflow_categories_code_uniq ON public.cashflow_categories USING btree (workspace_id, code);


--
-- Name: cashflow_categories_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cashflow_categories_workspace_idx ON public.cashflow_categories USING btree (workspace_id);


--
-- Name: cashflow_entries_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cashflow_entries_source_idx ON public.cashflow_entries USING btree (workspace_id, source, source_id);


--
-- Name: cashflow_entries_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cashflow_entries_workspace_date_idx ON public.cashflow_entries USING btree (workspace_id, date DESC);


--
-- Name: cashflow_planned_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cashflow_planned_category_idx ON public.cashflow_planned_items USING btree (workspace_id, category);


--
-- Name: cashflow_planned_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cashflow_planned_workspace_idx ON public.cashflow_planned_items USING btree (workspace_id, start_date);


--
-- Name: cashflow_wb_payouts_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cashflow_wb_payouts_date_idx ON public.cashflow_wb_payouts USING btree (workspace_id, payout_date DESC);


--
-- Name: cashflow_wb_payouts_report_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cashflow_wb_payouts_report_idx ON public.cashflow_wb_payouts USING btree (workspace_id, report_id);


--
-- Name: creative_audit_experiments_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_audit_experiments_shop_idx ON public.creative_audit_experiments USING btree (shop_id, created_at DESC);


--
-- Name: creative_audit_experiments_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_audit_experiments_status_idx ON public.creative_audit_experiments USING btree (workspace_id, status);


--
-- Name: creative_audit_experiments_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_audit_experiments_workspace_idx ON public.creative_audit_experiments USING btree (workspace_id, created_at DESC);


--
-- Name: creative_audit_jobs_nm_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_audit_jobs_nm_status ON public.creative_audit_jobs USING btree (workspace_id, nm_id, status);


--
-- Name: creative_audit_jobs_ws_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_audit_jobs_ws_created ON public.creative_audit_jobs USING btree (workspace_id, started_at);


--
-- Name: creative_audit_runs_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_audit_runs_nm_idx ON public.creative_audit_runs USING btree (workspace_id, nm_id, created_at);


--
-- Name: creative_audit_runs_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_audit_runs_workspace_idx ON public.creative_audit_runs USING btree (workspace_id, created_at);


--
-- Name: creative_card_audit_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_card_audit_ws_idx ON public.creative_card_audit_runs USING btree (workspace_id, created_at);


--
-- Name: creative_final_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_final_ws_idx ON public.creative_audit_runs_final USING btree (workspace_id, created_at);


--
-- Name: creative_final_ws_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_final_ws_nm_idx ON public.creative_audit_runs_final USING btree (workspace_id, nm_id, created_at);


--
-- Name: creative_generations_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_generations_ws_idx ON public.creative_image_generations USING btree (workspace_id, status, created_at DESC);


--
-- Name: creative_photo_audit_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_photo_audit_ws_idx ON public.creative_photo_audit_runs USING btree (workspace_id, created_at);


--
-- Name: creative_snapshots_ws_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_snapshots_ws_nm_idx ON public.creative_card_snapshots USING btree (workspace_id, nm_id, created_at);


--
-- Name: creative_visual_assets_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_visual_assets_job_idx ON public.creative_visual_assets USING btree (job_id);


--
-- Name: creative_visual_jobs_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_visual_jobs_nm_idx ON public.creative_visual_jobs USING btree (workspace_id, nm_id);


--
-- Name: creative_visual_jobs_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_visual_jobs_workspace_idx ON public.creative_visual_jobs USING btree (workspace_id, created_at);


--
-- Name: creative_visual_slides_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creative_visual_slides_job_idx ON public.creative_visual_slides USING btree (job_id, sort_order);


--
-- Name: doc_chunks_doc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX doc_chunks_doc_idx ON public.document_chunks USING btree (document_id);


--
-- Name: doc_chunks_embedding_hnsw_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX doc_chunks_embedding_hnsw_idx ON public.document_chunks USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: doc_chunks_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX doc_chunks_hash_idx ON public.document_chunks USING btree (workspace_id, content_hash);


--
-- Name: doc_chunks_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX doc_chunks_ws_idx ON public.document_chunks USING btree (workspace_id);


--
-- Name: documents_ws_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_ws_active_idx ON public.documents USING btree (workspace_id, deleted_at);


--
-- Name: documents_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_ws_idx ON public.documents USING btree (workspace_id, status);


--
-- Name: fbs_documents_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fbs_documents_run_idx ON public.fbs_documents USING btree (run_id);


--
-- Name: fbs_runs_schedule_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fbs_runs_schedule_idx ON public.fbs_runs USING btree (schedule_id);


--
-- Name: fbs_runs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fbs_runs_status_idx ON public.fbs_runs USING btree (status);


--
-- Name: fbs_runs_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fbs_runs_workspace_idx ON public.fbs_runs USING btree (workspace_id, created_at);


--
-- Name: fbs_schedules_last_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fbs_schedules_last_run_idx ON public.fbs_schedules USING btree (last_run_at);


--
-- Name: fbs_schedules_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fbs_schedules_shop_idx ON public.fbs_schedules USING btree (shop_id);


--
-- Name: fbs_schedules_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fbs_schedules_workspace_idx ON public.fbs_schedules USING btree (workspace_id);


--
-- Name: feedback_reply_log_fb_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX feedback_reply_log_fb_uniq ON public.feedback_reply_log USING btree (workspace_id, feedback_id);


--
-- Name: feedback_reply_log_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feedback_reply_log_ws_idx ON public.feedback_reply_log USING btree (workspace_id, created_at);


--
-- Name: holiday_calendar_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX holiday_calendar_kind_idx ON public.holiday_calendar USING btree (kind);


--
-- Name: idx_ai_token_balance_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_token_balance_workspace ON public.ai_token_balance USING btree (workspace_id);


--
-- Name: idx_ai_token_tx_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_token_tx_user ON public.ai_token_transactions USING btree (user_id, created_at DESC);


--
-- Name: idx_ai_token_tx_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_token_tx_workspace ON public.ai_token_transactions USING btree (workspace_id, created_at DESC);


--
-- Name: idx_tg_chat_messages_session_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tg_chat_messages_session_time ON public.tg_chat_messages USING btree (session_id, created_at);


--
-- Name: idx_tg_chat_sessions_user_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tg_chat_sessions_user_open ON public.tg_chat_sessions USING btree (user_id, closed_at NULLS FIRST, last_msg_at DESC);


--
-- Name: idx_tg_chat_sessions_user_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tg_chat_sessions_user_recent ON public.tg_chat_sessions USING btree (user_id, last_msg_at DESC);


--
-- Name: insights_fingerprint_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX insights_fingerprint_uniq ON public.insights USING btree (workspace_id, fingerprint);


--
-- Name: insights_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insights_shop_idx ON public.insights USING btree (shop_id);


--
-- Name: insights_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insights_workspace_date_idx ON public.insights USING btree (workspace_id, date, category);


--
-- Name: insights_workspace_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX insights_workspace_nm_idx ON public.insights USING btree (workspace_id, nm_id, date);


--
-- Name: knowledge_entries_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_entries_scope_idx ON public.knowledge_entries USING btree (workspace_id, scope_type, scope_key);


--
-- Name: knowledge_entries_title_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX knowledge_entries_title_idx ON public.knowledge_entries USING btree (workspace_id, title);


--
-- Name: marketplace_feedback_analysis_item_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX marketplace_feedback_analysis_item_uniq ON public.marketplace_feedback_analysis USING btree (workspace_id, marketplace, item_type, item_id);


--
-- Name: marketplace_feedback_analysis_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_feedback_analysis_shop_idx ON public.marketplace_feedback_analysis USING btree (shop_id);


--
-- Name: marketplace_feedback_analysis_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_feedback_analysis_workspace_idx ON public.marketplace_feedback_analysis USING btree (workspace_id, marketplace, item_type);


--
-- Name: marketplace_feedback_items_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_feedback_items_category_idx ON public.marketplace_feedback_items USING btree (workspace_id, category) WHERE (category IS NOT NULL);


--
-- Name: marketplace_feedback_items_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_feedback_items_nm_idx ON public.marketplace_feedback_items USING btree (workspace_id, nm_id);


--
-- Name: marketplace_feedback_items_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_feedback_items_shop_idx ON public.marketplace_feedback_items USING btree (shop_id);


--
-- Name: marketplace_feedback_items_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_feedback_items_status_idx ON public.marketplace_feedback_items USING btree (workspace_id, status);


--
-- Name: marketplace_feedback_items_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_feedback_items_workspace_idx ON public.marketplace_feedback_items USING btree (workspace_id, marketplace, item_type);


--
-- Name: marketplace_reply_drafts_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_reply_drafts_item_idx ON public.marketplace_reply_drafts USING btree (workspace_id, marketplace, item_type, item_id);


--
-- Name: marketplace_reply_drafts_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_reply_drafts_shop_idx ON public.marketplace_reply_drafts USING btree (shop_id);


--
-- Name: marketplace_reply_drafts_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_reply_drafts_status_idx ON public.marketplace_reply_drafts USING btree (workspace_id, status, created_at);


--
-- Name: marketplace_shops_platform_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_shops_platform_idx ON public.marketplace_shops USING btree (platform);


--
-- Name: marketplace_shops_token_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_shops_token_type_idx ON public.marketplace_shops USING btree (token_type) WHERE (token_type = ANY (ARRAY['personal'::text, 'invalid'::text]));


--
-- Name: marketplace_shops_workspace_api_key_hash_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX marketplace_shops_workspace_api_key_hash_uniq ON public.marketplace_shops USING btree (workspace_id, api_key_hash) WHERE (api_key_hash IS NOT NULL);


--
-- Name: marketplace_shops_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_shops_workspace_idx ON public.marketplace_shops USING btree (workspace_id);


--
-- Name: marketplace_shops_workspace_platform_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX marketplace_shops_workspace_platform_idx ON public.marketplace_shops USING btree (workspace_id, platform);


--
-- Name: notification_dedup_sent_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_dedup_sent_at_idx ON public.notification_dedup USING btree (sent_at);


--
-- Name: notification_settings_telegram_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_settings_telegram_idx ON public.notification_settings USING btree (telegram_chat_id) WHERE (telegram_enabled = true);


--
-- Name: notification_settings_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_settings_user_idx ON public.notification_settings USING btree (user_id);


--
-- Name: price_ab_phases_test_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_ab_phases_test_idx ON public.price_ab_phases USING btree (test_id, started_at);


--
-- Name: price_ab_tests_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_ab_tests_nm_idx ON public.price_ab_tests USING btree (nm_id);


--
-- Name: price_ab_tests_ws_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_ab_tests_ws_status_idx ON public.price_ab_tests USING btree (workspace_id, status);


--
-- Name: pricing_decisions_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pricing_decisions_ws_idx ON public.pricing_decisions USING btree (workspace_id, nm_id, created_at);


--
-- Name: pricing_strategies_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pricing_strategies_ws_idx ON public.pricing_strategies USING btree (workspace_id);


--
-- Name: pricing_strategies_ws_nm_type_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pricing_strategies_ws_nm_type_uniq ON public.pricing_strategies USING btree (workspace_id, nm_id, strategy_type);


--
-- Name: pulse_alert_controls_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pulse_alert_controls_workspace_idx ON public.pulse_alert_controls USING btree (workspace_id);


--
-- Name: pulse_metrics_catalog_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pulse_metrics_catalog_group_idx ON public.pulse_metrics_catalog USING btree (group_id, sort_order);


--
-- Name: pulse_plans_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pulse_plans_workspace_date_idx ON public.pulse_plans USING btree (workspace_id, date);


--
-- Name: pulse_plans_workspace_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pulse_plans_workspace_nm_idx ON public.pulse_plans USING btree (workspace_id, nm_id);


--
-- Name: pulse_preset_events_preset_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pulse_preset_events_preset_id_idx ON public.pulse_preset_events USING btree (preset_id, created_at);


--
-- Name: pulse_preset_events_workspace_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pulse_preset_events_workspace_id_idx ON public.pulse_preset_events USING btree (workspace_id, created_at);


--
-- Name: pulse_preset_group_settings_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pulse_preset_group_settings_group_idx ON public.pulse_preset_group_settings USING btree (group_id);


--
-- Name: pulse_preset_metric_settings_metric_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pulse_preset_metric_settings_metric_idx ON public.pulse_preset_metric_settings USING btree (metric_id);


--
-- Name: pulse_presets_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pulse_presets_created_by_idx ON public.pulse_presets USING btree (created_by_user_id);


--
-- Name: pulse_presets_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pulse_presets_shop_idx ON public.pulse_presets USING btree (shop_id);


--
-- Name: pulse_presets_workspace_pinned_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pulse_presets_workspace_pinned_idx ON public.pulse_presets USING btree (workspace_id, is_pinned, sort_order);


--
-- Name: pulse_presets_workspace_shop_name_active_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pulse_presets_workspace_shop_name_active_uniq ON public.pulse_presets USING btree (workspace_id, COALESCE(shop_id, (0)::bigint), name) WHERE (deleted_at IS NULL);


--
-- Name: pulse_presets_workspace_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pulse_presets_workspace_sort_idx ON public.pulse_presets USING btree (workspace_id, sort_order);


--
-- Name: reconciliation_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reconciliation_status_idx ON public.wb_reconciliation_log USING btree (status);


--
-- Name: reconciliation_ws_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reconciliation_ws_date_idx ON public.wb_reconciliation_log USING btree (workspace_id, date);


--
-- Name: region_warehouse_mapping_region_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX region_warehouse_mapping_region_idx ON public.region_warehouse_mapping USING btree (region_name);


--
-- Name: region_warehouse_mapping_warehouse_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX region_warehouse_mapping_warehouse_idx ON public.region_warehouse_mapping USING btree (warehouse_id);


--
-- Name: sales_monthly_targets_per_nm_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sales_monthly_targets_per_nm_lookup_idx ON public.sales_monthly_targets_per_nm USING btree (workspace_id, shop_id, month);


--
-- Name: sales_monthly_targets_workspace_month_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sales_monthly_targets_workspace_month_idx ON public.sales_monthly_targets USING btree (workspace_id, month);


--
-- Name: seo_addresses_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_addresses_workspace_idx ON public.seo_addresses USING btree (workspace_id);


--
-- Name: seo_addresses_workspace_name_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX seo_addresses_workspace_name_uniq ON public.seo_addresses USING btree (workspace_id, name);


--
-- Name: seo_alerts_keyword_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_alerts_keyword_idx ON public.seo_alerts USING btree (keyword_id);


--
-- Name: seo_alerts_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_alerts_unread_idx ON public.seo_alerts USING btree (keyword_id, is_read);


--
-- Name: seo_competitor_keywords_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_competitor_keywords_workspace_idx ON public.seo_competitor_keywords USING btree (workspace_id);


--
-- Name: seo_competitor_positions_competitor_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_competitor_positions_competitor_time_idx ON public.seo_competitor_positions USING btree (competitor_id, checked_at);


--
-- Name: seo_competitor_positions_workspace_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_competitor_positions_workspace_time_idx ON public.seo_competitor_positions USING btree (workspace_id, checked_at);


--
-- Name: seo_competitors_keyword_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_competitors_keyword_idx ON public.seo_competitors USING btree (keyword_id);


--
-- Name: seo_competitors_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_competitors_workspace_idx ON public.seo_competitors USING btree (workspace_id);


--
-- Name: seo_competitors_workspace_nm_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX seo_competitors_workspace_nm_uniq ON public.seo_competitors USING btree (workspace_id, nm_id, keyword_id);


--
-- Name: seo_jobs_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_jobs_nm_idx ON public.seo_jobs USING btree (workspace_id, nm_id);


--
-- Name: seo_jobs_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_jobs_workspace_idx ON public.seo_jobs USING btree (workspace_id, created_at);


--
-- Name: seo_keyword_products_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_keyword_products_nm_idx ON public.seo_keyword_products USING btree (nm_id);


--
-- Name: seo_keyword_tag_links_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_keyword_tag_links_tag_idx ON public.seo_keyword_tag_links USING btree (tag_id);


--
-- Name: seo_keyword_tags_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_keyword_tags_workspace_idx ON public.seo_keyword_tags USING btree (workspace_id);


--
-- Name: seo_keyword_tags_workspace_name_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX seo_keyword_tags_workspace_name_uniq ON public.seo_keyword_tags USING btree (workspace_id, name);


--
-- Name: seo_keywords_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_keywords_active_idx ON public.seo_keywords USING btree (workspace_id, is_active);


--
-- Name: seo_keywords_workspace_keyword_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX seo_keywords_workspace_keyword_idx ON public.seo_keywords USING btree (workspace_id, shop_id, keyword);


--
-- Name: seo_position_snapshots_address_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_position_snapshots_address_idx ON public.seo_position_snapshots USING btree (address_id, checked_at);


--
-- Name: seo_position_snapshots_keyword_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_position_snapshots_keyword_date_idx ON public.seo_position_snapshots USING btree (keyword_id, checked_at);


--
-- Name: seo_position_snapshots_kw_checked_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_position_snapshots_kw_checked_idx ON public.seo_position_snapshots USING btree (keyword_id, checked_at DESC);


--
-- Name: seo_position_snapshots_nm_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX seo_position_snapshots_nm_date_idx ON public.seo_position_snapshots USING btree (nm_id, checked_at);


--
-- Name: signup_waitlist_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signup_waitlist_created_at_idx ON public.signup_waitlist USING btree (created_at DESC);


--
-- Name: signup_waitlist_email_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX signup_waitlist_email_uniq ON public.signup_waitlist USING btree (email);


--
-- Name: studio_assets_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_assets_project_idx ON public.studio_assets USING btree (project_id);


--
-- Name: studio_assets_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_assets_type_idx ON public.studio_assets USING btree (type);


--
-- Name: studio_assets_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_assets_workspace_idx ON public.studio_assets USING btree (workspace_id);


--
-- Name: studio_assets_workspace_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_assets_workspace_user_idx ON public.studio_assets USING btree (workspace_id, user_id, created_at DESC);


--
-- Name: studio_credits_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_credits_created_idx ON public.studio_credits USING btree (created_at);


--
-- Name: studio_credits_operation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_credits_operation_idx ON public.studio_credits USING btree (operation);


--
-- Name: studio_credits_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_credits_workspace_idx ON public.studio_credits USING btree (workspace_id);


--
-- Name: studio_presets_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_presets_category_idx ON public.studio_presets USING btree (category);


--
-- Name: studio_presets_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_presets_workspace_idx ON public.studio_presets USING btree (workspace_id);


--
-- Name: studio_projects_nm_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_projects_nm_id_idx ON public.studio_projects USING btree (nm_id);


--
-- Name: studio_projects_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_projects_type_idx ON public.studio_projects USING btree (type);


--
-- Name: studio_projects_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_projects_workspace_idx ON public.studio_projects USING btree (workspace_id);


--
-- Name: studio_prompt_suggestions_ws_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_prompt_suggestions_ws_created_idx ON public.studio_prompt_suggestions USING btree (workspace_id, created_at);


--
-- Name: studio_prompt_suggestions_ws_nm_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_prompt_suggestions_ws_nm_created_idx ON public.studio_prompt_suggestions USING btree (workspace_id, nm_id, created_at);


--
-- Name: studio_tasks_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_tasks_created_idx ON public.studio_tasks USING btree (created_at);


--
-- Name: studio_tasks_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_tasks_shop_idx ON public.studio_tasks USING btree (shop_id);


--
-- Name: studio_tasks_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_tasks_status_idx ON public.studio_tasks USING btree (status);


--
-- Name: studio_tasks_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_tasks_workspace_idx ON public.studio_tasks USING btree (workspace_id);


--
-- Name: supplies_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplies_status_idx ON public.supplies USING btree (workspace_id, status);


--
-- Name: supplies_wb_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplies_wb_id_idx ON public.supplies USING btree (wb_supply_id);


--
-- Name: supplies_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supplies_workspace_idx ON public.supplies USING btree (workspace_id);


--
-- Name: supply_booking_queue_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supply_booking_queue_status_idx ON public.supply_booking_queue USING btree (status, next_attempt_at);


--
-- Name: supply_booking_queue_status_next_attempt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supply_booking_queue_status_next_attempt_idx ON public.supply_booking_queue USING btree (status, next_attempt_at) WHERE (status = 'waiting'::text);


--
-- Name: supply_boxes_supply_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supply_boxes_supply_idx ON public.supply_boxes USING btree (supply_id);


--
-- Name: supply_documents_supply_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supply_documents_supply_idx ON public.supply_documents USING btree (supply_id);


--
-- Name: supply_draft_items_draft_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supply_draft_items_draft_idx ON public.supply_draft_items USING btree (draft_id);


--
-- Name: supply_drafts_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supply_drafts_status_idx ON public.supply_drafts USING btree (workspace_id, status);


--
-- Name: supply_drafts_wb_preorder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supply_drafts_wb_preorder_idx ON public.supply_drafts USING btree (wb_preorder_id) WHERE (wb_preorder_id IS NOT NULL);


--
-- Name: supply_drafts_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supply_drafts_workspace_idx ON public.supply_drafts USING btree (workspace_id);


--
-- Name: supply_passes_supply_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supply_passes_supply_idx ON public.supply_passes USING btree (supply_id);


--
-- Name: supply_passes_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supply_passes_workspace_idx ON public.supply_passes USING btree (workspace_id);


--
-- Name: supply_roi_history_ws_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supply_roi_history_ws_nm_idx ON public.supply_roi_history USING btree (workspace_id, nm_id, created_at DESC);


--
-- Name: supply_slots_cache_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX supply_slots_cache_lookup_idx ON public.supply_slots_cache USING btree (workspace_id, warehouse_id, date);


--
-- Name: system_events_correlation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX system_events_correlation_idx ON public.system_events USING btree (correlation_id);


--
-- Name: system_events_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX system_events_entity_idx ON public.system_events USING btree (entity_type, entity_id);


--
-- Name: system_events_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX system_events_ts_idx ON public.system_events USING btree (ts);


--
-- Name: system_events_ws_shop_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX system_events_ws_shop_ts_idx ON public.system_events USING btree (workspace_id, shop_id, ts);


--
-- Name: system_events_ws_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX system_events_ws_type_idx ON public.system_events USING btree (workspace_id, event_type, ts);


--
-- Name: user_refresh_tokens_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_refresh_tokens_expires_idx ON public.user_refresh_tokens USING btree (expires_at);


--
-- Name: user_refresh_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_refresh_tokens_user_idx ON public.user_refresh_tokens USING btree (user_id);


--
-- Name: user_sessions_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_sessions_expires_idx ON public.user_sessions USING btree (expires_at);


--
-- Name: user_sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_sessions_user_idx ON public.user_sessions USING btree (user_id);


--
-- Name: user_telegram_link_codes_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_telegram_link_codes_expires_idx ON public.user_telegram_link_codes USING btree (expires_at);


--
-- Name: user_telegram_link_codes_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_telegram_link_codes_user_idx ON public.user_telegram_link_codes USING btree (user_id);


--
-- Name: user_telegram_links_chat_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_telegram_links_chat_uniq ON public.user_telegram_links USING btree (tg_chat_id);


--
-- Name: users_email_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_uniq ON public.users USING btree (email);


--
-- Name: users_is_admin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_is_admin_idx ON public.users USING btree (is_admin) WHERE (is_admin = true);


--
-- Name: verif_checks_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verif_checks_action_idx ON public.agent_verification_checks USING btree (action_id);


--
-- Name: verif_checks_scheduled_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verif_checks_scheduled_idx ON public.agent_verification_checks USING btree (scheduled_at);


--
-- Name: wb_adv_daily_products_shop_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_adv_daily_products_shop_date_idx ON public.wb_adv_daily_products USING btree (workspace_id, shop_id, date);


--
-- Name: wb_adv_daily_products_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_adv_daily_products_shop_idx ON public.wb_adv_daily_products USING btree (shop_id);


--
-- Name: wb_adv_daily_products_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_adv_daily_products_workspace_date_idx ON public.wb_adv_daily_products USING btree (workspace_id, date);


--
-- Name: wb_adv_daily_products_workspace_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_adv_daily_products_workspace_nm_idx ON public.wb_adv_daily_products USING btree (workspace_id, nm_id);


--
-- Name: wb_adv_daily_products_ws_shop_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_adv_daily_products_ws_shop_date_idx ON public.wb_adv_daily_products USING btree (workspace_id, shop_id, date);


--
-- Name: wb_adv_daily_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_adv_daily_shop_idx ON public.wb_adv_daily USING btree (shop_id);


--
-- Name: wb_adv_daily_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_adv_daily_workspace_date_idx ON public.wb_adv_daily USING btree (workspace_id, date);


--
-- Name: wb_adv_daily_ws_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_adv_daily_ws_date_idx ON public.wb_adv_daily USING btree (workspace_id, date);


--
-- Name: wb_adv_finance_daily_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_adv_finance_daily_workspace_date_idx ON public.wb_adv_finance_daily USING btree (workspace_id, date);


--
-- Name: wb_adv_finance_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wb_adv_finance_event_idx ON public.wb_adv_finance USING btree (workspace_id, upd_num, advert_id, upd_time, upd_sum_kopecks);


--
-- Name: wb_adv_finance_workspace_advert_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_adv_finance_workspace_advert_date_idx ON public.wb_adv_finance USING btree (workspace_id, advert_id, upd_date);


--
-- Name: wb_adv_finance_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_adv_finance_workspace_date_idx ON public.wb_adv_finance USING btree (workspace_id, upd_date);


--
-- Name: wb_adv_finance_workspace_payment_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_adv_finance_workspace_payment_type_idx ON public.wb_adv_finance USING btree (workspace_id, payment_type);


--
-- Name: wb_alert_settings_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_alert_settings_workspace_idx ON public.wb_alert_settings USING btree (workspace_id);


--
-- Name: wb_backfill_progress_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_backfill_progress_pending_idx ON public.wb_backfill_progress USING btree (last_advanced_at NULLS FIRST) WHERE ((oldest_covered IS NULL) OR (oldest_covered > target_oldest));


--
-- Name: wb_campaigns_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_campaigns_shop_idx ON public.wb_campaigns USING btree (shop_id);


--
-- Name: wb_campaigns_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_campaigns_status_idx ON public.wb_campaigns USING btree (workspace_id, status);


--
-- Name: wb_campaigns_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_campaigns_workspace_idx ON public.wb_campaigns USING btree (workspace_id);


--
-- Name: wb_card_snapshots_captured_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_card_snapshots_captured_idx ON public.wb_card_snapshots USING btree (captured_at DESC);


--
-- Name: wb_card_snapshots_changes_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_card_snapshots_changes_idx ON public.wb_card_snapshots USING gin (changes_from_prev);


--
-- Name: wb_card_snapshots_nm_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_card_snapshots_nm_date_idx ON public.wb_card_snapshots USING btree (workspace_id, shop_id, nm_id, snapshot_date DESC);


--
-- Name: wb_card_snapshots_unique_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wb_card_snapshots_unique_day_idx ON public.wb_card_snapshots USING btree (workspace_id, shop_id, nm_id, snapshot_date);


--
-- Name: wb_cards_chars_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_cards_chars_gin_idx ON public.wb_cards USING gin (((raw -> 'characteristics'::text)) jsonb_path_ops);


--
-- Name: wb_cards_embedding_hnsw_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_cards_embedding_hnsw_idx ON public.wb_cards USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: wb_cards_needs_embed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_cards_needs_embed_idx ON public.wb_cards USING btree (workspace_id, updated_at) WHERE ((embedding IS NULL) OR (embedded_at < updated_at));


--
-- Name: wb_cards_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_cards_shop_idx ON public.wb_cards USING btree (shop_id);


--
-- Name: wb_cards_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_cards_workspace_idx ON public.wb_cards USING btree (workspace_id);


--
-- Name: wb_chats_chat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wb_chats_chat_idx ON public.wb_chats USING btree (workspace_id, chat_id);


--
-- Name: wb_chats_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_chats_shop_idx ON public.wb_chats USING btree (shop_id);


--
-- Name: wb_chats_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_chats_status_idx ON public.wb_chats USING btree (workspace_id, status);


--
-- Name: wb_chats_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_chats_ws_idx ON public.wb_chats USING btree (workspace_id);


--
-- Name: wb_cogs_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_cogs_shop_idx ON public.wb_cogs USING btree (shop_id);


--
-- Name: wb_cogs_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_cogs_workspace_idx ON public.wb_cogs USING btree (workspace_id);


--
-- Name: wb_compensations_rrd_id_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wb_compensations_rrd_id_uniq ON public.wb_compensations USING btree (workspace_id, rrd_id);


--
-- Name: wb_compensations_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_compensations_workspace_date_idx ON public.wb_compensations USING btree (workspace_id, date);


--
-- Name: wb_compensations_workspace_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_compensations_workspace_nm_idx ON public.wb_compensations USING btree (workspace_id, nm_id);


--
-- Name: wb_deductions_daily_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_deductions_daily_shop_idx ON public.wb_deductions_daily USING btree (shop_id);


--
-- Name: wb_deductions_daily_ws_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_deductions_daily_ws_date_idx ON public.wb_deductions_daily USING btree (workspace_id, date);


--
-- Name: wb_deductions_daily_ws_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_deductions_daily_ws_type_idx ON public.wb_deductions_daily USING btree (workspace_id, type);


--
-- Name: wb_event_comments_event_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_event_comments_event_idx ON public.wb_event_comments USING btree (event_id, created_at);


--
-- Name: wb_events_assignee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_events_assignee_idx ON public.wb_events USING btree (assignee_id, status);


--
-- Name: wb_events_fingerprint_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wb_events_fingerprint_uniq ON public.wb_events USING btree (workspace_id, fingerprint) WHERE (fingerprint IS NOT NULL);


--
-- Name: wb_events_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_events_parent_idx ON public.wb_events USING btree (parent_event_id);


--
-- Name: wb_events_reminder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_events_reminder_idx ON public.wb_events USING btree (reminder_at, reminder_sent) WHERE ((reminder_at IS NOT NULL) AND (reminder_sent = false));


--
-- Name: wb_events_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_events_shop_idx ON public.wb_events USING btree (shop_id);


--
-- Name: wb_events_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_events_workspace_date_idx ON public.wb_events USING btree (workspace_id, date);


--
-- Name: wb_events_workspace_nm_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_events_workspace_nm_date_idx ON public.wb_events USING btree (workspace_id, nm_id, date);


--
-- Name: wb_fbs_shipments_daily_products_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_fbs_shipments_daily_products_shop_idx ON public.wb_fbs_shipments_daily_products USING btree (shop_id);


--
-- Name: wb_fbs_shipments_daily_products_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_fbs_shipments_daily_products_workspace_date_idx ON public.wb_fbs_shipments_daily_products USING btree (workspace_id, date);


--
-- Name: wb_fbs_shipments_daily_products_workspace_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_fbs_shipments_daily_products_workspace_nm_idx ON public.wb_fbs_shipments_daily_products USING btree (workspace_id, nm_id);


--
-- Name: wb_fbs_supplies_workspace_done_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_fbs_supplies_workspace_done_idx ON public.wb_fbs_supplies USING btree (workspace_id, done);


--
-- Name: wb_fbs_supplies_ws_supply_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wb_fbs_supplies_ws_supply_uniq ON public.wb_fbs_supplies USING btree (workspace_id, wb_supply_id);


--
-- Name: wb_fbs_supply_orders_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_fbs_supply_orders_order_idx ON public.wb_fbs_supply_orders USING btree (wb_order_id);


--
-- Name: wb_fbs_supply_orders_pair_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wb_fbs_supply_orders_pair_uniq ON public.wb_fbs_supply_orders USING btree (fbs_supply_pk, wb_order_id);


--
-- Name: wb_finance_daily_products_report_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_finance_daily_products_report_idx ON public.wb_finance_daily_products USING btree (workspace_id, report_id);


--
-- Name: wb_finance_daily_products_rr_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_finance_daily_products_rr_date_idx ON public.wb_finance_daily_products USING btree (workspace_id, shop_id, rr_date);


--
-- Name: wb_finance_daily_products_shop_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_finance_daily_products_shop_date_idx ON public.wb_finance_daily_products USING btree (workspace_id, shop_id, date);


--
-- Name: wb_finance_daily_products_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_finance_daily_products_shop_idx ON public.wb_finance_daily_products USING btree (shop_id);


--
-- Name: wb_finance_daily_products_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_finance_daily_products_workspace_date_idx ON public.wb_finance_daily_products USING btree (workspace_id, date);


--
-- Name: wb_finance_daily_products_workspace_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_finance_daily_products_workspace_nm_idx ON public.wb_finance_daily_products USING btree (workspace_id, nm_id);


--
-- Name: wb_finance_daily_products_ws_shop_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_finance_daily_products_ws_shop_date_idx ON public.wb_finance_daily_products USING btree (workspace_id, shop_id, date);


--
-- Name: wb_finance_daily_rr_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_finance_daily_rr_date_idx ON public.wb_finance_daily USING btree (workspace_id, shop_id, rr_date);


--
-- Name: wb_finance_daily_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_finance_daily_shop_idx ON public.wb_finance_daily USING btree (shop_id);


--
-- Name: wb_finance_daily_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_finance_daily_workspace_date_idx ON public.wb_finance_daily USING btree (workspace_id, date);


--
-- Name: wb_finance_reports_ws_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_finance_reports_ws_date_idx ON public.wb_finance_reports USING btree (workspace_id, date_from);


--
-- Name: wb_finance_reports_ws_shop_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_finance_reports_ws_shop_date_idx ON public.wb_finance_reports USING btree (workspace_id, shop_id, date_from);


--
-- Name: wb_finance_weekly_products_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_finance_weekly_products_shop_idx ON public.wb_finance_weekly_products USING btree (shop_id);


--
-- Name: wb_finance_weekly_products_workspace_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_finance_weekly_products_workspace_nm_idx ON public.wb_finance_weekly_products USING btree (workspace_id, nm_id);


--
-- Name: wb_finance_weekly_products_workspace_report_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_finance_weekly_products_workspace_report_idx ON public.wb_finance_weekly_products USING btree (workspace_id, date_from, date_to);


--
-- Name: wb_funnel_daily_products_shop_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_funnel_daily_products_shop_date_idx ON public.wb_funnel_daily_products USING btree (workspace_id, shop_id, date);


--
-- Name: wb_funnel_daily_products_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_funnel_daily_products_shop_idx ON public.wb_funnel_daily_products USING btree (shop_id);


--
-- Name: wb_funnel_daily_products_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_funnel_daily_products_workspace_date_idx ON public.wb_funnel_daily_products USING btree (workspace_id, date);


--
-- Name: wb_funnel_daily_products_workspace_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_funnel_daily_products_workspace_nm_idx ON public.wb_funnel_daily_products USING btree (workspace_id, nm_id);


--
-- Name: wb_funnel_daily_products_ws_shop_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_funnel_daily_products_ws_shop_date_idx ON public.wb_funnel_daily_products USING btree (workspace_id, shop_id, date);


--
-- Name: wb_funnel_daily_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_funnel_daily_shop_idx ON public.wb_funnel_daily USING btree (shop_id);


--
-- Name: wb_funnel_daily_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_funnel_daily_workspace_date_idx ON public.wb_funnel_daily USING btree (workspace_id, date);


--
-- Name: wb_hidden_products_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_hidden_products_shop_idx ON public.wb_hidden_products USING btree (shop_id);


--
-- Name: wb_hidden_products_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_hidden_products_ws_idx ON public.wb_hidden_products USING btree (workspace_id);


--
-- Name: wb_hidden_products_ws_nm_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wb_hidden_products_ws_nm_uniq ON public.wb_hidden_products USING btree (workspace_id, nm_id);


--
-- Name: wb_orders_sales_daily_product_regions_nmid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_product_regions_nmid_idx ON public.wb_orders_sales_daily_product_regions USING btree (workspace_id, nm_id);


--
-- Name: wb_orders_sales_daily_product_regions_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_product_regions_shop_idx ON public.wb_orders_sales_daily_product_regions USING btree (shop_id);


--
-- Name: wb_orders_sales_daily_product_regions_ws_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_product_regions_ws_date_idx ON public.wb_orders_sales_daily_product_regions USING btree (workspace_id, date);


--
-- Name: wb_orders_sales_daily_product_warehouses_nmid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_product_warehouses_nmid_idx ON public.wb_orders_sales_daily_product_warehouses USING btree (workspace_id, nm_id);


--
-- Name: wb_orders_sales_daily_product_warehouses_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_product_warehouses_shop_idx ON public.wb_orders_sales_daily_product_warehouses USING btree (shop_id);


--
-- Name: wb_orders_sales_daily_product_warehouses_ws_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_product_warehouses_ws_date_idx ON public.wb_orders_sales_daily_product_warehouses USING btree (workspace_id, date);


--
-- Name: wb_orders_sales_daily_products_shop_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_products_shop_date_idx ON public.wb_orders_sales_daily_products USING btree (workspace_id, shop_id, date);


--
-- Name: wb_orders_sales_daily_products_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_products_shop_idx ON public.wb_orders_sales_daily_products USING btree (shop_id);


--
-- Name: wb_orders_sales_daily_products_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_products_workspace_date_idx ON public.wb_orders_sales_daily_products USING btree (workspace_id, date);


--
-- Name: wb_orders_sales_daily_products_workspace_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_products_workspace_nm_idx ON public.wb_orders_sales_daily_products USING btree (workspace_id, nm_id);


--
-- Name: wb_orders_sales_daily_products_ws_shop_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_products_ws_shop_date_idx ON public.wb_orders_sales_daily_products USING btree (workspace_id, shop_id, date);


--
-- Name: wb_orders_sales_daily_regions_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_regions_shop_idx ON public.wb_orders_sales_daily_regions USING btree (shop_id);


--
-- Name: wb_orders_sales_daily_regions_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_regions_workspace_date_idx ON public.wb_orders_sales_daily_regions USING btree (workspace_id, date);


--
-- Name: wb_orders_sales_daily_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_shop_idx ON public.wb_orders_sales_daily USING btree (shop_id);


--
-- Name: wb_orders_sales_daily_warehouses_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_warehouses_shop_idx ON public.wb_orders_sales_daily_warehouses USING btree (shop_id);


--
-- Name: wb_orders_sales_daily_warehouses_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_warehouses_workspace_date_idx ON public.wb_orders_sales_daily_warehouses USING btree (workspace_id, date);


--
-- Name: wb_orders_sales_daily_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_orders_sales_daily_workspace_date_idx ON public.wb_orders_sales_daily USING btree (workspace_id, date);


--
-- Name: wb_prices_history_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_prices_history_shop_idx ON public.wb_prices_history USING btree (shop_id);


--
-- Name: wb_prices_history_ws_nm_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_prices_history_ws_nm_date_idx ON public.wb_prices_history USING btree (workspace_id, nm_id, date);


--
-- Name: wb_prices_history_ws_nm_date_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wb_prices_history_ws_nm_date_uniq ON public.wb_prices_history USING btree (workspace_id, nm_id, date);


--
-- Name: wb_region_sales_region_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_region_sales_region_idx ON public.wb_region_sales USING btree (region_id);


--
-- Name: wb_region_sales_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_region_sales_shop_idx ON public.wb_region_sales USING btree (shop_id);


--
-- Name: wb_region_sales_ws_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_region_sales_ws_date_idx ON public.wb_region_sales USING btree (workspace_id, date);


--
-- Name: wb_region_sales_ws_nm_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_region_sales_ws_nm_date_idx ON public.wb_region_sales USING btree (workspace_id, nm_id, date);


--
-- Name: wb_returns_return_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wb_returns_return_idx ON public.wb_returns USING btree (workspace_id, return_id);


--
-- Name: wb_returns_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_returns_shop_idx ON public.wb_returns USING btree (shop_id);


--
-- Name: wb_returns_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_returns_status_idx ON public.wb_returns USING btree (workspace_id, status);


--
-- Name: wb_returns_ws_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_returns_ws_idx ON public.wb_returns USING btree (workspace_id);


--
-- Name: wb_search_queries_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_search_queries_shop_idx ON public.wb_search_queries USING btree (shop_id);


--
-- Name: wb_search_queries_ws_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_search_queries_ws_date_idx ON public.wb_search_queries USING btree (workspace_id, date);


--
-- Name: wb_search_queries_ws_nm_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_search_queries_ws_nm_date_idx ON public.wb_search_queries USING btree (workspace_id, nm_id, date);


--
-- Name: wb_self_purchases_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_self_purchases_shop_idx ON public.wb_self_purchases USING btree (shop_id);


--
-- Name: wb_self_purchases_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_self_purchases_workspace_date_idx ON public.wb_self_purchases USING btree (workspace_id, date);


--
-- Name: wb_self_purchases_workspace_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_self_purchases_workspace_nm_idx ON public.wb_self_purchases USING btree (workspace_id, nm_id);


--
-- Name: wb_shops_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_shops_workspace_idx ON public.wb_shops USING btree (workspace_id);


--
-- Name: wb_spp_weekly_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_spp_weekly_shop_idx ON public.wb_spp_weekly USING btree (shop_id);


--
-- Name: wb_spp_weekly_workspace_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_spp_weekly_workspace_nm_idx ON public.wb_spp_weekly USING btree (workspace_id, nm_id);


--
-- Name: wb_spp_weekly_workspace_report_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_spp_weekly_workspace_report_idx ON public.wb_spp_weekly USING btree (workspace_id, date_from, date_to);


--
-- Name: wb_stocks_current_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_stocks_current_shop_idx ON public.wb_stocks_current USING btree (shop_id);


--
-- Name: wb_stocks_current_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_stocks_current_workspace_idx ON public.wb_stocks_current USING btree (workspace_id);


--
-- Name: wb_stocks_daily_products_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_stocks_daily_products_shop_idx ON public.wb_stocks_daily_products USING btree (shop_id);


--
-- Name: wb_stocks_daily_products_workspace_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_stocks_daily_products_workspace_date_idx ON public.wb_stocks_daily_products USING btree (workspace_id, date);


--
-- Name: wb_stocks_daily_products_workspace_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_stocks_daily_products_workspace_nm_idx ON public.wb_stocks_daily_products USING btree (workspace_id, nm_id);


--
-- Name: wb_stocks_daily_products_ws_shop_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_stocks_daily_products_ws_shop_date_idx ON public.wb_stocks_daily_products USING btree (workspace_id, shop_id, date);


--
-- Name: wb_stocks_daily_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_stocks_daily_shop_idx ON public.wb_stocks_daily USING btree (shop_id);


--
-- Name: wb_stocks_daily_ws_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_stocks_daily_ws_date_idx ON public.wb_stocks_daily USING btree (workspace_id, date);


--
-- Name: wb_stocks_daily_ws_nm_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_stocks_daily_ws_nm_date_idx ON public.wb_stocks_daily USING btree (workspace_id, nm_id, date);


--
-- Name: wb_stocks_fbs_current_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_stocks_fbs_current_workspace_idx ON public.wb_stocks_fbs_current USING btree (workspace_id);


--
-- Name: wb_stocks_fbs_current_workspace_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_stocks_fbs_current_workspace_nm_idx ON public.wb_stocks_fbs_current USING btree (workspace_id, nm_id);


--
-- Name: wb_storage_daily_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_storage_daily_shop_idx ON public.wb_storage_daily USING btree (shop_id);


--
-- Name: wb_storage_daily_ws_nm_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_storage_daily_ws_nm_date_idx ON public.wb_storage_daily USING btree (workspace_id, nm_id, date);


--
-- Name: wb_supplies_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_supplies_shop_idx ON public.wb_supplies USING btree (shop_id);


--
-- Name: wb_supplies_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_supplies_status_idx ON public.wb_supplies USING btree (status_id);


--
-- Name: wb_supplies_supply_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_supplies_supply_date_idx ON public.wb_supplies USING btree (supply_date);


--
-- Name: wb_supplies_wb_preorder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_supplies_wb_preorder_idx ON public.wb_supplies USING btree (wb_preorder_id);


--
-- Name: wb_supplies_wb_supply_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_supplies_wb_supply_idx ON public.wb_supplies USING btree (wb_supply_id);


--
-- Name: wb_supplies_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_supplies_workspace_idx ON public.wb_supplies USING btree (workspace_id);


--
-- Name: wb_supply_box_items_box_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_supply_box_items_box_idx ON public.wb_supply_box_items USING btree (box_id);


--
-- Name: wb_supply_boxes_package_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_supply_boxes_package_code_idx ON public.wb_supply_boxes USING btree (package_code);


--
-- Name: wb_supply_boxes_supply_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_supply_boxes_supply_idx ON public.wb_supply_boxes USING btree (supply_id);


--
-- Name: wb_supply_items_barcode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_supply_items_barcode_idx ON public.wb_supply_items USING btree (barcode);


--
-- Name: wb_supply_items_nm_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_supply_items_nm_id_idx ON public.wb_supply_items USING btree (nm_id);


--
-- Name: wb_supply_items_supply_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_supply_items_supply_idx ON public.wb_supply_items USING btree (supply_id);


--
-- Name: wb_sync_runs_running_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_sync_runs_running_idx ON public.wb_sync_runs USING btree (workspace_id, stage, started_at DESC) WHERE (status <> ALL (ARRAY['done'::text, 'failed'::text, 'failed:timeout'::text, 'failed:exit-1'::text]));


--
-- Name: wb_sync_runs_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_sync_runs_shop_idx ON public.wb_sync_runs USING btree (shop_id);


--
-- Name: wb_sync_runs_shop_stage_finished_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_sync_runs_shop_stage_finished_idx ON public.wb_sync_runs USING btree (shop_id, stage, finished_at DESC);


--
-- Name: wb_sync_runs_workspace_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_sync_runs_workspace_time_idx ON public.wb_sync_runs USING btree (workspace_id, created_at);


--
-- Name: wb_tag_products_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_tag_products_shop_idx ON public.wb_tag_products USING btree (shop_id);


--
-- Name: wb_tag_products_workspace_nm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_tag_products_workspace_nm_idx ON public.wb_tag_products USING btree (workspace_id, nm_id);


--
-- Name: wb_tag_products_workspace_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_tag_products_workspace_tag_idx ON public.wb_tag_products USING btree (workspace_id, tag_id);


--
-- Name: wb_tags_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_tags_shop_idx ON public.wb_tags USING btree (shop_id);


--
-- Name: wb_tags_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_tags_workspace_idx ON public.wb_tags USING btree (workspace_id);


--
-- Name: wb_tags_workspace_shop_name_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wb_tags_workspace_shop_name_uniq ON public.wb_tags USING btree (workspace_id, COALESCE(shop_id, (0)::bigint), name);


--
-- Name: wb_transit_tariffs_route_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX wb_transit_tariffs_route_uniq ON public.wb_transit_tariffs USING btree (transit_warehouse_name, destination_warehouse_name);


--
-- Name: wb_warehouses_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_warehouses_active_idx ON public.wb_warehouses USING btree (is_active);


--
-- Name: wb_warehouses_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wb_warehouses_name_idx ON public.wb_warehouses USING btree (name);


--
-- Name: workspace_invites_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_invites_token_idx ON public.workspace_invites USING btree (token);


--
-- Name: workspace_invites_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_invites_workspace_idx ON public.workspace_invites USING btree (workspace_id);


--
-- Name: workspace_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_members_user_idx ON public.workspace_members USING btree (user_id);


--
-- Name: workspace_members_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_members_workspace_idx ON public.workspace_members USING btree (workspace_id);


--
-- Name: workspace_payments_provider_payment_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_payments_provider_payment_uniq ON public.workspace_payments USING btree (provider, provider_payment_id) WHERE (provider_payment_id IS NOT NULL);


--
-- Name: workspace_payments_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_payments_workspace_idx ON public.workspace_payments USING btree (workspace_id, created_at);


--
-- Name: workspace_subscriptions_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_subscriptions_status_idx ON public.workspace_subscriptions USING btree (status);


--
-- Name: workspace_subscriptions_workspace_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_subscriptions_workspace_uniq ON public.workspace_subscriptions USING btree (workspace_id);


--
-- Name: ab_photo_metrics ab_photo_metrics_phase_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_photo_metrics
    ADD CONSTRAINT ab_photo_metrics_phase_id_fkey FOREIGN KEY (phase_id) REFERENCES public.ab_photo_phases(phase_id) ON DELETE SET NULL;


--
-- Name: ab_photo_metrics ab_photo_metrics_test_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_photo_metrics
    ADD CONSTRAINT ab_photo_metrics_test_id_fkey FOREIGN KEY (test_id) REFERENCES public.ab_photo_tests(test_id) ON DELETE CASCADE;


--
-- Name: ab_photo_phases ab_photo_phases_test_id_ab_photo_tests_test_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_photo_phases
    ADD CONSTRAINT ab_photo_phases_test_id_ab_photo_tests_test_id_fk FOREIGN KEY (test_id) REFERENCES public.ab_photo_tests(test_id) ON DELETE CASCADE;


--
-- Name: ab_photo_phases ab_photo_phases_test_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_photo_phases
    ADD CONSTRAINT ab_photo_phases_test_id_fkey FOREIGN KEY (test_id) REFERENCES public.ab_photo_tests(test_id) ON DELETE CASCADE;


--
-- Name: ab_photo_tests ab_photo_tests_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_photo_tests
    ADD CONSTRAINT ab_photo_tests_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: ab_photo_tests ab_photo_tests_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_photo_tests
    ADD CONSTRAINT ab_photo_tests_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: ab_photo_tests ab_photo_tests_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_photo_tests
    ADD CONSTRAINT ab_photo_tests_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: ab_photo_uploads ab_photo_uploads_test_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_photo_uploads
    ADD CONSTRAINT ab_photo_uploads_test_id_fkey FOREIGN KEY (test_id) REFERENCES public.ab_photo_tests(test_id) ON DELETE CASCADE;


--
-- Name: ab_photo_uploads ab_photo_uploads_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ab_photo_uploads
    ADD CONSTRAINT ab_photo_uploads_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: agent_actions agent_actions_conversation_id_agent_conversations_conversation_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_actions
    ADD CONSTRAINT agent_actions_conversation_id_agent_conversations_conversation_ FOREIGN KEY (conversation_id) REFERENCES public.agent_conversations(conversation_id) ON DELETE SET NULL;


--
-- Name: agent_actions agent_actions_decided_by_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_actions
    ADD CONSTRAINT agent_actions_decided_by_users_user_id_fk FOREIGN KEY (decided_by) REFERENCES public.users(user_id) ON DELETE SET NULL;


--
-- Name: agent_actions agent_actions_event_id_wb_events_event_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_actions
    ADD CONSTRAINT agent_actions_event_id_wb_events_event_id_fk FOREIGN KEY (event_id) REFERENCES public.wb_events(event_id) ON DELETE SET NULL;


--
-- Name: agent_actions agent_actions_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_actions
    ADD CONSTRAINT agent_actions_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: agent_actions agent_actions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_actions
    ADD CONSTRAINT agent_actions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE SET NULL;


--
-- Name: agent_actions agent_actions_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_actions
    ADD CONSTRAINT agent_actions_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: agent_conversations agent_conversations_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_conversations
    ADD CONSTRAINT agent_conversations_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: agent_conversations agent_conversations_user_id_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_conversations
    ADD CONSTRAINT agent_conversations_user_id_users_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE SET NULL;


--
-- Name: agent_conversations agent_conversations_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_conversations
    ADD CONSTRAINT agent_conversations_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: agent_domain_rules agent_domain_rules_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_domain_rules
    ADD CONSTRAINT agent_domain_rules_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE CASCADE;


--
-- Name: agent_domain_rules agent_domain_rules_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_domain_rules
    ADD CONSTRAINT agent_domain_rules_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE CASCADE;


--
-- Name: agent_domain_rules agent_domain_rules_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_domain_rules
    ADD CONSTRAINT agent_domain_rules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: agent_events agent_events_applied_by_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_events
    ADD CONSTRAINT agent_events_applied_by_users_user_id_fk FOREIGN KEY (applied_by) REFERENCES public.users(user_id);


--
-- Name: agent_events agent_events_conversation_id_agent_conversations_conversation_i; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_events
    ADD CONSTRAINT agent_events_conversation_id_agent_conversations_conversation_i FOREIGN KEY (conversation_id) REFERENCES public.agent_conversations(conversation_id);


--
-- Name: agent_events agent_events_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_events
    ADD CONSTRAINT agent_events_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: agent_events agent_events_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_events
    ADD CONSTRAINT agent_events_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: agent_execution_runs agent_execution_runs_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_execution_runs
    ADD CONSTRAINT agent_execution_runs_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: agent_execution_runs agent_execution_runs_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_execution_runs
    ADD CONSTRAINT agent_execution_runs_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: agent_execution_runs agent_execution_runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_execution_runs
    ADD CONSTRAINT agent_execution_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: agent_locks agent_locks_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_locks
    ADD CONSTRAINT agent_locks_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: agent_locks agent_locks_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_locks
    ADD CONSTRAINT agent_locks_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: agent_messages agent_messages_conversation_id_agent_conversations_conversation; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_messages
    ADD CONSTRAINT agent_messages_conversation_id_agent_conversations_conversation FOREIGN KEY (conversation_id) REFERENCES public.agent_conversations(conversation_id) ON DELETE CASCADE;


--
-- Name: agent_settings agent_settings_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_settings
    ADD CONSTRAINT agent_settings_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: agent_settings agent_settings_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_settings
    ADD CONSTRAINT agent_settings_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: agent_supply_recommendations agent_supply_recommendations_run_id_agent_run_results_run_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_supply_recommendations
    ADD CONSTRAINT agent_supply_recommendations_run_id_agent_run_results_run_id_fk FOREIGN KEY (run_id) REFERENCES public.agent_run_results(run_id) ON DELETE CASCADE;


--
-- Name: agent_tasks agent_tasks_conversation_id_agent_conversations_conversation_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tasks
    ADD CONSTRAINT agent_tasks_conversation_id_agent_conversations_conversation_id FOREIGN KEY (conversation_id) REFERENCES public.agent_conversations(conversation_id) ON DELETE CASCADE;


--
-- Name: agent_tasks agent_tasks_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tasks
    ADD CONSTRAINT agent_tasks_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: agent_tasks agent_tasks_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_tasks
    ADD CONSTRAINT agent_tasks_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: agent_verification_checks agent_verification_checks_action_id_agent_actions_action_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_verification_checks
    ADD CONSTRAINT agent_verification_checks_action_id_agent_actions_action_id_fk FOREIGN KEY (action_id) REFERENCES public.agent_actions(action_id) ON DELETE CASCADE;


--
-- Name: agent_verification_checks agent_verification_checks_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_verification_checks
    ADD CONSTRAINT agent_verification_checks_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: agent_verification_checks agent_verification_checks_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_verification_checks
    ADD CONSTRAINT agent_verification_checks_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: ai_token_balance ai_token_balance_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_balance
    ADD CONSTRAINT ai_token_balance_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: ai_token_balance ai_token_balance_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_balance
    ADD CONSTRAINT ai_token_balance_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: ai_token_transactions ai_token_transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_transactions
    ADD CONSTRAINT ai_token_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id);


--
-- Name: ai_token_transactions ai_token_transactions_user_id_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_transactions
    ADD CONSTRAINT ai_token_transactions_user_id_users_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(user_id);


--
-- Name: ai_token_transactions ai_token_transactions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_transactions
    ADD CONSTRAINT ai_token_transactions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: ai_token_transactions ai_token_transactions_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_token_transactions
    ADD CONSTRAINT ai_token_transactions_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: ai_usage_events ai_usage_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage_events
    ADD CONSTRAINT ai_usage_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: ai_usage_events ai_usage_events_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage_events
    ADD CONSTRAINT ai_usage_events_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: audit_log audit_log_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_user_id_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_users_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE SET NULL;


--
-- Name: bidder_actions bidder_actions_rule_id_bidder_rules_rule_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_actions
    ADD CONSTRAINT bidder_actions_rule_id_bidder_rules_rule_id_fk FOREIGN KEY (rule_id) REFERENCES public.bidder_rules(rule_id) ON DELETE SET NULL;


--
-- Name: bidder_actions bidder_actions_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_actions
    ADD CONSTRAINT bidder_actions_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.bidder_rules(rule_id) ON DELETE SET NULL;


--
-- Name: bidder_actions bidder_actions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_actions
    ADD CONSTRAINT bidder_actions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: bidder_actions bidder_actions_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_actions
    ADD CONSTRAINT bidder_actions_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: bidder_alerts bidder_alerts_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_alerts
    ADD CONSTRAINT bidder_alerts_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: bidder_alerts bidder_alerts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_alerts
    ADD CONSTRAINT bidder_alerts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: bidder_keyword_auto_rules bidder_keyword_auto_rules_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_keyword_auto_rules
    ADD CONSTRAINT bidder_keyword_auto_rules_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: bidder_keyword_auto_rules bidder_keyword_auto_rules_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_keyword_auto_rules
    ADD CONSTRAINT bidder_keyword_auto_rules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: bidder_keywords bidder_keywords_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_keywords
    ADD CONSTRAINT bidder_keywords_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: bidder_keywords bidder_keywords_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_keywords
    ADD CONSTRAINT bidder_keywords_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: bidder_rules bidder_rules_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_rules
    ADD CONSTRAINT bidder_rules_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE CASCADE;


--
-- Name: bidder_rules bidder_rules_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_rules
    ADD CONSTRAINT bidder_rules_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE CASCADE;


--
-- Name: bidder_rules bidder_rules_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_rules
    ADD CONSTRAINT bidder_rules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: bidder_rules bidder_rules_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_rules
    ADD CONSTRAINT bidder_rules_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: bidder_settings bidder_settings_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_settings
    ADD CONSTRAINT bidder_settings_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: bidder_settings bidder_settings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_settings
    ADD CONSTRAINT bidder_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: bidder_settings bidder_settings_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bidder_settings
    ADD CONSTRAINT bidder_settings_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: cashflow_categories cashflow_categories_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_categories
    ADD CONSTRAINT cashflow_categories_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: cashflow_categories cashflow_categories_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_categories
    ADD CONSTRAINT cashflow_categories_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: cashflow_entries cashflow_entries_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_entries
    ADD CONSTRAINT cashflow_entries_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: cashflow_entries cashflow_entries_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_entries
    ADD CONSTRAINT cashflow_entries_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: cashflow_entries cashflow_entries_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_entries
    ADD CONSTRAINT cashflow_entries_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: cashflow_planned_items cashflow_planned_items_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_planned_items
    ADD CONSTRAINT cashflow_planned_items_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: cashflow_planned_items cashflow_planned_items_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_planned_items
    ADD CONSTRAINT cashflow_planned_items_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: cashflow_planned_items cashflow_planned_items_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_planned_items
    ADD CONSTRAINT cashflow_planned_items_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: cashflow_settings cashflow_settings_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_settings
    ADD CONSTRAINT cashflow_settings_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: cashflow_settings cashflow_settings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_settings
    ADD CONSTRAINT cashflow_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: cashflow_settings cashflow_settings_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_settings
    ADD CONSTRAINT cashflow_settings_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: cashflow_wb_payouts cashflow_wb_payouts_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_wb_payouts
    ADD CONSTRAINT cashflow_wb_payouts_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: cashflow_wb_payouts cashflow_wb_payouts_synced_to_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_wb_payouts
    ADD CONSTRAINT cashflow_wb_payouts_synced_to_entry_id_fkey FOREIGN KEY (synced_to_entry_id) REFERENCES public.cashflow_entries(entry_id);


--
-- Name: cashflow_wb_payouts cashflow_wb_payouts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_wb_payouts
    ADD CONSTRAINT cashflow_wb_payouts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: cashflow_wb_payouts cashflow_wb_payouts_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cashflow_wb_payouts
    ADD CONSTRAINT cashflow_wb_payouts_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: creative_audit_experiments creative_audit_experiments_audit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_experiments
    ADD CONSTRAINT creative_audit_experiments_audit_id_fkey FOREIGN KEY (audit_id) REFERENCES public.creative_audit_runs_final(id) ON DELETE CASCADE;


--
-- Name: creative_audit_experiments creative_audit_experiments_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_experiments
    ADD CONSTRAINT creative_audit_experiments_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: creative_audit_experiments creative_audit_experiments_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_experiments
    ADD CONSTRAINT creative_audit_experiments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: creative_audit_jobs creative_audit_jobs_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_jobs
    ADD CONSTRAINT creative_audit_jobs_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: creative_audit_jobs creative_audit_jobs_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_jobs
    ADD CONSTRAINT creative_audit_jobs_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: creative_audit_runs_final creative_audit_runs_final_card_audit_id_creative_card_audit_run; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_runs_final
    ADD CONSTRAINT creative_audit_runs_final_card_audit_id_creative_card_audit_run FOREIGN KEY (card_audit_id) REFERENCES public.creative_card_audit_runs(id);


--
-- Name: creative_audit_runs_final creative_audit_runs_final_photo_audit_id_creative_photo_audit_r; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_runs_final
    ADD CONSTRAINT creative_audit_runs_final_photo_audit_id_creative_photo_audit_r FOREIGN KEY (photo_audit_id) REFERENCES public.creative_photo_audit_runs(id);


--
-- Name: creative_audit_runs_final creative_audit_runs_final_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_runs_final
    ADD CONSTRAINT creative_audit_runs_final_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: creative_audit_runs_final creative_audit_runs_final_snapshot_id_creative_card_snapshots_s; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_runs_final
    ADD CONSTRAINT creative_audit_runs_final_snapshot_id_creative_card_snapshots_s FOREIGN KEY (snapshot_id) REFERENCES public.creative_card_snapshots(snapshot_id);


--
-- Name: creative_audit_runs_final creative_audit_runs_final_workspace_id_workspaces_workspace_id_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_runs_final
    ADD CONSTRAINT creative_audit_runs_final_workspace_id_workspaces_workspace_id_ FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: creative_audit_runs creative_audit_runs_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_runs
    ADD CONSTRAINT creative_audit_runs_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: creative_audit_runs creative_audit_runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_runs
    ADD CONSTRAINT creative_audit_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: creative_audit_runs creative_audit_runs_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_audit_runs
    ADD CONSTRAINT creative_audit_runs_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: creative_card_audit_runs creative_card_audit_runs_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_card_audit_runs
    ADD CONSTRAINT creative_card_audit_runs_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: creative_card_audit_runs creative_card_audit_runs_snapshot_id_creative_card_snapshots_sn; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_card_audit_runs
    ADD CONSTRAINT creative_card_audit_runs_snapshot_id_creative_card_snapshots_sn FOREIGN KEY (snapshot_id) REFERENCES public.creative_card_snapshots(snapshot_id);


--
-- Name: creative_card_audit_runs creative_card_audit_runs_workspace_id_workspaces_workspace_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_card_audit_runs
    ADD CONSTRAINT creative_card_audit_runs_workspace_id_workspaces_workspace_id_f FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: creative_card_snapshots creative_card_snapshots_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_card_snapshots
    ADD CONSTRAINT creative_card_snapshots_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: creative_card_snapshots creative_card_snapshots_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_card_snapshots
    ADD CONSTRAINT creative_card_snapshots_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: creative_image_generations creative_image_generations_ab_test_id_ab_photo_tests_test_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_image_generations
    ADD CONSTRAINT creative_image_generations_ab_test_id_ab_photo_tests_test_id_fk FOREIGN KEY (ab_test_id) REFERENCES public.ab_photo_tests(test_id) ON DELETE SET NULL;


--
-- Name: creative_image_generations creative_image_generations_ab_test_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_image_generations
    ADD CONSTRAINT creative_image_generations_ab_test_id_fkey FOREIGN KEY (ab_test_id) REFERENCES public.ab_photo_tests(test_id) ON DELETE SET NULL;


--
-- Name: creative_image_generations creative_image_generations_audit_id_creative_audit_runs_final_i; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_image_generations
    ADD CONSTRAINT creative_image_generations_audit_id_creative_audit_runs_final_i FOREIGN KEY (audit_id) REFERENCES public.creative_audit_runs_final(id) ON DELETE SET NULL;


--
-- Name: creative_image_generations creative_image_generations_audit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_image_generations
    ADD CONSTRAINT creative_image_generations_audit_id_fkey FOREIGN KEY (audit_id) REFERENCES public.creative_audit_runs_final(id) ON DELETE SET NULL;


--
-- Name: creative_image_generations creative_image_generations_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_image_generations
    ADD CONSTRAINT creative_image_generations_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: creative_image_generations creative_image_generations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_image_generations
    ADD CONSTRAINT creative_image_generations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: creative_image_generations creative_image_generations_workspace_id_workspaces_workspace_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_image_generations
    ADD CONSTRAINT creative_image_generations_workspace_id_workspaces_workspace_id FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: creative_photo_audit_runs creative_photo_audit_runs_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_photo_audit_runs
    ADD CONSTRAINT creative_photo_audit_runs_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: creative_photo_audit_runs creative_photo_audit_runs_snapshot_id_creative_card_snapshots_s; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_photo_audit_runs
    ADD CONSTRAINT creative_photo_audit_runs_snapshot_id_creative_card_snapshots_s FOREIGN KEY (snapshot_id) REFERENCES public.creative_card_snapshots(snapshot_id);


--
-- Name: creative_photo_audit_runs creative_photo_audit_runs_workspace_id_workspaces_workspace_id_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_photo_audit_runs
    ADD CONSTRAINT creative_photo_audit_runs_workspace_id_workspaces_workspace_id_ FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: creative_visual_assets creative_visual_assets_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_visual_assets
    ADD CONSTRAINT creative_visual_assets_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.creative_visual_jobs(job_id) ON DELETE CASCADE;


--
-- Name: creative_visual_jobs creative_visual_jobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_visual_jobs
    ADD CONSTRAINT creative_visual_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: creative_visual_slides creative_visual_slides_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.creative_visual_slides
    ADD CONSTRAINT creative_visual_slides_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.creative_visual_jobs(job_id) ON DELETE CASCADE;


--
-- Name: document_chunks document_chunks_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_chunks
    ADD CONSTRAINT document_chunks_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: documents documents_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: fbs_documents fbs_documents_run_id_fbs_runs_run_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fbs_documents
    ADD CONSTRAINT fbs_documents_run_id_fbs_runs_run_id_fk FOREIGN KEY (run_id) REFERENCES public.fbs_runs(run_id) ON DELETE CASCADE;


--
-- Name: fbs_documents fbs_documents_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fbs_documents
    ADD CONSTRAINT fbs_documents_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.fbs_runs(run_id) ON DELETE CASCADE;


--
-- Name: fbs_runs fbs_runs_schedule_id_fbs_schedules_schedule_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fbs_runs
    ADD CONSTRAINT fbs_runs_schedule_id_fbs_schedules_schedule_id_fk FOREIGN KEY (schedule_id) REFERENCES public.fbs_schedules(schedule_id);


--
-- Name: fbs_runs fbs_runs_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fbs_runs
    ADD CONSTRAINT fbs_runs_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.fbs_schedules(schedule_id);


--
-- Name: fbs_runs fbs_runs_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fbs_runs
    ADD CONSTRAINT fbs_runs_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id);


--
-- Name: fbs_runs fbs_runs_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fbs_runs
    ADD CONSTRAINT fbs_runs_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id);


--
-- Name: fbs_runs fbs_runs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fbs_runs
    ADD CONSTRAINT fbs_runs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: fbs_runs fbs_runs_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fbs_runs
    ADD CONSTRAINT fbs_runs_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: fbs_schedules fbs_schedules_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fbs_schedules
    ADD CONSTRAINT fbs_schedules_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id);


--
-- Name: fbs_schedules fbs_schedules_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fbs_schedules
    ADD CONSTRAINT fbs_schedules_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id);


--
-- Name: fbs_schedules fbs_schedules_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fbs_schedules
    ADD CONSTRAINT fbs_schedules_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: fbs_schedules fbs_schedules_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fbs_schedules
    ADD CONSTRAINT fbs_schedules_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: feedback_reply_log feedback_reply_log_approved_by_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback_reply_log
    ADD CONSTRAINT feedback_reply_log_approved_by_users_user_id_fk FOREIGN KEY (approved_by) REFERENCES public.users(user_id);


--
-- Name: feedback_reply_log feedback_reply_log_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback_reply_log
    ADD CONSTRAINT feedback_reply_log_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: feedback_reply_log feedback_reply_log_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feedback_reply_log
    ADD CONSTRAINT feedback_reply_log_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: insight_settings insight_settings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insight_settings
    ADD CONSTRAINT insight_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: insight_settings insight_settings_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insight_settings
    ADD CONSTRAINT insight_settings_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: insights insights_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insights
    ADD CONSTRAINT insights_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: insights insights_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insights
    ADD CONSTRAINT insights_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: insights insights_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insights
    ADD CONSTRAINT insights_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: knowledge_entries knowledge_entries_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_entries
    ADD CONSTRAINT knowledge_entries_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: marketplace_feedback_analysis marketplace_feedback_analysis_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_feedback_analysis
    ADD CONSTRAINT marketplace_feedback_analysis_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: marketplace_feedback_analysis marketplace_feedback_analysis_workspace_id_workspaces_workspace; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_feedback_analysis
    ADD CONSTRAINT marketplace_feedback_analysis_workspace_id_workspaces_workspace FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: marketplace_feedback_items marketplace_feedback_items_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_feedback_items
    ADD CONSTRAINT marketplace_feedback_items_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: marketplace_feedback_items marketplace_feedback_items_workspace_id_workspaces_workspace_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_feedback_items
    ADD CONSTRAINT marketplace_feedback_items_workspace_id_workspaces_workspace_id FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: marketplace_reply_drafts marketplace_reply_drafts_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_reply_drafts
    ADD CONSTRAINT marketplace_reply_drafts_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: marketplace_reply_drafts marketplace_reply_drafts_workspace_id_workspaces_workspace_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_reply_drafts
    ADD CONSTRAINT marketplace_reply_drafts_workspace_id_workspaces_workspace_id_f FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: marketplace_reply_settings marketplace_reply_settings_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_reply_settings
    ADD CONSTRAINT marketplace_reply_settings_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: marketplace_reply_settings marketplace_reply_settings_workspace_id_workspaces_workspace_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_reply_settings
    ADD CONSTRAINT marketplace_reply_settings_workspace_id_workspaces_workspace_id FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: marketplace_shops marketplace_shops_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_shops
    ADD CONSTRAINT marketplace_shops_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: marketplace_shops marketplace_shops_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.marketplace_shops
    ADD CONSTRAINT marketplace_shops_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: notification_settings notification_settings_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_settings
    ADD CONSTRAINT notification_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: notification_settings notification_settings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_settings
    ADD CONSTRAINT notification_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: price_ab_phases price_ab_phases_test_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_ab_phases
    ADD CONSTRAINT price_ab_phases_test_id_fkey FOREIGN KEY (test_id) REFERENCES public.price_ab_tests(test_id) ON DELETE CASCADE;


--
-- Name: price_ab_tests price_ab_tests_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_ab_tests
    ADD CONSTRAINT price_ab_tests_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: price_ab_tests price_ab_tests_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_ab_tests
    ADD CONSTRAINT price_ab_tests_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: pricing_decisions pricing_decisions_action_id_agent_actions_action_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_decisions
    ADD CONSTRAINT pricing_decisions_action_id_agent_actions_action_id_fk FOREIGN KEY (action_id) REFERENCES public.agent_actions(action_id);


--
-- Name: pricing_decisions pricing_decisions_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_decisions
    ADD CONSTRAINT pricing_decisions_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: pricing_decisions pricing_decisions_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_decisions
    ADD CONSTRAINT pricing_decisions_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: pricing_strategies pricing_strategies_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_strategies
    ADD CONSTRAINT pricing_strategies_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: pricing_strategies pricing_strategies_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_strategies
    ADD CONSTRAINT pricing_strategies_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: pulse_alert_controls pulse_alert_controls_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_alert_controls
    ADD CONSTRAINT pulse_alert_controls_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: pulse_alert_controls pulse_alert_controls_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_alert_controls
    ADD CONSTRAINT pulse_alert_controls_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: pulse_metrics_catalog pulse_metrics_catalog_group_id_pulse_metric_groups_group_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_metrics_catalog
    ADD CONSTRAINT pulse_metrics_catalog_group_id_pulse_metric_groups_group_id_fk FOREIGN KEY (group_id) REFERENCES public.pulse_metric_groups(group_id);


--
-- Name: pulse_plans pulse_plans_created_by_user_id_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_plans
    ADD CONSTRAINT pulse_plans_created_by_user_id_users_user_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(user_id);


--
-- Name: pulse_plans pulse_plans_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_plans
    ADD CONSTRAINT pulse_plans_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: pulse_plans pulse_plans_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_plans
    ADD CONSTRAINT pulse_plans_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: pulse_preset_events pulse_preset_events_actor_user_id_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_preset_events
    ADD CONSTRAINT pulse_preset_events_actor_user_id_users_user_id_fk FOREIGN KEY (actor_user_id) REFERENCES public.users(user_id);


--
-- Name: pulse_preset_events pulse_preset_events_preset_id_pulse_presets_preset_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_preset_events
    ADD CONSTRAINT pulse_preset_events_preset_id_pulse_presets_preset_id_fk FOREIGN KEY (preset_id) REFERENCES public.pulse_presets(preset_id);


--
-- Name: pulse_preset_events pulse_preset_events_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_preset_events
    ADD CONSTRAINT pulse_preset_events_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: pulse_preset_group_settings pulse_preset_group_settings_group_id_pulse_metric_groups_group_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_preset_group_settings
    ADD CONSTRAINT pulse_preset_group_settings_group_id_pulse_metric_groups_group_ FOREIGN KEY (group_id) REFERENCES public.pulse_metric_groups(group_id);


--
-- Name: pulse_preset_group_settings pulse_preset_group_settings_preset_id_pulse_presets_preset_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_preset_group_settings
    ADD CONSTRAINT pulse_preset_group_settings_preset_id_pulse_presets_preset_id_f FOREIGN KEY (preset_id) REFERENCES public.pulse_presets(preset_id) ON DELETE CASCADE;


--
-- Name: pulse_preset_metric_settings pulse_preset_metric_settings_metric_id_pulse_metrics_catalog_me; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_preset_metric_settings
    ADD CONSTRAINT pulse_preset_metric_settings_metric_id_pulse_metrics_catalog_me FOREIGN KEY (metric_id) REFERENCES public.pulse_metrics_catalog(metric_id);


--
-- Name: pulse_preset_metric_settings pulse_preset_metric_settings_preset_id_pulse_presets_preset_id_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_preset_metric_settings
    ADD CONSTRAINT pulse_preset_metric_settings_preset_id_pulse_presets_preset_id_ FOREIGN KEY (preset_id) REFERENCES public.pulse_presets(preset_id) ON DELETE CASCADE;


--
-- Name: pulse_presets pulse_presets_created_by_user_id_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_presets
    ADD CONSTRAINT pulse_presets_created_by_user_id_users_user_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(user_id);


--
-- Name: pulse_presets pulse_presets_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_presets
    ADD CONSTRAINT pulse_presets_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE CASCADE;


--
-- Name: pulse_presets pulse_presets_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pulse_presets
    ADD CONSTRAINT pulse_presets_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: region_warehouse_mapping region_warehouse_mapping_warehouse_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.region_warehouse_mapping
    ADD CONSTRAINT region_warehouse_mapping_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES public.wb_warehouses(id);


--
-- Name: seo_addresses seo_addresses_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_addresses
    ADD CONSTRAINT seo_addresses_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: seo_addresses seo_addresses_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_addresses
    ADD CONSTRAINT seo_addresses_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: seo_alerts seo_alerts_keyword_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_alerts
    ADD CONSTRAINT seo_alerts_keyword_id_fkey FOREIGN KEY (keyword_id) REFERENCES public.seo_keywords(keyword_id) ON DELETE CASCADE;


--
-- Name: seo_alerts seo_alerts_keyword_id_seo_keywords_keyword_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_alerts
    ADD CONSTRAINT seo_alerts_keyword_id_seo_keywords_keyword_id_fk FOREIGN KEY (keyword_id) REFERENCES public.seo_keywords(keyword_id) ON DELETE CASCADE;


--
-- Name: seo_competitor_keywords seo_competitor_keywords_competitor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_competitor_keywords
    ADD CONSTRAINT seo_competitor_keywords_competitor_id_fkey FOREIGN KEY (competitor_id) REFERENCES public.seo_competitors(competitor_id) ON DELETE CASCADE;


--
-- Name: seo_competitor_keywords seo_competitor_keywords_keyword_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_competitor_keywords
    ADD CONSTRAINT seo_competitor_keywords_keyword_id_fkey FOREIGN KEY (keyword_id) REFERENCES public.seo_keywords(keyword_id) ON DELETE CASCADE;


--
-- Name: seo_competitor_keywords seo_competitor_keywords_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_competitor_keywords
    ADD CONSTRAINT seo_competitor_keywords_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: seo_competitor_keywords seo_competitor_keywords_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_competitor_keywords
    ADD CONSTRAINT seo_competitor_keywords_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: seo_competitor_positions seo_competitor_positions_competitor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_competitor_positions
    ADD CONSTRAINT seo_competitor_positions_competitor_id_fkey FOREIGN KEY (competitor_id) REFERENCES public.seo_competitors(competitor_id) ON DELETE CASCADE;


--
-- Name: seo_competitor_positions seo_competitor_positions_keyword_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_competitor_positions
    ADD CONSTRAINT seo_competitor_positions_keyword_id_fkey FOREIGN KEY (keyword_id) REFERENCES public.seo_keywords(keyword_id) ON DELETE CASCADE;


--
-- Name: seo_competitor_positions seo_competitor_positions_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_competitor_positions
    ADD CONSTRAINT seo_competitor_positions_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: seo_competitor_positions seo_competitor_positions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_competitor_positions
    ADD CONSTRAINT seo_competitor_positions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: seo_competitors seo_competitors_keyword_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_competitors
    ADD CONSTRAINT seo_competitors_keyword_id_fkey FOREIGN KEY (keyword_id) REFERENCES public.seo_keywords(keyword_id) ON DELETE CASCADE;


--
-- Name: seo_competitors seo_competitors_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_competitors
    ADD CONSTRAINT seo_competitors_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: seo_competitors seo_competitors_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_competitors
    ADD CONSTRAINT seo_competitors_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: seo_jobs seo_jobs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_jobs
    ADD CONSTRAINT seo_jobs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: seo_keyword_products seo_keyword_products_keyword_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_keyword_products
    ADD CONSTRAINT seo_keyword_products_keyword_id_fkey FOREIGN KEY (keyword_id) REFERENCES public.seo_keywords(keyword_id) ON DELETE CASCADE;


--
-- Name: seo_keyword_products seo_keyword_products_keyword_id_seo_keywords_keyword_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_keyword_products
    ADD CONSTRAINT seo_keyword_products_keyword_id_seo_keywords_keyword_id_fk FOREIGN KEY (keyword_id) REFERENCES public.seo_keywords(keyword_id) ON DELETE CASCADE;


--
-- Name: seo_keyword_tag_links seo_keyword_tag_links_keyword_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_keyword_tag_links
    ADD CONSTRAINT seo_keyword_tag_links_keyword_id_fkey FOREIGN KEY (keyword_id) REFERENCES public.seo_keywords(keyword_id) ON DELETE CASCADE;


--
-- Name: seo_keyword_tag_links seo_keyword_tag_links_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_keyword_tag_links
    ADD CONSTRAINT seo_keyword_tag_links_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.seo_keyword_tags(tag_id) ON DELETE CASCADE;


--
-- Name: seo_keyword_tags seo_keyword_tags_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_keyword_tags
    ADD CONSTRAINT seo_keyword_tags_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: seo_keyword_tags seo_keyword_tags_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_keyword_tags
    ADD CONSTRAINT seo_keyword_tags_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: seo_keywords seo_keywords_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_keywords
    ADD CONSTRAINT seo_keywords_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE CASCADE;


--
-- Name: seo_keywords seo_keywords_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_keywords
    ADD CONSTRAINT seo_keywords_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE CASCADE;


--
-- Name: seo_keywords seo_keywords_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_keywords
    ADD CONSTRAINT seo_keywords_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: seo_keywords seo_keywords_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_keywords
    ADD CONSTRAINT seo_keywords_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: seo_position_snapshots seo_position_snapshots_keyword_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_position_snapshots
    ADD CONSTRAINT seo_position_snapshots_keyword_id_fkey FOREIGN KEY (keyword_id) REFERENCES public.seo_keywords(keyword_id) ON DELETE CASCADE;


--
-- Name: seo_position_snapshots seo_position_snapshots_keyword_id_seo_keywords_keyword_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_position_snapshots
    ADD CONSTRAINT seo_position_snapshots_keyword_id_seo_keywords_keyword_id_fk FOREIGN KEY (keyword_id) REFERENCES public.seo_keywords(keyword_id) ON DELETE CASCADE;


--
-- Name: seo_settings seo_settings_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_settings
    ADD CONSTRAINT seo_settings_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: seo_settings seo_settings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seo_settings
    ADD CONSTRAINT seo_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: studio_assets studio_assets_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_assets
    ADD CONSTRAINT studio_assets_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.studio_projects(project_id) ON DELETE SET NULL;


--
-- Name: studio_assets studio_assets_project_id_studio_projects_project_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_assets
    ADD CONSTRAINT studio_assets_project_id_studio_projects_project_id_fk FOREIGN KEY (project_id) REFERENCES public.studio_projects(project_id) ON DELETE SET NULL;


--
-- Name: studio_assets studio_assets_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_assets
    ADD CONSTRAINT studio_assets_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: studio_assets studio_assets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_assets
    ADD CONSTRAINT studio_assets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE SET NULL;


--
-- Name: studio_assets studio_assets_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_assets
    ADD CONSTRAINT studio_assets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: studio_assets studio_assets_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_assets
    ADD CONSTRAINT studio_assets_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: studio_credits studio_credits_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_credits
    ADD CONSTRAINT studio_credits_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: studio_credits studio_credits_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_credits
    ADD CONSTRAINT studio_credits_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: studio_presets studio_presets_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_presets
    ADD CONSTRAINT studio_presets_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: studio_presets studio_presets_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_presets
    ADD CONSTRAINT studio_presets_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: studio_projects studio_projects_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_projects
    ADD CONSTRAINT studio_projects_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: studio_projects studio_projects_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_projects
    ADD CONSTRAINT studio_projects_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: studio_projects studio_projects_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_projects
    ADD CONSTRAINT studio_projects_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: studio_prompt_suggestions studio_prompt_suggestions_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_prompt_suggestions
    ADD CONSTRAINT studio_prompt_suggestions_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: studio_prompt_suggestions studio_prompt_suggestions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_prompt_suggestions
    ADD CONSTRAINT studio_prompt_suggestions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE SET NULL;


--
-- Name: studio_prompt_suggestions studio_prompt_suggestions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_prompt_suggestions
    ADD CONSTRAINT studio_prompt_suggestions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: studio_tasks studio_tasks_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_tasks
    ADD CONSTRAINT studio_tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.studio_projects(project_id) ON DELETE SET NULL;


--
-- Name: studio_tasks studio_tasks_project_id_studio_projects_project_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_tasks
    ADD CONSTRAINT studio_tasks_project_id_studio_projects_project_id_fk FOREIGN KEY (project_id) REFERENCES public.studio_projects(project_id) ON DELETE SET NULL;


--
-- Name: studio_tasks studio_tasks_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_tasks
    ADD CONSTRAINT studio_tasks_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: studio_tasks studio_tasks_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_tasks
    ADD CONSTRAINT studio_tasks_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: studio_tasks studio_tasks_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_tasks
    ADD CONSTRAINT studio_tasks_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: supplies supplies_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplies
    ADD CONSTRAINT supplies_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.supply_drafts(draft_id);


--
-- Name: supplies supplies_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplies
    ADD CONSTRAINT supplies_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: supplies supplies_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supplies
    ADD CONSTRAINT supplies_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: supply_booking_queue supply_booking_queue_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_booking_queue
    ADD CONSTRAINT supply_booking_queue_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.supply_drafts(draft_id) ON DELETE CASCADE;


--
-- Name: supply_booking_queue supply_booking_queue_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_booking_queue
    ADD CONSTRAINT supply_booking_queue_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: supply_box_settings supply_box_settings_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_box_settings
    ADD CONSTRAINT supply_box_settings_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: supply_box_settings supply_box_settings_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_box_settings
    ADD CONSTRAINT supply_box_settings_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: supply_boxes supply_boxes_supply_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_boxes
    ADD CONSTRAINT supply_boxes_supply_id_fkey FOREIGN KEY (supply_id) REFERENCES public.supplies(supply_id) ON DELETE CASCADE;


--
-- Name: supply_documents supply_documents_supply_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_documents
    ADD CONSTRAINT supply_documents_supply_id_fkey FOREIGN KEY (supply_id) REFERENCES public.supplies(supply_id) ON DELETE CASCADE;


--
-- Name: supply_draft_items supply_draft_items_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_draft_items
    ADD CONSTRAINT supply_draft_items_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.supply_drafts(draft_id) ON DELETE CASCADE;


--
-- Name: supply_drafts supply_drafts_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_drafts
    ADD CONSTRAINT supply_drafts_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: supply_drafts supply_drafts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_drafts
    ADD CONSTRAINT supply_drafts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: supply_drivers supply_drivers_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_drivers
    ADD CONSTRAINT supply_drivers_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: supply_drivers supply_drivers_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_drivers
    ADD CONSTRAINT supply_drivers_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: supply_passes supply_passes_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_passes
    ADD CONSTRAINT supply_passes_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: supply_passes supply_passes_supply_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_passes
    ADD CONSTRAINT supply_passes_supply_id_fkey FOREIGN KEY (supply_id) REFERENCES public.supplies(supply_id) ON DELETE SET NULL;


--
-- Name: supply_passes supply_passes_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_passes
    ADD CONSTRAINT supply_passes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: supply_priority_warehouses supply_priority_warehouses_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_priority_warehouses
    ADD CONSTRAINT supply_priority_warehouses_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: supply_priority_warehouses supply_priority_warehouses_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_priority_warehouses
    ADD CONSTRAINT supply_priority_warehouses_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: supply_roi_history supply_roi_history_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_roi_history
    ADD CONSTRAINT supply_roi_history_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: supply_roi_history supply_roi_history_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.supply_roi_history
    ADD CONSTRAINT supply_roi_history_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: system_events system_events_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_events
    ADD CONSTRAINT system_events_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: system_events system_events_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_events
    ADD CONSTRAINT system_events_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: system_events system_events_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_events
    ADD CONSTRAINT system_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE SET NULL;


--
-- Name: tg_chat_messages tg_chat_messages_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tg_chat_messages
    ADD CONSTRAINT tg_chat_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.tg_chat_sessions(session_id) ON DELETE CASCADE;


--
-- Name: user_refresh_tokens user_refresh_tokens_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_refresh_tokens
    ADD CONSTRAINT user_refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.user_sessions(session_id) ON DELETE CASCADE;


--
-- Name: user_refresh_tokens user_refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_refresh_tokens
    ADD CONSTRAINT user_refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: user_sessions user_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: user_sessions user_sessions_user_id_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_sessions
    ADD CONSTRAINT user_sessions_user_id_users_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: user_telegram_link_codes user_telegram_link_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_telegram_link_codes
    ADD CONSTRAINT user_telegram_link_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: user_telegram_links user_telegram_links_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_telegram_links
    ADD CONSTRAINT user_telegram_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: wb_adv_daily_products wb_adv_daily_products_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_adv_daily_products
    ADD CONSTRAINT wb_adv_daily_products_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_adv_daily_products wb_adv_daily_products_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_adv_daily_products
    ADD CONSTRAINT wb_adv_daily_products_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_adv_daily wb_adv_daily_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_adv_daily
    ADD CONSTRAINT wb_adv_daily_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_adv_daily wb_adv_daily_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_adv_daily
    ADD CONSTRAINT wb_adv_daily_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_adv_finance_daily wb_adv_finance_daily_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_adv_finance_daily
    ADD CONSTRAINT wb_adv_finance_daily_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_adv_finance_daily wb_adv_finance_daily_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_adv_finance_daily
    ADD CONSTRAINT wb_adv_finance_daily_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_adv_finance_daily wb_adv_finance_daily_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_adv_finance_daily
    ADD CONSTRAINT wb_adv_finance_daily_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_adv_finance wb_adv_finance_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_adv_finance
    ADD CONSTRAINT wb_adv_finance_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_adv_finance wb_adv_finance_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_adv_finance
    ADD CONSTRAINT wb_adv_finance_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_adv_finance wb_adv_finance_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_adv_finance
    ADD CONSTRAINT wb_adv_finance_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_alert_settings wb_alert_settings_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_alert_settings
    ADD CONSTRAINT wb_alert_settings_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: wb_alert_settings wb_alert_settings_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_alert_settings
    ADD CONSTRAINT wb_alert_settings_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_backfill_progress wb_backfill_progress_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_backfill_progress
    ADD CONSTRAINT wb_backfill_progress_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE CASCADE;


--
-- Name: wb_backfill_progress wb_backfill_progress_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_backfill_progress
    ADD CONSTRAINT wb_backfill_progress_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: wb_campaigns wb_campaigns_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_campaigns
    ADD CONSTRAINT wb_campaigns_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id);


--
-- Name: wb_campaigns wb_campaigns_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_campaigns
    ADD CONSTRAINT wb_campaigns_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: wb_card_snapshots wb_card_snapshots_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_card_snapshots
    ADD CONSTRAINT wb_card_snapshots_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_cards wb_cards_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_cards
    ADD CONSTRAINT wb_cards_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_chats wb_chats_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_chats
    ADD CONSTRAINT wb_chats_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: wb_cogs wb_cogs_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_cogs
    ADD CONSTRAINT wb_cogs_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: wb_cogs wb_cogs_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_cogs
    ADD CONSTRAINT wb_cogs_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_compensations wb_compensations_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_compensations
    ADD CONSTRAINT wb_compensations_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE CASCADE;


--
-- Name: wb_compensations wb_compensations_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_compensations
    ADD CONSTRAINT wb_compensations_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE CASCADE;


--
-- Name: wb_compensations wb_compensations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_compensations
    ADD CONSTRAINT wb_compensations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_compensations wb_compensations_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_compensations
    ADD CONSTRAINT wb_compensations_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_deductions_daily wb_deductions_daily_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_deductions_daily
    ADD CONSTRAINT wb_deductions_daily_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_event_comments wb_event_comments_event_id_wb_events_event_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_event_comments
    ADD CONSTRAINT wb_event_comments_event_id_wb_events_event_id_fk FOREIGN KEY (event_id) REFERENCES public.wb_events(event_id) ON DELETE CASCADE;


--
-- Name: wb_events wb_events_assignee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_events
    ADD CONSTRAINT wb_events_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.users(user_id) ON DELETE SET NULL;


--
-- Name: wb_events wb_events_parent_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_events
    ADD CONSTRAINT wb_events_parent_event_id_fkey FOREIGN KEY (parent_event_id) REFERENCES public.wb_events(event_id) ON DELETE CASCADE;


--
-- Name: wb_events wb_events_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_events
    ADD CONSTRAINT wb_events_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_events wb_events_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_events
    ADD CONSTRAINT wb_events_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_fbs_shipments_daily_products wb_fbs_shipments_daily_products_shop_id_marketplace_shops_shop_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_fbs_shipments_daily_products
    ADD CONSTRAINT wb_fbs_shipments_daily_products_shop_id_marketplace_shops_shop_ FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: wb_fbs_shipments_daily_products wb_fbs_shipments_daily_products_workspace_id_workspaces_workspa; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_fbs_shipments_daily_products
    ADD CONSTRAINT wb_fbs_shipments_daily_products_workspace_id_workspaces_workspa FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_fbs_supplies wb_fbs_supplies_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_fbs_supplies
    ADD CONSTRAINT wb_fbs_supplies_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: wb_fbs_supplies wb_fbs_supplies_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_fbs_supplies
    ADD CONSTRAINT wb_fbs_supplies_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: wb_fbs_supply_orders wb_fbs_supply_orders_fbs_supply_pk_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_fbs_supply_orders
    ADD CONSTRAINT wb_fbs_supply_orders_fbs_supply_pk_fkey FOREIGN KEY (fbs_supply_pk) REFERENCES public.wb_fbs_supplies(id) ON DELETE CASCADE;


--
-- Name: wb_finance_daily_products wb_finance_daily_products_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_finance_daily_products
    ADD CONSTRAINT wb_finance_daily_products_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_finance_daily_products wb_finance_daily_products_workspace_id_workspaces_workspace_id_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_finance_daily_products
    ADD CONSTRAINT wb_finance_daily_products_workspace_id_workspaces_workspace_id_ FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_finance_daily wb_finance_daily_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_finance_daily
    ADD CONSTRAINT wb_finance_daily_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_finance_daily wb_finance_daily_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_finance_daily
    ADD CONSTRAINT wb_finance_daily_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_finance_weekly_products wb_finance_weekly_products_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_finance_weekly_products
    ADD CONSTRAINT wb_finance_weekly_products_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_finance_weekly_products wb_finance_weekly_products_workspace_id_workspaces_workspace_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_finance_weekly_products
    ADD CONSTRAINT wb_finance_weekly_products_workspace_id_workspaces_workspace_id FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_funnel_daily_products wb_funnel_daily_products_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_funnel_daily_products
    ADD CONSTRAINT wb_funnel_daily_products_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_funnel_daily_products wb_funnel_daily_products_workspace_id_workspaces_workspace_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_funnel_daily_products
    ADD CONSTRAINT wb_funnel_daily_products_workspace_id_workspaces_workspace_id_f FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_funnel_daily wb_funnel_daily_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_funnel_daily
    ADD CONSTRAINT wb_funnel_daily_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_funnel_daily wb_funnel_daily_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_funnel_daily
    ADD CONSTRAINT wb_funnel_daily_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_hidden_products wb_hidden_products_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_hidden_products
    ADD CONSTRAINT wb_hidden_products_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE CASCADE;


--
-- Name: wb_orders_sales_daily_product_regions wb_orders_sales_daily_product_regions_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_product_regions
    ADD CONSTRAINT wb_orders_sales_daily_product_regions_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_orders_sales_daily_product_regions wb_orders_sales_daily_product_regions_workspace_id_workspaces_w; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_product_regions
    ADD CONSTRAINT wb_orders_sales_daily_product_regions_workspace_id_workspaces_w FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_orders_sales_daily_product_warehouses wb_orders_sales_daily_product_warehouses_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_product_warehouses
    ADD CONSTRAINT wb_orders_sales_daily_product_warehouses_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_orders_sales_daily_product_warehouses wb_orders_sales_daily_product_warehouses_workspace_id_workspace; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_product_warehouses
    ADD CONSTRAINT wb_orders_sales_daily_product_warehouses_workspace_id_workspace FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_orders_sales_daily_products wb_orders_sales_daily_products_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_products
    ADD CONSTRAINT wb_orders_sales_daily_products_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_orders_sales_daily_products wb_orders_sales_daily_products_workspace_id_workspaces_workspac; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_products
    ADD CONSTRAINT wb_orders_sales_daily_products_workspace_id_workspaces_workspac FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_orders_sales_daily_regions wb_orders_sales_daily_regions_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_regions
    ADD CONSTRAINT wb_orders_sales_daily_regions_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_orders_sales_daily_regions wb_orders_sales_daily_regions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_regions
    ADD CONSTRAINT wb_orders_sales_daily_regions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_orders_sales_daily_regions wb_orders_sales_daily_regions_workspace_id_workspaces_workspace; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_regions
    ADD CONSTRAINT wb_orders_sales_daily_regions_workspace_id_workspaces_workspace FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_orders_sales_daily wb_orders_sales_daily_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily
    ADD CONSTRAINT wb_orders_sales_daily_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_orders_sales_daily_warehouses wb_orders_sales_daily_warehouses_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_warehouses
    ADD CONSTRAINT wb_orders_sales_daily_warehouses_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_orders_sales_daily_warehouses wb_orders_sales_daily_warehouses_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_warehouses
    ADD CONSTRAINT wb_orders_sales_daily_warehouses_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_orders_sales_daily_warehouses wb_orders_sales_daily_warehouses_workspace_id_workspaces_worksp; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily_warehouses
    ADD CONSTRAINT wb_orders_sales_daily_warehouses_workspace_id_workspaces_worksp FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_orders_sales_daily wb_orders_sales_daily_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_orders_sales_daily
    ADD CONSTRAINT wb_orders_sales_daily_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_prices_history wb_prices_history_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_prices_history
    ADD CONSTRAINT wb_prices_history_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: wb_reconciliation_log wb_reconciliation_log_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_reconciliation_log
    ADD CONSTRAINT wb_reconciliation_log_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: wb_region_sales wb_region_sales_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_region_sales
    ADD CONSTRAINT wb_region_sales_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_returns wb_returns_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_returns
    ADD CONSTRAINT wb_returns_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: wb_search_queries wb_search_queries_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_search_queries
    ADD CONSTRAINT wb_search_queries_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: wb_self_purchases wb_self_purchases_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_self_purchases
    ADD CONSTRAINT wb_self_purchases_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(user_id);


--
-- Name: wb_self_purchases wb_self_purchases_created_by_user_id_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_self_purchases
    ADD CONSTRAINT wb_self_purchases_created_by_user_id_users_user_id_fk FOREIGN KEY (created_by_user_id) REFERENCES public.users(user_id);


--
-- Name: wb_self_purchases wb_self_purchases_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_self_purchases
    ADD CONSTRAINT wb_self_purchases_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE CASCADE;


--
-- Name: wb_self_purchases wb_self_purchases_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_self_purchases
    ADD CONSTRAINT wb_self_purchases_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE CASCADE;


--
-- Name: wb_self_purchases wb_self_purchases_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_self_purchases
    ADD CONSTRAINT wb_self_purchases_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_self_purchases wb_self_purchases_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_self_purchases
    ADD CONSTRAINT wb_self_purchases_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_shops wb_shops_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_shops
    ADD CONSTRAINT wb_shops_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_spp_weekly wb_spp_weekly_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_spp_weekly
    ADD CONSTRAINT wb_spp_weekly_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: wb_spp_weekly wb_spp_weekly_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_spp_weekly
    ADD CONSTRAINT wb_spp_weekly_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_stocks_current wb_stocks_current_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_stocks_current
    ADD CONSTRAINT wb_stocks_current_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_stocks_current wb_stocks_current_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_stocks_current
    ADD CONSTRAINT wb_stocks_current_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_stocks_daily_products wb_stocks_daily_products_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_stocks_daily_products
    ADD CONSTRAINT wb_stocks_daily_products_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_stocks_daily_products wb_stocks_daily_products_workspace_id_workspaces_workspace_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_stocks_daily_products
    ADD CONSTRAINT wb_stocks_daily_products_workspace_id_workspaces_workspace_id_f FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_stocks_daily wb_stocks_daily_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_stocks_daily
    ADD CONSTRAINT wb_stocks_daily_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL NOT VALID;


--
-- Name: wb_supplies wb_supplies_shop_id_marketplace_shops_shop_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_supplies
    ADD CONSTRAINT wb_supplies_shop_id_marketplace_shops_shop_id_fk FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE SET NULL;


--
-- Name: wb_supplies wb_supplies_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_supplies
    ADD CONSTRAINT wb_supplies_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_supply_box_items wb_supply_box_items_box_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_supply_box_items
    ADD CONSTRAINT wb_supply_box_items_box_id_fkey FOREIGN KEY (box_id) REFERENCES public.wb_supply_boxes(id) ON DELETE CASCADE;


--
-- Name: wb_supply_boxes wb_supply_boxes_supply_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_supply_boxes
    ADD CONSTRAINT wb_supply_boxes_supply_id_fkey FOREIGN KEY (supply_id) REFERENCES public.wb_supplies(id) ON DELETE CASCADE;


--
-- Name: wb_supply_items wb_supply_items_supply_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_supply_items
    ADD CONSTRAINT wb_supply_items_supply_id_fkey FOREIGN KEY (supply_id) REFERENCES public.wb_supplies(id) ON DELETE CASCADE;


--
-- Name: wb_sync_runs wb_sync_runs_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_sync_runs
    ADD CONSTRAINT wb_sync_runs_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_tag_products wb_tag_products_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_tag_products
    ADD CONSTRAINT wb_tag_products_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE CASCADE;


--
-- Name: wb_tag_products wb_tag_products_tag_id_wb_tags_tag_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_tag_products
    ADD CONSTRAINT wb_tag_products_tag_id_wb_tags_tag_id_fk FOREIGN KEY (tag_id) REFERENCES public.wb_tags(tag_id) ON DELETE CASCADE;


--
-- Name: wb_tag_products wb_tag_products_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_tag_products
    ADD CONSTRAINT wb_tag_products_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: wb_tags wb_tags_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_tags
    ADD CONSTRAINT wb_tags_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.marketplace_shops(shop_id) ON DELETE CASCADE;


--
-- Name: wb_tags wb_tags_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wb_tags
    ADD CONSTRAINT wb_tags_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: workspace_invites workspace_invites_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invites
    ADD CONSTRAINT workspace_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(user_id);


--
-- Name: workspace_invites workspace_invites_created_by_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invites
    ADD CONSTRAINT workspace_invites_created_by_users_user_id_fk FOREIGN KEY (created_by) REFERENCES public.users(user_id);


--
-- Name: workspace_invites workspace_invites_used_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invites
    ADD CONSTRAINT workspace_invites_used_by_fkey FOREIGN KEY (used_by) REFERENCES public.users(user_id);


--
-- Name: workspace_invites workspace_invites_used_by_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invites
    ADD CONSTRAINT workspace_invites_used_by_users_user_id_fk FOREIGN KEY (used_by) REFERENCES public.users(user_id);


--
-- Name: workspace_invites workspace_invites_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invites
    ADD CONSTRAINT workspace_invites_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: workspace_invites workspace_invites_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invites
    ADD CONSTRAINT workspace_invites_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(user_id);


--
-- Name: workspace_members workspace_members_invited_by_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_invited_by_users_user_id_fk FOREIGN KEY (invited_by) REFERENCES public.users(user_id);


--
-- Name: workspace_members workspace_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_user_id_users_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_user_id_users_user_id_fk FOREIGN KEY (user_id) REFERENCES public.users(user_id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id) ON DELETE CASCADE;


--
-- Name: workspace_payments workspace_payments_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_payments
    ADD CONSTRAINT workspace_payments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: workspace_payments workspace_payments_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_payments
    ADD CONSTRAINT workspace_payments_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: workspace_subscriptions workspace_subscriptions_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_subscriptions
    ADD CONSTRAINT workspace_subscriptions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- Name: workspace_subscriptions workspace_subscriptions_workspace_id_workspaces_workspace_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_subscriptions
    ADD CONSTRAINT workspace_subscriptions_workspace_id_workspaces_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspaces(workspace_id);


--
-- PostgreSQL database dump complete
--

