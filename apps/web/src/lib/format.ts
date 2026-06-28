export function credits(value: number) {
  return `${Math.round(value)} credits`;
}

export function inr(value: number) {
  return `₹${value}`;
}

export function shortDate(value?: string) {
  if (!value) {
    return "Now";
  }
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
