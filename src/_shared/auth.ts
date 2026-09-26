export function isAuthorized(req: Request, secret: string | undefined): boolean {
  if (!secret) return true;
  return req.headers.get("x-telegram-bot-api-secret-token") === secret;
}
