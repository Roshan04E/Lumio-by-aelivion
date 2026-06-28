import { Coins } from "lucide-react";
import { credits } from "../lib/format";

export function CreditBadge({ value }: { value: number }) {
  return (
    <span className="credit-badge">
      <Coins size={15} />
      {credits(value)}
    </span>
  );
}
