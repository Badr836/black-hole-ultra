import { currentVersion, dbHealthy, resolveDatabaseFile, sqlite } from "@/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json({
      ok: dbHealthy(),
      db: { file: resolveDatabaseFile(), schemaVersion: currentVersion(sqlite) },
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "database unavailable" },
      { status: 500 },
    );
  }
}
