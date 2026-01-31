import { NextResponse } from "next/server";
import { tokensExist } from "@/lib/antigravity/token-store";

export async function GET() {
  const hasTokens = await tokensExist();
  return NextResponse.json({ authenticated: hasTokens });
}
