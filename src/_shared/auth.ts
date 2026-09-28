export function isAuthorized(req: Request, secret: string | undefined): boolean {
  // Fail closed: a missing secret means the deployment is misconfigured, not that anyone is
  // welcome. The bot's whole authorization model trusts `message.from.id` from the payload,
  // so an unauthenticated webhook would let anyone forge updates as any employee or admin.
  if (!secret) return false;
  return req.headers.get("x-telegram-bot-api-secret-token") === secret;
}
