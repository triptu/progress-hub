/**
 * A model id as people say it: "claude-opus-5-5" is "Opus 5.5", "gpt-6.1-sol" is "GPT-6.1 Sol".
 * The vendor prefix "claude" goes, version numbers join with dots, and a date stamp is dropped.
 */
export function modelName(id: string): string {
  const parts = id.split("-").filter((part) => part !== "" && !/^\d{8}$/.test(part));
  if (parts[0] === "claude" && parts.length > 1) parts.shift();
  const words: string[] = [];
  for (const part of parts) {
    const last = words.at(-1);
    if (/^[\d.]+$/.test(part) && last !== undefined && /\d$/.test(last)) words[words.length - 1] = `${last}.${part}`;
    else if (/^[\d.]+$/.test(part) && last === "GPT") words[words.length - 1] = `GPT-${part}`;
    else words.push(part === "gpt" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1));
  }
  return words.join(" ") || id;
}
