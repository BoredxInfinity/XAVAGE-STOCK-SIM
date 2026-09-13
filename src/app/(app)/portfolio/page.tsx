import { redirect } from "next/navigation";

// Portfolio folded into the dashboard; keep the old path working for bookmarks.
export default function PortfolioPage() {
  redirect("/dashboard");
}
