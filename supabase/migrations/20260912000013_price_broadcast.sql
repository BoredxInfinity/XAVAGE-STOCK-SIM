-- =====================================================================
-- XAVAGE STOCK SIM :: 0013 -- price delivery over Broadcast
-- =====================================================================
-- The app already received prices over Realtime, but via Postgres Changes,
-- which emits one message PER ROW PER SUBSCRIBER. The worker upserts 105
-- quotes every 5s, so each connected client was taking 21 messages/second:
--
--     4 clients x 20 trading days  ~  39 M messages
--     Supabase Pro allowance       ~   5 M messages
--
-- ...so the feed would have been throttled the moment real participants
-- connected, and the symptom would have been prices freezing mid-event.
--
-- Broadcast instead, one batched message per cycle carrying only the symbols
-- that actually moved. Same push latency, ~105x fewer messages, and no
-- per-row RLS evaluation per subscriber.
--
-- This is safe for quotes specifically because `quotes_read` is `using (true)`
-- -- prices are public to every participant, so a shared channel leaks
-- nothing. The order book is NOT like that: orders/positions/trades stay on
-- Postgres Changes, where per-row RLS keeps one team's book away from
-- another's. They only fire on real trades, so their volume is trivial.
-- =====================================================================

-- Private channels authorise through RLS on realtime.messages. Without a
-- policy the table denies everything, so a private channel silently fails to
-- subscribe -- which looks exactly like "realtime is broken".
drop policy if exists xavage_read_price_broadcast on realtime.messages;
create policy xavage_read_price_broadcast on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and realtime.topic() = 'xavage:prices'
  );

-- Deliberately no INSERT policy: clients receive prices, they never publish
-- them. The worker sends through the Realtime HTTP API as service_role, which
-- does not go through these policies.

comment on policy xavage_read_price_broadcast on realtime.messages is
  'Participants may subscribe to the price broadcast. Prices are public to all authenticated users (see quotes_read); the order book stays on Postgres Changes where per-row RLS applies.';
