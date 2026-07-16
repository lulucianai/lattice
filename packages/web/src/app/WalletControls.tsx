"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

async function save(address: string, patch: { starred?: boolean; customName?: string | null }) {
  await fetch("/api/wallet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, ...patch }),
  });
}

/** Watchlist star — left of the rank. */
export function StarToggle({ address, starred }: { address: string; starred: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(starred);
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={`iconbtn star${on ? " on" : ""}`}
      title={on ? "Unwatch" : "Watchlist"}
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        const next = !on;
        await save(address, { starred: next });
        setOn(next);
        setBusy(false);
        router.refresh();
      }}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

/** Pen — right of the wallet, opens a name prompt. */
export function NameEditor({ address, name }: { address: string; name: string | null }) {
  const router = useRouter();
  return (
    <button
      className="iconbtn pen"
      title="Beri nama wallet"
      onClick={async (e) => {
        e.stopPropagation();
        const v = window.prompt("Nama wallet:", name ?? "");
        if (v === null) return; // cancelled
        await save(address, { customName: v });
        router.refresh();
      }}
    >
      ✎
    </button>
  );
}
