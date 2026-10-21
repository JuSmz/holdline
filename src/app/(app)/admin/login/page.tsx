import type { Metadata } from "next";

export const metadata: Metadata = { title: "Owner login", robots: { index: false, follow: false } };

export default async function AdminLoginPage({ searchParams }: PageProps<"/admin/login">) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : "/lab/paypal";
  const failed = params.error === "1";

  return (
    <div className="mx-auto max-w-sm px-6 py-20">
      <h1 className="text-2xl font-semibold tracking-tight">Owner login</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Enter the <code>ADMIN_TOKEN</code> from your environment. Sessions last 12 hours.
      </p>
      <form method="post" action="/api/admin/login" className="mt-8 space-y-4">
        <input type="hidden" name="next" value={next} />
        <label className="block text-sm font-medium" htmlFor="token">
          Admin token
        </label>
        <input
          id="token"
          name="token"
          type="password"
          autoComplete="current-password"
          required
          className="h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            That token didn&apos;t work.
          </p>
        ) : null}
        <button
          type="submit"
          className="h-10 w-full rounded-lg bg-foreground text-sm font-medium text-background hover:bg-foreground/85"
        >
          Log in
        </button>
      </form>
    </div>
  );
}
