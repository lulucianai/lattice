import { NextResponse } from "next/server";
import { updateWallet } from "@/lib/db";

// Write path for the watchlist star + custom name.
export async function POST(req: Request) {
  try {
    const { address, starred, customName } = (await req.json()) as {
      address?: string;
      starred?: boolean;
      customName?: string | null;
    };
    if (!address) return NextResponse.json({ error: "address required" }, { status: 400 });
    updateWallet(address, { starred, customName });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
