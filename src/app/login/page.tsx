import { Suspense } from "react";
import { LoginForm } from "@/components/auth/login-form";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/shell/theme-toggle";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="min-h-dvh grid place-items-center px-4 py-10">
      {/* These pages render outside the app shell, so the toggle floats. */}
      <div className="fixed top-4 right-4 z-10">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-[400px]">
        <div className="flex flex-col items-center gap-3 mb-8">
          <Logo size={44} />
          <div className="text-center">
            <h1 className="text-2xl font-bold tracking-tight">
              <span className="neon-text">XAVAGE</span> Trading Floor
            </h1>
            <p className="text-sm text-[var(--color-text-dim)] mt-1">
              Sign in with the credentials issued by the organisers.
            </p>
          </div>
        </div>

        <div className="panel-glow p-6">
          <Suspense fallback={<div className="h-56 skeleton rounded-lg" />}>
            <LoginForm />
          </Suspense>
        </div>

        <p className="text-center text-xs text-[var(--color-text-faint)] mt-6">
          Trouble signing in? Find an organiser — accounts are issued and reset by the admin team.
        </p>
      </div>
    </main>
  );
}
