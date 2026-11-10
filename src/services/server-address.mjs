export function serverAddress(env = process.env) {
  const onRender = env.RENDER === "true";
  const port = Number(env.PORT || (onRender ? 10000 : 4000));
  // Render must reach the service through its container network, even if an old
  // local HOST setting was copied into the deployment environment.
  const host = onRender ? "0.0.0.0"
    : env.HOST || (env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be between 1 and 65535.");
  return { port, host };
}
