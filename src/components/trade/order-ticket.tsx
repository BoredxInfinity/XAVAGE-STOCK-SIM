"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Info, Loader2, Zap } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useMarketStatus, usePortfolio } from "@/hooks/use-app-data";
import { useQuote } from "@/hooks/use-quote";
import { cn, money, num, qtyText } from "@/lib/format";
import type { OrderType, TimeInForce } from "@/lib/database.types";

const TYPES: { value: OrderType; label: string; blurb: string }[] = [
  { value: "market", label: "Market", blurb: "Fill immediately at the live price." },
  { value: "limit", label: "Limit", blurb: "Fill only at your price or better." },
  { value: "stop", label: "Stop", blurb: "Becomes a market order once the stop trades." },
  { value: "stop_limit", label: "Stop Limit", blurb: "Becomes a limit order once the stop trades." },
  { value: "trailing_stop", label: "Trailing Stop", blurb: "Stop that follows the price in your favour." },
];

export function OrderTicket({ symbol }: { symbol: string }) {
  const qc = useQueryClient();
  const quote = useQuote(symbol);
  const { data: portfolio } = usePortfolio();
  const { data: status } = useMarketStatus();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<OrderType>("market");
  const [qty, setQty] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [trailPercent, setTrailPercent] = useState("5");
  const [tif, setTif] = useState<TimeInForce>("day");
  const [busy, setBusy] = useState(false);
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());

  const price = quote?.price ?? 0;
  const settings = status?.settings;
  const fractional = settings?.allow_fractional_shares ?? false;

  const position = portfolio?.positions.find((p) => p.symbol === symbol);
  const heldQty = position?.qty ?? 0;
  const sellable = Math.max(0, heldQty - (position?.reserved_qty ?? 0));
  const buyingPower = portfolio?.metrics.buying_power ?? 0;

  // Reset the idempotency key whenever the ticket materially changes, so an
  // edited order isn't mistaken for a retry of the previous one.
  useEffect(() => { setIdemKey(crypto.randomUUID()); }, [symbol, side, type]);

  const qtyNum = Number(qty) || 0;

  /** The price this order is most likely to transact at, for the cost preview. */
  const refPrice = useMemo(() => {
    if (type === "limit" || type === "stop_limit") return Number(limitPrice) || price;
    if (type === "stop") return Number(stopPrice) || price;
    return price;
  }, [type, limitPrice, stopPrice, price]);

  const notional = qtyNum * refPrice;
  const commission = settings
    ? Math.max(
        settings.commission_per_trade + (notional * settings.commission_bps) / 10_000,
        settings.min_commission,
      )
    : 0;
  const total = side === "buy" ? notional + commission : notional - commission;

  const maxAffordable = useMemo(() => {
    if (side === "sell") return sellable;
    if (refPrice <= 0) return 0;
    const raw = buyingPower / refPrice;
    return fractional ? Math.max(0, Math.floor(raw * 1e4) / 1e4) : Math.floor(raw);
  }, [side, sellable, buyingPower, refPrice, fractional]);

  /* ---- client-side pre-flight; the database re-checks all of this ---- */
  const problem = useMemo(() => {
    if (!quote) return "Waiting for a live price…";
    if (qtyNum <= 0) return null;
    if (!fractional && !Number.isInteger(qtyNum)) return "Whole shares only.";
    if ((type === "limit" || type === "stop_limit") && !(Number(limitPrice) > 0))
      return "Enter a limit price.";
    if ((type === "stop" || type === "stop_limit") && !(Number(stopPrice) > 0))
      return "Enter a stop price.";
    if (type === "stop" || type === "stop_limit") {
      const sp = Number(stopPrice);
      if (side === "buy" && sp <= price) return `A buy stop must be above ${num(price)}.`;
      if (side === "sell" && sp >= price) return `A sell stop must be below ${num(price)}.`;
    }
    if (type === "trailing_stop" && !(Number(trailPercent) > 0 && Number(trailPercent) < 100))
      return "Trail must be between 0 and 100%.";
    if (side === "sell" && !settings?.allow_shorting && qtyNum > sellable)
      return sellable > 0
        ? `You can sell at most ${qtyText(sellable)} share(s).`
        : `You don't hold ${symbol}.`;
    if (side === "buy" && total > buyingPower)
      return `Costs ${money(total)} — buying power is ${money(buyingPower)}.`;
    return null;
  }, [quote, qtyNum, fractional, type, limitPrice, stopPrice, side, price, trailPercent,
      settings, sellable, symbol, total, buyingPower]);

  const canSubmit = !busy && qtyNum > 0 && !problem && !!quote;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);

    const supabase = createClient();
    const { data, error } = await supabase.rpc("place_order", {
      p_symbol: symbol,
      p_side: side,
      p_order_type: type,
      p_qty: qtyNum,
      p_limit_price: type === "limit" || type === "stop_limit" ? Number(limitPrice) : null,
      p_stop_price: type === "stop" || type === "stop_limit" ? Number(stopPrice) : null,
      p_trail_percent: type === "trailing_stop" ? Number(trailPercent) : null,
      p_trail_amount: null,
      p_tif: tif,
      p_client_order_id: idemKey,
    });

    if (error) {
      toast.error("Order rejected", { description: error.message });
      setBusy(false);
      return;
    }

    const result = data as unknown as { executed?: boolean; message: string };
    if (result.executed) toast.success("Filled", { description: result.message });
    else toast.info("Order placed", { description: result.message });

    setQty("");
    setIdemKey(crypto.randomUUID());
    qc.invalidateQueries({ queryKey: ["portfolio"] });
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["trades"] });
    setBusy(false);
  }

  const needsLimit = type === "limit" || type === "stop_limit";
  const needsStop = type === "stop" || type === "stop_limit";
  const marketClosed = status && !status.is_open;

  return (
    <div className="flex flex-col">
      {/* buy / sell */}
      <div className="grid grid-cols-2 gap-1.5 p-3 pb-0">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s} onClick={() => setSide(s)}
            className={cn(
              "py-2 rounded-lg text-sm font-bold uppercase tracking-wide transition-all border",
              side === s
                ? s === "buy"
                  ? "bg-[color-mix(in_oklab,var(--color-up)_18%,transparent)] border-[var(--color-up)] text-[var(--color-up)]"
                  : "bg-[color-mix(in_oklab,var(--color-down)_18%,transparent)] border-[var(--color-down)] text-[var(--color-down)]"
                : "border-[var(--color-border)] text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]",
            )}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="p-3 space-y-3">
        {/* order type */}
        <div>
          <label className="label" htmlFor="ot-type">Order type</label>
          <select
            id="ot-type" className="field" value={type}
            onChange={(e) => setType(e.target.value as OrderType)}
          >
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <p className="mt-1 text-[10.5px] text-[var(--color-text-faint)] leading-snug">
            {TYPES.find((t) => t.value === type)?.blurb}
          </p>
        </div>

        {/* quantity */}
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <label className="label mb-0" htmlFor="ot-qty">Quantity</label>
            <span className="text-[10.5px] text-[var(--color-text-faint)] num">
              max {qtyText(maxAffordable)}
            </span>
          </div>
          <input
            id="ot-qty" type="number" min="0" step={fractional ? "0.0001" : "1"}
            inputMode="decimal" className="field num" placeholder="0"
            value={qty} onChange={(e) => setQty(e.target.value)}
          />
          <div className="grid grid-cols-4 gap-1 mt-1.5">
            {[0.25, 0.5, 0.75, 1].map((f) => (
              <button
                key={f} type="button"
                onClick={() => {
                  const raw = maxAffordable * f;
                  setQty(String(fractional ? Math.floor(raw * 1e4) / 1e4 : Math.floor(raw)));
                }}
                className="py-1 rounded-md border border-[var(--color-border)] text-[10.5px] font-semibold text-[var(--color-text-faint)] hover:text-[var(--color-neon-bright)] hover:border-[var(--color-neon)] transition-colors"
              >
                {f === 1 ? "MAX" : `${f * 100}%`}
              </button>
            ))}
          </div>
        </div>

        {needsLimit && (
          <div>
            <label className="label" htmlFor="ot-limit">Limit price</label>
            <input
              id="ot-limit" type="number" min="0" step="0.01" inputMode="decimal"
              className="field num" placeholder={num(price)}
              value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)}
            />
          </div>
        )}

        {needsStop && (
          <div>
            <label className="label" htmlFor="ot-stop">Stop price</label>
            <input
              id="ot-stop" type="number" min="0" step="0.01" inputMode="decimal"
              className="field num"
              placeholder={num(side === "buy" ? price * 1.05 : price * 0.95)}
              value={stopPrice} onChange={(e) => setStopPrice(e.target.value)}
            />
          </div>
        )}

        {type === "trailing_stop" && (
          <div>
            <label className="label" htmlFor="ot-trail">Trail (%)</label>
            <input
              id="ot-trail" type="number" min="0.1" max="99" step="0.1" inputMode="decimal"
              className="field num" value={trailPercent}
              onChange={(e) => setTrailPercent(e.target.value)}
            />
            <p className="mt-1 text-[10.5px] text-[var(--color-text-faint)]">
              Triggers {side === "sell" ? "below" : "above"} the best price reached — currently{" "}
              <span className="num">
                {num(side === "sell"
                  ? price * (1 - Number(trailPercent) / 100)
                  : price * (1 + Number(trailPercent) / 100))}
              </span>
            </p>
          </div>
        )}

        <div>
          <label className="label" htmlFor="ot-tif">Time in force</label>
          <select
            id="ot-tif" className="field" value={tif}
            onChange={(e) => setTif(e.target.value as TimeInForce)}
          >
            <option value="day">Day — expires at the close</option>
            <option value="gtc">GTC — rests until filled or cancelled</option>
            <option value="ioc">IOC — fill now, else cancel</option>
            <option value="fok">FOK — fill in full now, else cancel</option>
          </select>
        </div>

        {/* cost preview */}
        <dl className="rounded-lg bg-[var(--color-bg-elev)] border border-[var(--color-border-soft)] p-3 space-y-1.5 text-xs">
          <div className="flex justify-between">
            <dt className="text-[var(--color-text-faint)]">Est. price</dt>
            <dd className="num">{refPrice > 0 ? money(refPrice) : "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--color-text-faint)]">Notional</dt>
            <dd className="num">{money(notional)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--color-text-faint)]">Commission</dt>
            <dd className="num text-[var(--color-text-dim)]">{money(commission)}</dd>
          </div>
          <div className="flex justify-between pt-1.5 border-t border-[var(--color-border-soft)]">
            <dt className="font-semibold">{side === "buy" ? "Est. cost" : "Est. proceeds"}</dt>
            <dd className={cn("num font-semibold",
              side === "buy" ? "text-[var(--color-down)]" : "text-[var(--color-up)]")}>
              {money(total)}
            </dd>
          </div>
          <div className="flex justify-between text-[10.5px] pt-0.5">
            <dt className="text-[var(--color-text-faint)]">
              {side === "buy" ? "Buying power" : `${symbol} available`}
            </dt>
            <dd className="num text-[var(--color-text-faint)]">
              {side === "buy" ? money(buyingPower) : qtyText(sellable)}
            </dd>
          </div>
        </dl>

        {marketClosed && (
          <p className="flex items-start gap-1.5 text-[10.5px] text-[var(--color-warn)]">
            <Info size={12} className="mt-px shrink-0" />
            The market is closed. Your order will queue and work at the next open.
          </p>
        )}

        {problem && qtyNum > 0 && (
          <p role="alert" className="flex items-start gap-1.5 text-[10.5px] text-[var(--color-down)]">
            <AlertTriangle size={12} className="mt-px shrink-0" />
            {problem}
          </p>
        )}

        <button
          onClick={submit} disabled={!canSubmit}
          className={cn("btn w-full", side === "buy" ? "btn-buy" : "btn-sell")}
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
          {busy ? "Submitting…"
            : `${side === "buy" ? "Buy" : "Sell"} ${qtyNum > 0 ? qtyText(qtyNum) : ""} ${symbol}`.trim()}
        </button>
      </div>
    </div>
  );
}
