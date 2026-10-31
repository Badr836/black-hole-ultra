import { NextResponse } from "next/server";
import { analyzeUrl } from "@/lib/analyzer";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { url?: string; playlist?: boolean };
  try {
    body = (await req.json()) as { url?: string; playlist?: boolean };
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح" }, { status: 400 });
  }
  const url = (body.url ?? "").trim();
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return NextResponse.json(
      { error: "أدخل رابطاً صالحاً يبدأ بـ http:// أو https://" },
      { status: 400 },
    );
  }
  if (url.length > 2048) {
    return NextResponse.json({ error: "الرابط طويل جداً." }, { status: 400 });
  }
  try {
    const result = await analyzeUrl(url, Boolean(body.playlist));
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "فشل التحليل";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
