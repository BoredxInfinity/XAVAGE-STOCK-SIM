import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SymbolView } from "@/components/views/symbol-view";

export async function generateMetadata({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  return { title: `${symbol.toUpperCase()} · Trade` };
}

export default async function SymbolPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const upper = decodeURIComponent(symbol).toUpperCase();

  const supabase = await createClient();
  const { data: instrument } = await supabase
    .from("instruments")
    .select("symbol, name, exchange, sector, industry, asset_type, is_tradable, is_halted, halt_reason")
    .eq("symbol", upper)
    .maybeSingle();

  if (!instrument) notFound();

  return <SymbolView instrument={instrument} />;
}
