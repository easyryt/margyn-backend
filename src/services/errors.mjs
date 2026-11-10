export class AppError extends Error {
  constructor(message, status = 400, retryAfter = 0) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
export function normalizePhone(value) {
  if (typeof value !== "string")
    throw new AppError("Enter a valid Indian mobile number.");
  let phone = value.replace(/[\s()-]/g, "");
  if (/^[6-9]\d{9}$/.test(phone)) phone = "+91" + phone;
  if (!/^\+91[6-9]\d{9}$/.test(phone))
    throw new AppError("Enter a valid 10-digit Indian mobile number.");
  return phone;
}
