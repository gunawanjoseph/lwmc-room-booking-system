import { ConvexError } from "convex/values";

export const MAX_SUPPORT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_SUPPORT_ATTACHMENTS = 5;
export const SUPPORT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export function supportText(value: string, limit: number, required = true): string {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if ((required && !clean) || clean.length > limit) throw new ConvexError(`Enter ${required ? "1" : "0"}–${limit} characters.`);
  return clean;
}
export function validRequestId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(value)) throw new ConvexError("Invalid message request ID. Reload the composer.");
  return value;
}
export function imageContentType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)) return "image/png";
  if (bytes.length >= 3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return "image/jpeg";
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start,end));
  if (bytes.length >= 12 && ascii(0,4)==="RIFF" && ascii(8,12)==="WEBP") return "image/webp";
  if (bytes.length >= 6 && ["GIF87a","GIF89a"].includes(ascii(0,6))) return "image/gif";
  return null;
}
export function supportAttachmentName(name: string): string {
  return name.replace(/[\\/\u0000-\u001f\u007f]/g,"_").slice(0,160) || "screenshot";
}
